/**
 * Salesforce OAuth 2.0 — Authorization Code + PKCE, parameterized.
 *
 * Modeled on services/cti-api/src/salesforce/oauth.ts (`buildStartArtifacts`,
 * `exchangeCodeForTokens`, `refreshAccessToken`), but every setting comes in
 * through `SalesforceOAuthConfig` (no process.env reads here) and HTTP goes
 * through an injectable `fetchImpl`.
 *
 * Errors: a 401, or a 400 whose body says `invalid_grant` (a revoked or
 * expired refresh token, a bad code or verifier), throws `SalesforceAuthError`
 * — the connection is unusable. Any other failure (another 400 such as a
 * config error, a 5xx, an unreadable body, a network error or timeout) throws
 * `SalesforceApiError` — it must not mark the connection broken.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SALESFORCE_REQUEST_TIMEOUT_MS } from './client.js';
import { SalesforceApiError, SalesforceAuthError } from './errors.js';

export interface SalesforceOAuthConfig {
  clientId: string;
  /** Optional with PKCE; sent when the connected app requires it. */
  clientSecret?: string;
  redirectUri: string;
  /** e.g. `https://login.salesforce.com`. */
  loginUrl: string;
}

const SCOPE = 'api refresh_token offline_access';
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

const TOKEN_RESPONSE = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  instance_url: z.string().url(),
  id: z.string().url(),
});

const REFRESH_RESPONSE = z.object({
  access_token: z.string().min(1),
  instance_url: z.string().url().optional(),
});

/** RFC 7636 S256 pair: a 32-byte base64url verifier and its SHA-256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  cfg: SalesforceOAuthConfig,
  args: { state: string; codeChallenge: string; scope?: string },
): string {
  const url = new URL('/services/oauth2/authorize', cfg.loginUrl);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
    scope: args.scope ?? SCOPE,
    prompt: 'login',
  }).toString();
  return url.toString();
}

export async function exchangeCode(
  cfg: SalesforceOAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string | null; instanceUrl: string; sfUserId: string; sfOrgId: string }> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  const json = await postToken(cfg, form, fetchImpl, 'token exchange');
  const parsed = TOKEN_RESPONSE.safeParse(json);
  // The body holds tokens: never attach it to an error.
  if (!parsed.success) throw new SalesforceApiError('Salesforce token exchange returned an unexpected body', 200, null);
  // `id` is https://login.salesforce.com/id/{orgId}/{userId}
  const parts = new URL(parsed.data.id).pathname.split('/').filter(Boolean);
  const sfUserId = parts[parts.length - 1] ?? '';
  const sfOrgId = parts[parts.length - 2] ?? '';
  if (!SF_ID.test(sfUserId) || !SF_ID.test(sfOrgId)) {
    throw new SalesforceApiError(`Salesforce identity URL has no org and user Id: ${parsed.data.id}`, 200, null);
  }
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    instanceUrl: parsed.data.instance_url,
    sfUserId,
    sfOrgId,
  };
}

export async function refreshAccessToken(
  cfg: SalesforceOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; instanceUrl: string | null }> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
  });
  if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  const json = await postToken(cfg, form, fetchImpl, 'token refresh');
  const parsed = REFRESH_RESPONSE.safeParse(json);
  if (!parsed.success) throw new SalesforceApiError('Salesforce token refresh returned an unexpected body', 200, null);
  return { accessToken: parsed.data.access_token, instanceUrl: parsed.data.instance_url ?? null };
}

/** Best-effort token revocation (RFC 7009 as Salesforce implements it). Never throws: a sign-in must not fail on it. */
/** Never throws: true when Salesforce accepted the revoke, false on any refusal or network failure (the caller decides what to log). */
export async function revokeToken(cfg: SalesforceOAuthConfig, token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(new URL('/services/oauth2/revoke', cfg.loginUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function postToken(
  cfg: SalesforceOAuthConfig,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
  what: string,
): Promise<unknown> {
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(new URL('/services/oauth2/token', cfg.loginUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: form.toString(),
      signal: AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const why = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    throw new SalesforceApiError(`Salesforce ${what} request failed: ${why}`, 0, null);
  }
  // Error bodies are {"error":"invalid_grant","error_description":"…"}: no secrets.
  if (res.status === 401 || (res.status === 400 && errorCode(text) === 'invalid_grant')) {
    throw new SalesforceAuthError(`Salesforce ${what} failed (${res.status}): ${text}`);
  }
  if (res.status >= 400) throw new SalesforceApiError(`Salesforce ${what} failed (${res.status}): ${text}`, res.status, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SalesforceApiError(`Salesforce ${what} returned a body that is not JSON`, res.status, null);
  }
}

function errorCode(text: string): string | null {
  try {
    const error = (JSON.parse(text) as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error : null;
  } catch {
    return null;
  }
}

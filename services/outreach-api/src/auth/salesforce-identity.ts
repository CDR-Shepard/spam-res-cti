/**
 * Sign-in with Salesforce: who is this person? Code + PKCE exchange, then the userinfo
 * endpoint, and the tokens are revoked and dropped. Nothing here touches the database.
 */
import { buildAuthorizeUrl, exchangeCode, revokeToken, SALESFORCE_REQUEST_TIMEOUT_MS, SalesforceAuthError, type SalesforceOAuthConfig } from '@cti/salesforce';
import { z } from 'zod';

/** The scope the CTI requests from the same External Client App; a sign-in must not ask for a set the app has not been tested with. The refresh token it yields is revoked at once. */
export const SIGN_IN_SCOPE = 'api refresh_token offline_access';
const USERINFO_DELAYS_MS = [0, 500, 1_500, 3_500];
const SF_ID_CORE = 15;

export interface SalesforceSignInConfig {
  clientId: string;
  redirectUri: string;
  loginUrl: string;
  allowedOrgId: string | null;
}
export interface SalesforceIdentity {
  sfOrgId: string;
  sfUserId: string;
  email: string | null;
  name: string | null;
}

export class SalesforceSignInError extends Error {
  constructor(readonly reason: 'invalid_code' | 'org_not_allowed' | 'salesforce_unavailable') {
    super(`Salesforce sign-in failed: ${reason}`);
    this.name = 'SalesforceSignInError';
  }
}

const UserInfo = z.object({
  user_id: z.string().optional(),
  organization_id: z.string().optional(),
  email: z.string().nullish(),
  name: z.string().nullish(),
});
const core = (id: string): string => id.slice(0, SF_ID_CORE);
const oauthCfg = (cfg: SalesforceSignInConfig): SalesforceOAuthConfig => ({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, loginUrl: cfg.loginUrl });

export function salesforceSignInUrl(cfg: SalesforceSignInConfig, args: { state: string; codeChallenge: string }): string {
  return buildAuthorizeUrl(oauthCfg(cfg), { ...args, scope: SIGN_IN_SCOPE });
}

/** A new session's userinfo is not always readable at once, so the read is retried with backoff (as cti-api does). */
async function readUserInfo(accessToken: string, instanceUrl: string, fetchImpl: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<z.infer<typeof UserInfo>> {
  for (const delay of USERINFO_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      const res = await fetchImpl(new URL('/services/oauth2/userinfo', instanceUrl).toString(), { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: AbortSignal.timeout(SALESFORCE_REQUEST_TIMEOUT_MS) });
      if (res.status === 200) {
        const parsed = UserInfo.safeParse(await res.json());
        if (parsed.success) return parsed.data;
      }
    } catch {
      // retried below
    }
  }
  throw new SalesforceSignInError('salesforce_unavailable');
}

export async function readSalesforceIdentity(
  cfg: SalesforceSignInConfig,
  code: string,
  verifier: string,
  deps: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SalesforceIdentity> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let tok: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tok = await exchangeCode(oauthCfg(cfg), code, verifier, fetchImpl);
  } catch (err) {
    throw new SalesforceSignInError(err instanceof SalesforceAuthError ? 'invalid_code' : 'salesforce_unavailable');
  }
  try {
    if (cfg.allowedOrgId && core(tok.sfOrgId) !== core(cfg.allowedOrgId)) throw new SalesforceSignInError('org_not_allowed');
    const info = await readUserInfo(tok.accessToken, tok.instanceUrl, fetchImpl, sleep);
    if ((info.organization_id && core(info.organization_id) !== core(tok.sfOrgId)) || (info.user_id && core(info.user_id) !== core(tok.sfUserId))) {
      throw new SalesforceSignInError('salesforce_unavailable');
    }
    const email = info.email?.trim().toLowerCase() || null;
    return { sfOrgId: tok.sfOrgId, sfUserId: tok.sfUserId, email, name: info.name?.trim() || null };
  } finally {
    // Sign-in only: the tokens are never stored, and are revoked so they cannot outlive this request.
    await revokeToken(oauthCfg(cfg), tok.refreshToken ?? tok.accessToken, fetchImpl);
  }
}

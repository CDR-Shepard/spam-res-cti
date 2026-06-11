/**
 * Salesforce OAuth 2.0 — Authorization Code + PKCE flow.
 *
 * Flow:
 *   1. Desktop calls POST /auth/salesforce/start (with bearer session).
 *      Backend generates `state`, PKCE verifier, and a `handshake` token.
 *      Returns { authUrl, handshake }.
 *   2. Desktop opens system browser to authUrl.
 *   3. User logs in. Salesforce redirects to {API_PUBLIC_URL}/auth/salesforce/callback?code=…&state=…
 *   4. Backend exchanges code+verifier for tokens, encrypts and persists.
 *   5. Desktop polls GET /auth/salesforce/status?handshake=…
 */
import { request } from 'undici';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { pkceVerifier, pkceChallenge, randomToken } from '../crypto.js';

const TOKEN_RESPONSE = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  instance_url: z.string().url(),
  id: z.string().url(),
  token_type: z.string(),
  issued_at: z.string().optional(),
  signature: z.string().optional(),
  scope: z.string().optional(),
});

export type SalesforceTokenResponse = z.infer<typeof TOKEN_RESPONSE> & {
  sfUserId: string;
  sfOrgId: string;
};

export interface OAuthStartArtifacts {
  state: string;
  verifier: string;
  challenge: string;
  authUrl: string;
  handshake: string;
}

export function buildStartArtifacts(): OAuthStartArtifacts {
  const cfg = loadConfig();
  if (!cfg.SALESFORCE_CLIENT_ID || !cfg.SALESFORCE_REDIRECT_URI) {
    throw new Error('Salesforce Connected App is not configured');
  }
  const state = randomToken(24);
  const verifier = pkceVerifier();
  const challenge = pkceChallenge(verifier);
  const handshake = randomToken(24);
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.SALESFORCE_CLIENT_ID,
    redirect_uri: cfg.SALESFORCE_REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'api refresh_token offline_access',
    prompt: 'login',
  });
  const authUrl = `${cfg.SALESFORCE_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
  return { state, verifier, challenge, authUrl, handshake };
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<SalesforceTokenResponse> {
  const cfg = loadConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: cfg.SALESFORCE_CLIENT_ID ?? '',
    redirect_uri: cfg.SALESFORCE_REDIRECT_URI ?? '',
    code_verifier: verifier,
  });
  // client_secret is optional with PKCE but Salesforce honors it when "Require Secret for Web Server Flow" is on.
  if (cfg.SALESFORCE_CLIENT_SECRET) body.set('client_secret', cfg.SALESFORCE_CLIENT_SECRET);

  const url = `${cfg.SALESFORCE_LOGIN_URL}/services/oauth2/token`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`Salesforce token exchange failed (${res.statusCode}): ${text}`);
  }
  const parsed = TOKEN_RESPONSE.parse(JSON.parse(text));
  // id field is .../id/{orgId}/{userId}
  const parts = new URL(parsed.id).pathname.split('/').filter(Boolean);
  const sfUserId = parts[parts.length - 1] ?? '';
  const sfOrgId = parts[parts.length - 2] ?? '';
  return { ...parsed, sfUserId, sfOrgId };
}

/**
 * Fetches the connected user's profile from /services/oauth2/userinfo.
 * Includes name, email and `picture` (URL behind an auth wall).
 */
export interface SalesforceUserInfo {
  sub: string;
  name?: string;
  preferred_username?: string;
  email?: string;
  picture?: string;
  user_id?: string;
  organization_id?: string;
}
export async function fetchUserInfo(
  accessToken: string,
  instanceUrl: string,
): Promise<SalesforceUserInfo> {
  const url = new URL('/services/oauth2/userinfo', instanceUrl).toString();
  const res = await request(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) throw new Error(`userinfo failed (${res.statusCode}): ${text}`);
  return JSON.parse(text) as SalesforceUserInfo;
}

/**
 * Fetches the SF profile picture and returns the raw bytes + content type.
 * SF's picture URLs require the same Bearer token.
 */
export async function fetchProfilePhoto(
  url: string,
  accessToken: string,
): Promise<{ contentType: string; base64: string } | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
      // SF profile pictures sit on content.force.com and redirect a couple times.
      maxRedirections: 5,
    });
    if (res.statusCode >= 400) return null;
    const contentType = (res.headers['content-type'] as string | undefined) ?? 'image/png';
    const buf = Buffer.from(await res.body.arrayBuffer());
    // Skip absurdly large photos (>1 MB) — header avatars are tiny.
    if (buf.byteLength > 1024 * 1024) return null;
    return { contentType, base64: buf.toString('base64') };
  } catch {
    return null;
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  instance_url?: string;
  scope?: string;
}> {
  const cfg = loadConfig();
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.SALESFORCE_CLIENT_ID ?? '',
  });
  if (cfg.SALESFORCE_CLIENT_SECRET) body.set('client_secret', cfg.SALESFORCE_CLIENT_SECRET);
  const url = `${cfg.SALESFORCE_LOGIN_URL}/services/oauth2/token`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.body.text();
  if (res.statusCode >= 400) {
    throw new Error(`Salesforce token refresh failed (${res.statusCode}): ${text}`);
  }
  return JSON.parse(text);
}

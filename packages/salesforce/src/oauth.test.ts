import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SalesforceApiError, SalesforceAuthError } from './errors.js';
import { fakeFetch } from './fake-fetch.js';
import { buildAuthorizeUrl, exchangeCode, pkcePair, refreshAccessToken, type SalesforceOAuthConfig } from './oauth.js';

const CFG: SalesforceOAuthConfig = {
  clientId: 'client-id',
  redirectUri: 'https://outreach.example.com/api/connections/salesforce/callback',
  loginUrl: 'https://login.salesforce.com',
};

const TOKEN_OK = {
  access_token: 'access-1',
  refresh_token: 'refresh-1',
  instance_url: 'https://gg.my.salesforce.com',
  id: 'https://login.salesforce.com/id/00D5e000000AbCdEAK/0055e000001XyZaAAK',
  token_type: 'Bearer',
  issued_at: '1700000000000',
};

const form = (body: string | undefined) => Object.fromEntries(new URLSearchParams(body ?? ''));

describe('pkcePair', () => {
  it('returns a base64url verifier and its S256 challenge', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('is random', () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the authorize URL with PKCE, the refresh scopes, and prompt=login', () => {
    const url = new URL(buildAuthorizeUrl(CFG, { state: 'st-1', codeChallenge: 'ch-1' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://login.salesforce.com/services/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-id',
      redirect_uri: CFG.redirectUri,
      state: 'st-1',
      code_challenge: 'ch-1',
      code_challenge_method: 'S256',
      scope: 'api refresh_token offline_access',
      prompt: 'login',
    });
  });

  it('accepts a login URL with a trailing slash', () => {
    const url = new URL(buildAuthorizeUrl({ ...CFG, loginUrl: 'https://test.salesforce.com/' }, { state: 's', codeChallenge: 'c' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://test.salesforce.com/services/oauth2/authorize');
  });
});

describe('exchangeCode', () => {
  it('posts the code and verifier and parses sfOrgId/sfUserId from the id URL', async () => {
    const http = fakeFetch([{ status: 200, body: TOKEN_OK }]);
    const got = await exchangeCode(CFG, 'code-1', 'verifier-1', http.impl);
    expect(got).toEqual({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      instanceUrl: 'https://gg.my.salesforce.com',
      sfOrgId: '00D5e000000AbCdEAK',
      sfUserId: '0055e000001XyZaAAK',
    });
    expect(http.calls[0]!.url).toBe('https://login.salesforce.com/services/oauth2/token');
    expect(http.calls[0]!.method).toBe('POST');
    expect(http.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(form(http.calls[0]!.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      client_id: 'client-id',
      redirect_uri: CFG.redirectUri,
      code_verifier: 'verifier-1',
    });
  });

  it('sends client_secret only when configured', async () => {
    const http = fakeFetch([{ status: 200, body: TOKEN_OK }]);
    await exchangeCode({ ...CFG, clientSecret: 'shh' }, 'code-1', 'verifier-1', http.impl);
    expect(form(http.calls[0]!.body).client_secret).toBe('shh');
  });

  it('a missing refresh_token becomes null', async () => {
    const { refresh_token: _omit, ...noRefresh } = TOKEN_OK;
    const http = fakeFetch([{ status: 200, body: noRefresh }]);
    expect((await exchangeCode(CFG, 'c', 'v', http.impl)).refreshToken).toBeNull();
  });

  it('a 400 (bad code or verifier) throws SalesforceAuthError', async () => {
    const http = fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'authentication failure' } }]);
    await expect(exchangeCode(CFG, 'c', 'v', http.impl)).rejects.toBeInstanceOf(SalesforceAuthError);
  });

  it('a 400 that is not invalid_grant (a config error) throws SalesforceApiError, not an auth error', async () => {
    for (const error of ['invalid_client_id', 'redirect_uri_mismatch', 'invalid_request', 'unsupported_grant_type']) {
      const http = fakeFetch([{ status: 400, body: { error, error_description: 'x' } }]);
      const err = await exchangeCode(CFG, 'c', 'v', http.impl).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SalesforceApiError);
      expect(err).not.toBeInstanceOf(SalesforceAuthError);
    }
  });

  it('a 400 with an unreadable body throws SalesforceApiError', async () => {
    const http = fakeFetch([{ status: 400, text: '<html>nope</html>' }]);
    await expect(exchangeCode(CFG, 'c', 'v', http.impl)).rejects.toBeInstanceOf(SalesforceApiError);
  });

  it('a 401 from the token endpoint still throws SalesforceAuthError', async () => {
    const http = fakeFetch([{ status: 401, text: 'nope' }]);
    await expect(refreshAccessToken(CFG, 'r', http.impl)).rejects.toBeInstanceOf(SalesforceAuthError);
  });

  it('a refresh 400 that is not invalid_grant throws SalesforceApiError', async () => {
    const http = fakeFetch([{ status: 400, body: { error: 'invalid_client_id' } }]);
    const err = await refreshAccessToken(CFG, 'r', http.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).not.toBeInstanceOf(SalesforceAuthError);
  });

  it('sends an abort signal on every token POST and wraps a rejected fetch as SalesforceApiError', async () => {
    let seen: AbortSignal | null | undefined;
    const hanging = (async (_url: unknown, init?: RequestInit) => {
      seen = init?.signal;
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await refreshAccessToken(CFG, 'r', hanging).catch((e: unknown) => e);
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('a 5xx throws SalesforceApiError', async () => {
    const http = fakeFetch([{ status: 503, text: 'unavailable' }]);
    await expect(exchangeCode(CFG, 'c', 'v', http.impl)).rejects.toBeInstanceOf(SalesforceApiError);
  });

  it('an id URL without org and user Ids throws SalesforceApiError', async () => {
    const http = fakeFetch([{ status: 200, body: { ...TOKEN_OK, id: 'https://login.salesforce.com/id/' } }]);
    await expect(exchangeCode(CFG, 'c', 'v', http.impl)).rejects.toBeInstanceOf(SalesforceApiError);
  });

  it('an unexpected body throws SalesforceApiError without echoing it', async () => {
    const http = fakeFetch([{ status: 200, body: { access_token: 'secret-token' } }]);
    const err = await exchangeCode(CFG, 'c', 'v', http.impl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(String((err as Error).message)).not.toContain('secret-token');
    expect((err as SalesforceApiError).body).toBeNull();
  });
});

describe('refreshAccessToken', () => {
  it('posts grant_type=refresh_token and returns the new token and instance URL', async () => {
    const http = fakeFetch([{ status: 200, body: { access_token: 'access-2', instance_url: 'https://gg.my.salesforce.com' } }]);
    expect(await refreshAccessToken(CFG, 'refresh-1', http.impl)).toEqual({
      accessToken: 'access-2',
      instanceUrl: 'https://gg.my.salesforce.com',
    });
    expect(form(http.calls[0]!.body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-id' });
  });

  it('instanceUrl is null when Salesforce omits it', async () => {
    const http = fakeFetch([{ status: 200, body: { access_token: 'access-2' } }]);
    expect((await refreshAccessToken(CFG, 'r', http.impl)).instanceUrl).toBeNull();
  });

  it('a revoked refresh token (400 invalid_grant) throws SalesforceAuthError', async () => {
    const http = fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'expired access/refresh token' } }]);
    await expect(refreshAccessToken(CFG, 'r', http.impl)).rejects.toBeInstanceOf(SalesforceAuthError);
  });

  it('a 5xx throws SalesforceApiError (transient, not a broken connection)', async () => {
    const http = fakeFetch([{ status: 503, text: 'unavailable' }]);
    await expect(refreshAccessToken(CFG, 'r', http.impl)).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

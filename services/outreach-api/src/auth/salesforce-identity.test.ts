import { describe, expect, it } from 'vitest';
import { FAKE_SF_ORG_ID, FAKE_SF_USER_ID, fakeSalesforceLogin, type FakeSalesforceLoginCall } from '../test/fake-salesforce-login.js';
import { readSalesforceIdentity, salesforceSignInUrl, SalesforceSignInError, SIGN_IN_SCOPE, type SalesforceSignInConfig } from './salesforce-identity.js';

const REDIRECT = 'https://api.example.com/api/auth/salesforce/callback';
const CFG: SalesforceSignInConfig = { clientId: 'cid', redirectUri: REDIRECT, loginUrl: 'https://login.salesforce.com', allowedOrgId: null };

const form = (body: string) => Object.fromEntries(new URLSearchParams(body));
const path = (c: FakeSalesforceLoginCall) => new URL(c.url).pathname;
const revoked = (calls: FakeSalesforceLoginCall[]) => calls.filter((c) => path(c) === '/services/oauth2/revoke').map((c) => form(c.body).token);
const userinfoReads = (calls: FakeSalesforceLoginCall[]) => calls.filter((c) => path(c) === '/services/oauth2/userinfo').length;

function setup(opts: Parameters<typeof fakeSalesforceLogin>[0] = {}, cfg: SalesforceSignInConfig = CFG) {
  const fake = fakeSalesforceLogin(opts);
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  const read = () => readSalesforceIdentity(cfg, 'CODE-xyz', 'VERIFIER-abc', { fetchImpl: fake.fetchImpl, sleep });
  return { ...fake, delays, read };
}

describe('salesforceSignInUrl', () => {
  it('asks for the sign-in scope with PKCE and the sign-in redirect', () => {
    const url = new URL(salesforceSignInUrl(CFG, { state: 'S', codeChallenge: 'CH' }));
    expect(url.pathname).toBe('/services/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe(SIGN_IN_SCOPE);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge')).toBe('CH');
    expect(url.searchParams.get('state')).toBe('S');
  });
});

describe('readSalesforceIdentity', () => {
  it('1: exchanges the code with PKCE and no client secret, and returns the identity', async () => {
    const t = setup();
    expect(await t.read()).toEqual({ sfOrgId: FAKE_SF_ORG_ID, sfUserId: FAKE_SF_USER_ID, email: 'rep@gg.com', name: 'Rae Rep' });
    const token = form(t.calls.find((c) => path(c) === '/services/oauth2/token')!.body);
    expect(token).toEqual({ grant_type: 'authorization_code', code: 'CODE-xyz', client_id: 'cid', redirect_uri: REDIRECT, code_verifier: 'VERIFIER-abc' });
    expect(token).not.toHaveProperty('client_secret');
  });

  it('2: revokes the refresh token, or the access token when there is none, and also when userinfo fails', async () => {
    const ok = setup();
    await ok.read();
    expect(revoked(ok.calls)).toEqual(['RT']);

    const noRefresh = setup({ noRefreshToken: true });
    await noRefresh.read();
    expect(revoked(noRefresh.calls)).toEqual(['AT']);

    const failing = setup({ userinfoFailures: 9 });
    await expect(failing.read()).rejects.toBeInstanceOf(SalesforceSignInError);
    expect(revoked(failing.calls)).toEqual(['RT']);
  });

  it('3: lower-cases and trims the email, and an empty or null email becomes null', async () => {
    expect((await setup({ email: '  Rep@GG.com ' }).read()).email).toBe('rep@gg.com');
    expect((await setup({ email: '' }).read()).email).toBeNull();
    expect((await setup({ email: '   ' }).read()).email).toBeNull();
    expect((await setup({ email: null }).read()).email).toBeNull();
  });

  it('4: retries userinfo, succeeding on the third read after two 401s', async () => {
    const t = setup({ userinfoFailures: 2 });
    expect((await t.read()).email).toBe('rep@gg.com');
    expect(userinfoReads(t.calls)).toBe(3);
    expect(t.delays).toEqual([500, 1_500]);
  });

  it('5: gives up with salesforce_unavailable when userinfo fails four times', async () => {
    const t = setup({ userinfoFailures: 4 });
    await expect(t.read()).rejects.toMatchObject({ name: 'SalesforceSignInError', reason: 'salesforce_unavailable' });
    expect(userinfoReads(t.calls)).toBe(4);
    expect(t.delays).toEqual([500, 1_500, 3_500]);
  });

  it('6: a 400 invalid_grant is invalid_code, and a token 500 is salesforce_unavailable', async () => {
    await expect(setup({ tokenStatus: 400 }).read()).rejects.toMatchObject({ reason: 'invalid_code' });
    await expect(setup({ tokenStatus: 500 }).read()).rejects.toMatchObject({ reason: 'salesforce_unavailable' });
  });

  it('6b: a network failure on the token call is salesforce_unavailable', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(readSalesforceIdentity(CFG, 'c', 'v', { fetchImpl: down, sleep: async () => {} })).rejects.toMatchObject({ reason: 'salesforce_unavailable' });
  });

  it('7: another allowed org is refused before userinfo is read, with the token still revoked; the 15-character form of the same org passes', async () => {
    const other = setup({}, { ...CFG, allowedOrgId: '00D000000000001AAA' });
    await expect(other.read()).rejects.toMatchObject({ reason: 'org_not_allowed' });
    expect(userinfoReads(other.calls)).toBe(0);
    expect(revoked(other.calls)).toEqual(['RT']);

    const same15 = setup({}, { ...CFG, allowedOrgId: FAKE_SF_ORG_ID.slice(0, 15) });
    expect((await same15.read()).sfOrgId).toBe(FAKE_SF_ORG_ID);
    const same18 = setup({}, { ...CFG, allowedOrgId: FAKE_SF_ORG_ID });
    expect((await same18.read()).sfOrgId).toBe(FAKE_SF_ORG_ID);
  });

  it('8: a userinfo that disagrees with the id URL on the org or the user is never used', async () => {
    await expect(setup({ userinfoOrgId: '00D000000000001AAA' }).read()).rejects.toMatchObject({ reason: 'salesforce_unavailable' });
    await expect(setup({ userinfoUserId: '005000000000001AAA' }).read()).rejects.toMatchObject({ reason: 'salesforce_unavailable' });
  });

  it('8b: the 15-character form of the same org or user in userinfo is consistent', async () => {
    const t = setup({ userinfoOrgId: FAKE_SF_ORG_ID.slice(0, 15), userinfoUserId: FAKE_SF_USER_ID.slice(0, 15) });
    expect((await t.read()).sfUserId).toBe(FAKE_SF_USER_ID);
  });

  it('9: no thrown value carries the tokens or the code', async () => {
    const scenarios = [{ tokenStatus: 400 }, { tokenStatus: 500 }, { userinfoFailures: 9 }, { userinfoOrgId: '00D000000000001AAA' }];
    for (const opts of scenarios) {
      const err = await setup(opts).read().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SalesforceSignInError);
      const dump = `${String(err)} ${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`;
      expect(dump).not.toMatch(/\bAT\b|\bRT\b/);
      expect(dump).not.toContain('CODE-xyz');
      expect(dump).not.toContain('VERIFIER-abc');
    }
    const allowed = await setup({}, { ...CFG, allowedOrgId: '00D000000000001AAA' }).read().catch((e: unknown) => e);
    expect(String(allowed)).not.toMatch(/\bAT\b|\bRT\b|CODE-xyz/);
  });
});

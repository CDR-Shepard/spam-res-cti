import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ServiceUserSessionError, SuspendedTenantError } from '@cti/auth';
import { signState } from '../auth/state.js';
import type { SalesforceSignInConfig } from '../auth/salesforce-identity.js';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { fakeSalesforceLogin, FAKE_SF_ORG_ID, FAKE_SF_USER_ID } from '../test/fake-salesforce-login.js';
import { registerAuthRoutes } from './auth.js';
import { registerSalesforceAuthRoutes, SF_SIGNIN_COOKIE } from './auth-salesforce.js';

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  issued: [] as string[],
  issueError: null as Error | null,
  match: null as unknown,
  matched: [] as unknown[],
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  issueSession: async (userId: string) => {
    if (state.issueError) throw state.issueError;
    state.issued.push(userId);
    return { token: `tok-${userId}`, expiresAt: new Date('2026-10-04T00:00:00Z') };
  },
  resolveSession: async () => state.session,
}));
vi.mock('../auth/salesforce-user.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/salesforce-user.js')>()),
  matchSalesforceUser: async (_db: unknown, identity: unknown) => {
    state.matched.push(identity);
    return state.match;
  },
}));

const SIGNIN_REDIRECT = 'http://api.test/api/auth/salesforce/callback';
const SF_ENV = { SALESFORCE_CLIENT_ID: 'cid', SALESFORCE_SIGNIN_REDIRECT_URI: SIGNIN_REDIRECT };
const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const humanSession = { userId: 'U1', orgId: 'O1', email: 'rep@gg.com', isAdmin: false, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };

type Cfg = ReturnType<typeof testConfig>;
const signInFrom = (cfg: Cfg): SalesforceSignInConfig | null =>
  cfg.salesforceSignInEnabled
    ? { clientId: cfg.SALESFORCE_CLIENT_ID!, redirectUri: cfg.SALESFORCE_SIGNIN_REDIRECT_URI!, loginUrl: cfg.SALESFORCE_LOGIN_URL, allowedOrgId: cfg.SALESFORCE_ALLOWED_ORG_ID ?? null }
    : null;

let app: FastifyInstance;
let fixture: ReturnType<typeof fakeDb>;
let login: ReturnType<typeof fakeSalesforceLogin>;

async function boot(cfg: Cfg, loginOpts: Parameters<typeof fakeSalesforceLogin>[0] = {}): Promise<void> {
  await app?.close();
  fixture = fakeDb({ organizations: [tenant], users: [{ displayName: 'Rae Rep' }] });
  login = fakeSalesforceLogin(loginOpts);
  app = await buildApp({
    cfg,
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [
      (scope) => registerAuthRoutes(scope, { cfg, db: fixture.db, idp: null }),
      (scope) => registerSalesforceAuthRoutes(scope, { cfg, db: fixture.db, signIn: signInFrom(cfg), fetchImpl: login.fetchImpl, sleep: async () => {} }),
    ],
  });
}

beforeEach(async () => {
  state.session = null;
  state.issued = [];
  state.issueError = null;
  state.matched = [];
  state.match = { ok: true, userId: 'U1', orgId: 'O1' };
  await boot(testConfig(SF_ENV));
});
afterEach(async () => {
  await app.close();
});

/** Start a sign-in and return what the browser would hold: the state, the challenge and the signed cookie value. */
async function start(returnTo?: string) {
  const res = await app.inject({ method: 'GET', url: `/api/auth/salesforce/start${returnTo ? `?returnTo=${encodeURIComponent(returnTo)}` : ''}` });
  const url = new URL(res.headers.location as string);
  const cookie = res.cookies.find((c) => c.name === SF_SIGNIN_COOKIE);
  return { res, url, state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')!, cookie: cookie?.value ?? '' };
}
const callback = (qs: string, cookie?: string) =>
  app.inject({ method: 'GET', url: `/api/auth/salesforce/callback?${qs}`, cookies: cookie ? { [SF_SIGNIN_COOKIE]: cookie } : undefined });
const clearsCookie = (res: Awaited<ReturnType<typeof callback>>) => res.cookies.find((c) => c.name === SF_SIGNIN_COOKIE);

describe('GET /api/auth/salesforce/start', () => {
  it('1: redirects to Salesforce with PKCE, the signed state and prompt=login, and sets the signed sign-in cookie', async () => {
    const { res, url, state: st, challenge } = await start();
    expect(res.statusCode).toBe(302);
    expect(`${url.origin}${url.pathname}`).toBe('https://login.salesforce.com/services/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe(SIGNIN_REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(st).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(res.cookies.find((c) => c.name === SF_SIGNIN_COOKIE)).toMatchObject({ httpOnly: true, path: '/api/auth/salesforce/callback', maxAge: 600, sameSite: 'Lax' });
  });

  it('2: an unsafe returnTo goes back to sign-in as bad_return_to, with no cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/salesforce/start?returnTo=//evil.com' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/sign-in?error=bad_return_to');
    expect(res.cookies.find((c) => c.name === SF_SIGNIN_COOKIE)).toBeUndefined();
  });

  it('8: is sign_in_disabled when sign-in is not configured', async () => {
    await boot(testConfig());
    const res = await app.inject({ method: 'GET', url: '/api/auth/salesforce/start' });
    expect(res.headers.location).toBe('http://app.test/sign-in?error=sign_in_disabled');
    expect(res.cookies.find((c) => c.name === SF_SIGNIN_COOKIE)).toBeUndefined();
  });
});

describe('GET /api/auth/salesforce/callback', () => {
  it('3: a full round trip proves the verifier, matches the identity, hands the session over and stores no Salesforce token', async () => {
    const s = await start('/campaigns');
    const res = await callback(`code=C&state=${s.state}`, s.cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/auth/callback?returnTo=%2Fcampaigns');

    const tokenCall = login.calls.find((c) => new URL(c.url).pathname === '/services/oauth2/token')!;
    const form = Object.fromEntries(new URLSearchParams(tokenCall.body));
    expect(form).toMatchObject({ grant_type: 'authorization_code', code: 'C', client_id: 'cid', redirect_uri: SIGNIN_REDIRECT });
    expect(createHash('sha256').update(form.code_verifier!).digest('base64url')).toBe(s.challenge);
    expect(form).not.toHaveProperty('client_secret');

    expect(state.matched).toEqual([{ sfOrgId: FAKE_SF_ORG_ID, sfUserId: FAKE_SF_USER_ID, email: 'rep@gg.com', name: 'Rae Rep' }]);
    expect(state.issued).toEqual(['U1']);
    const handoff = res.cookies.find((c) => c.name === 'outreach_session_handoff');
    expect(handoff).toMatchObject({ httpOnly: true, path: '/api/auth/session', maxAge: 60, sameSite: 'Lax' });

    state.session = humanSession;
    const session = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: handoff!.value } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ token: 'tok-U1', user: { userId: 'U1', email: 'rep@gg.com' }, tenant: { slug: 'gg-homes' } });

    const revokes = login.calls.filter((c) => new URL(c.url).pathname === '/services/oauth2/revoke');
    expect(revokes.map((c) => new URLSearchParams(c.body).get('token'))).toEqual(['RT']);
    expect(fixture.writes).toEqual([]);
    expect(fixture.upserts).toEqual([]);
    expect(JSON.stringify([fixture.writes, fixture.upserts])).not.toMatch(/"(AT|RT)"/);
  });

  it('4: a missing, foreign or tampered sign-in cookie is bad_state', async () => {
    const a = await start();
    const b = await start();
    const tampered = a.cookie.slice(0, -1) + (a.cookie.at(-1) === '0' ? '1' : '0');
    for (const [name, cookie] of [['missing', undefined], ['another start (different nonce)', b.cookie], ['tampered', tampered]] as const) {
      const res = await callback(`code=C&state=${a.state}`, cookie);
      expect(res.headers.location, name).toBe('http://app.test/sign-in?error=bad_state');
    }
    expect(state.issued).toEqual([]);
    expect(login.calls).toEqual([]);
  });

  it('4b: an invalid, expired or missing state is bad_state', async () => {
    const a = await start();
    const { state: expired } = signState(testConfig(SF_ENV).SESSION_SECRET, {}, Date.now() - 601_000);
    for (const qs of ['code=C', 'code=C&state=nope', `code=C&state=${expired}`]) {
      expect((await callback(qs, a.cookie)).headers.location, qs).toBe('http://app.test/sign-in?error=bad_state');
    }
  });

  it('4c: a nonce mismatch keeps the verified returnTo', async () => {
    const a = await start('/team');
    const b = await start();
    expect((await callback(`code=C&state=${a.state}`, b.cookie)).headers.location).toBe('http://app.test/sign-in?error=bad_state&returnTo=%2Fteam');
  });

  it('5: error=access_denied goes back to sign-in as access_denied; another error or no code is missing_code', async () => {
    const s = await start();
    expect((await callback(`error=access_denied&state=${s.state}`, s.cookie)).headers.location).toBe('http://app.test/sign-in?error=access_denied');
    expect((await callback(`error=invalid_request&state=${s.state}`, s.cookie)).headers.location).toBe('http://app.test/sign-in?error=missing_code');
    expect((await callback(`state=${s.state}`, s.cookie)).headers.location).toBe('http://app.test/sign-in?error=missing_code');
    expect(login.calls).toEqual([]);
  });

  it('6: another Salesforce org than SALESFORCE_ALLOWED_ORG_ID is org_not_allowed, with the token revoked and no match attempted', async () => {
    await boot(testConfig({ ...SF_ENV, SALESFORCE_ALLOWED_ORG_ID: '00D000000000001AAA' }));
    const s = await start();
    expect((await callback(`code=C&state=${s.state}`, s.cookie)).headers.location).toBe('http://app.test/sign-in?error=org_not_allowed');
    expect(login.calls.some((c) => new URL(c.url).pathname === '/services/oauth2/revoke')).toBe(true);
    expect(state.matched).toEqual([]);
    expect(state.issued).toEqual([]);
  });

  it('6b: Salesforce rejecting the code is invalid_code, and Salesforce being down is salesforce_unavailable', async () => {
    await boot(testConfig(SF_ENV), { tokenStatus: 400 });
    let s = await start();
    expect((await callback(`code=C&state=${s.state}`, s.cookie)).headers.location).toBe('http://app.test/sign-in?error=invalid_code');
    await boot(testConfig(SF_ENV), { tokenStatus: 500 });
    s = await start();
    expect((await callback(`code=C&state=${s.state}`, s.cookie)).headers.location).toBe('http://app.test/sign-in?error=salesforce_unavailable');
  });

  it('7: the match refusals no_account, no_tenant and tenant_suspended are passed through, and no session is issued', async () => {
    for (const reason of ['no_account', 'no_tenant', 'tenant_suspended']) {
      state.match = { ok: false, reason };
      const s = await start();
      expect((await callback(`code=C&state=${s.state}`, s.cookie)).headers.location, reason).toBe(`http://app.test/sign-in?error=${reason}`);
    }
    expect(state.issued).toEqual([]);
  });

  it('7b: a suspended tenant or a service user at session time is tenant_suspended or forbidden; anything else is server_error', async () => {
    const cases: Array<[Error, string]> = [
      [new SuspendedTenantError('O1'), 'tenant_suspended'],
      [new ServiceUserSessionError('U1'), 'forbidden'],
      [new Error('boom: secret detail'), 'server_error'],
    ];
    for (const [err, reason] of cases) {
      state.issueError = err;
      const s = await start();
      const res = await callback(`code=C&state=${s.state}`, s.cookie);
      expect(res.headers.location, reason).toBe(`http://app.test/sign-in?error=${reason}`);
      expect(res.cookies.find((c) => c.name === 'outreach_session_handoff')).toBeUndefined();
    }
  });

  it('8: is sign_in_disabled when sign-in is not configured', async () => {
    await boot(testConfig());
    const res = await callback('code=C&state=x');
    expect(res.headers.location).toBe('http://app.test/sign-in?error=sign_in_disabled');
    expect(clearsCookie(res)).toMatchObject({ value: '' });
  });

  it('9: always clears the sign-in cookie, success or not', async () => {
    const s = await start();
    const outcomes = [
      await callback(`code=C&state=${s.state}`, s.cookie),
      await callback('code=C'),
      await callback(`error=access_denied&state=${s.state}`, s.cookie),
    ];
    for (const res of outcomes) expect(clearsCookie(res)).toMatchObject({ value: '', path: '/api/auth/salesforce/callback' });
  });
});

describe('GET /api/auth/providers', () => {
  it('10: says which sign-in buttons to show, with no session required', async () => {
    const both = await app.inject({ method: 'GET', url: '/api/auth/providers' });
    expect(both.statusCode).toBe(200);
    expect(both.json()).toEqual({ salesforce: true, workos: false });
    await boot(testConfig());
    expect((await app.inject({ method: 'GET', url: '/api/auth/providers' })).json()).toEqual({ salesforce: false, workos: false });
  });
});

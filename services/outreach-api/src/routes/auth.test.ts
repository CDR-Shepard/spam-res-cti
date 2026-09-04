import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sign } from '@fastify/cookie';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { signState } from '../auth/state.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  issued: [] as string[],
  revoked: [] as string[],
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  issueSession: async (userId: string) => { state.issued.push(userId); return { token: `tok-${userId}`, expiresAt: new Date('2026-10-04T00:00:00Z') }; },
  resolveSession: async () => state.session,
  revokeSession: async (bearer: string) => { state.revoked.push(bearer); },
}));

const cfg = testConfig();
const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const humanSession = { userId: 'U1', orgId: 'O1', email: 'ann@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
let app: FastifyInstance;
let idp: FakeIdentityProvider;
let captured: { where: unknown[] };

beforeEach(async () => {
  state.session = null; state.issued = []; state.revoked = [];
  idp = new FakeIdentityProvider();
  idp.addUser({ externalId: 'wos_u1', email: 'ann@gg.co', firstName: 'Ann', lastName: 'Rep' }, [{ organizationId: 'org_gg', role: 'admin' }]);
  idp.setNextCode('code-1', 'wos_u1', 'org_gg');
  const fixture = fakeDb({ organizations: [tenant], users: [] });
  captured = fixture.captured;
  app = await buildTestApp({ cfg, db: fixture.db, idp });
});
afterEach(async () => { await app.close(); });

describe('sign-in routes', () => {
  it('start redirects to the provider with a signed state carrying returnTo, and sets the oauth nonce cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/workos/start?returnTo=/team' });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.host).toBe('fake-idp.test');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const nonceCookie = res.cookies.find((c) => c.name === 'outreach_oauth_nonce');
    expect(nonceCookie).toMatchObject({ httpOnly: true, path: '/api/auth/workos/callback', maxAge: 600 });
  });
  it('start is 503 when WorkOS is not configured', async () => {
    await app.close();
    app = await buildTestApp({ cfg, db: fakeDb({ organizations: [tenant] }).db, idp: null });
    const res = await app.inject({ method: 'GET', url: '/api/auth/workos/start' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SIGN_IN_DISABLED' });
  });
  it('callback rejects a bad state before touching the provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/workos/callback?code=code-1&state=nope' });
    expect(res.statusCode).toBe(400);
    expect(state.issued).toEqual([]);
  });
  it('callback requires the oauth nonce cookie set at start; a missing or mismatching nonce is rejected before any session is issued', async () => {
    const { state: st } = signState(cfg.SESSION_SECRET, {});
    const noCookie = await app.inject({ method: 'GET', url: `/api/auth/workos/callback?code=code-1&state=${st}` });
    expect(noCookie.statusCode).toBe(400);
    expect(state.issued).toEqual([]);
    const wrongCookie = await app.inject({
      method: 'GET',
      url: `/api/auth/workos/callback?code=code-1&state=${st}`,
      cookies: { outreach_oauth_nonce: 'not-the-nonce' },
    });
    expect(wrongCookie.statusCode).toBe(400);
    expect(state.issued).toEqual([]);
  });
  it('callback issues a session, hands it over in a scoped signed cookie, and redirects to the app', async () => {
    const { state: st, nonce } = signState(cfg.SESSION_SECRET, { returnTo: '/team' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/workos/callback?code=code-1&state=${st}`,
      cookies: { outreach_oauth_nonce: nonce },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/auth/callback?returnTo=%2Fteam');
    const cookie = res.cookies.find((c) => c.name === 'outreach_session_handoff');
    expect(cookie).toMatchObject({ httpOnly: true, path: '/api/auth/session', maxAge: 60, sameSite: 'Lax' });
    expect(cookie?.secure).toBeFalsy();
    expect(state.issued).toEqual(['new-1']);
  });
  it('callback sends provider errors and unknown tenants back to sign-in with a reason', async () => {
    const { state: st, nonce } = signState(cfg.SESSION_SECRET, {});
    const denied = await app.inject({
      method: 'GET',
      url: `/api/auth/workos/callback?error=access_denied&state=${st}`,
      cookies: { outreach_oauth_nonce: nonce },
    });
    expect(denied.headers.location).toBe('http://app.test/sign-in?error=access_denied');
    idp.addUser({ externalId: 'wos_u2', email: 'x@y.co', firstName: null, lastName: null }, [{ organizationId: 'org_unknown', role: 'member' }]);
    idp.setNextCode('code-2', 'wos_u2');
    const noTenant = await app.inject({
      method: 'GET',
      url: `/api/auth/workos/callback?code=code-2&state=${st}`,
      cookies: { outreach_oauth_nonce: nonce },
    });
    expect(noTenant.headers.location).toBe('http://app.test/sign-in?error=no_tenant');
  });
  it('session exchanges the handoff cookie once and returns the user and tenant', async () => {
    state.session = humanSession;
    const value = Buffer.from(JSON.stringify({ token: 'tok-U1', expiresAt: '2026-10-04T00:00:00.000Z' })).toString('base64url');
    const res = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: sign(value, cfg.SESSION_SECRET) } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: 'tok-U1', user: { userId: 'U1', kind: 'human' }, tenant: { slug: 'gg-homes' } });
    expect(res.cookies.find((c) => c.name === 'outreach_session_handoff')).toMatchObject({ value: '', path: '/api/auth/session' });
    const none = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(none.statusCode).toBe(401);
  });
  it('session rejects a handoff cookie whose decoded payload is not the expected shape', async () => {
    state.session = humanSession;
    // base64url of the JSON literal `null`: decodes fine but isn't an object.
    const nullValue = Buffer.from(JSON.stringify(null)).toString('base64url');
    expect(nullValue).toBe('bnVsbA');
    const nullRes = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: sign(nullValue, cfg.SESSION_SECRET) } });
    expect(nullRes.statusCode).toBe(401);
    expect(nullRes.json()).toMatchObject({ code: 'NO_HANDOFF' });
    // Shaped like the right object, but expiresAt isn't a valid ISO datetime.
    const badShapeValue = Buffer.from(JSON.stringify({ token: 'tok-U1', expiresAt: 'x' })).toString('base64url');
    const badShapeRes = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: sign(badShapeValue, cfg.SESSION_SECRET) } });
    expect(badShapeRes.statusCode).toBe(401);
    expect(badShapeRes.json()).toMatchObject({ code: 'NO_HANDOFF' });
  });
  it('session rejects an unsigned or tampered handoff cookie', async () => {
    state.session = humanSession;
    const unsigned = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: 'bnVsbA' } });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json()).toMatchObject({ code: 'NO_HANDOFF' });
    const value = Buffer.from(JSON.stringify({ token: 'tok-U1', expiresAt: '2026-10-04T00:00:00.000Z' })).toString('base64url');
    const signedValue = sign(value, cfg.SESSION_SECRET);
    const tampered = signedValue.slice(0, -1) + (signedValue.at(-1) === '0' ? '1' : '0');
    const tamperedRes = await app.inject({ method: 'GET', url: '/api/auth/session', cookies: { outreach_session_handoff: tampered } });
    expect(tamperedRes.statusCode).toBe(401);
    expect(tamperedRes.json()).toMatchObject({ code: 'NO_HANDOFF' });
  });
  it('me requires a bearer and logout revokes it', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    state.session = humanSession;
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer tok-U1' } });
    expect(me.json()).toMatchObject({ user: { email: 'ann@gg.co' }, tenant: { name: 'GG Homes' } });
    // Prove the tenant lookup predicates on organizations.id (fakeDb's findFirst
    // ignores `where` and returns the fixture regardless, so the outcome alone
    // can't prove this — render the captured predicate to real SQL, same
    // technique as auth/sign-in.test.ts). users.findFirst runs first in
    // userAndTenant's Promise.all, so index 1 is the organizations lookup.
    const orgWhereSql = new PgDialect().sqlToQuery(captured.where[1] as SQL).sql;
    expect(orgWhereSql).toContain('"organizations"."id" = ');
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { authorization: 'Bearer tok-U1' } });
    expect(out.statusCode).toBe(204);
    expect(state.revoked).toEqual(['Bearer tok-U1']);
  });
  it('me is 403 TENANT_FORBIDDEN when the resolved org row does not match the session tenant', async () => {
    await app.close();
    app = await buildTestApp({ cfg, db: fakeDb({ organizations: [{ ...tenant, id: 'not-O1' }], users: [] }).db, idp });
    state.session = humanSession;
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer tok-U1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_FORBIDDEN' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const cfg = testConfig();
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const admin = { userId: 'U1', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const users = [
  { id: 'U1', orgId: 'O1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, externalAuthId: 'wos_1', kind: 'human' },
  { id: 'U2', orgId: 'O1', email: 'rep@gg.co', displayName: 'Rep', isAdmin: false, powerDialerEnabled: true, externalAuthId: null, kind: 'human' },
];
let app: FastifyInstance;
let idp: FakeIdentityProvider;
const auth = { authorization: 'Bearer t' };

beforeEach(async () => {
  state.session = admin;
  idp = new FakeIdentityProvider();
  app = await buildTestApp({ cfg, db: fakeDb({ organizations: [org], users }).db, idp });
});
afterEach(async () => { await app.close(); });

describe('team routes', () => {
  it('lists human members with a signedIn flag', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/team', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: [
      { id: 'U1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, signedIn: true },
      { id: 'U2', email: 'rep@gg.co', displayName: 'Rep', isAdmin: false, powerDialerEnabled: true, signedIn: false },
    ] });
  });
  it('invites are admin-only, validated, and go through the provider with the tenant org', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'New@GG.co', role: 'admin' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: 'new@gg.co', role: 'admin', state: 'pending' });
    const list = await app.inject({ method: 'GET', url: '/api/team/invites', headers: auth });
    expect(list.json().invites).toHaveLength(1);
    const bad = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'nope' } });
    expect(bad.statusCode).toBe(400);
    state.session = { ...admin, isAdmin: false };
    const denied = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'a@b.co' } });
    expect(denied.statusCode).toBe(403);
  });
  it('409 when the tenant is not linked to WorkOS', async () => {
    await app.close();
    app = await buildTestApp({ cfg, db: fakeDb({ organizations: [{ ...org, workosOrgId: null }], users }).db, idp });
    const res = await app.inject({ method: 'GET', url: '/api/team/invites', headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'WORKOS_NOT_LINKED' });
  });
  it('toggles the admin flag on another human, never on yourself', async () => {
    const ok = await app.inject({ method: 'PATCH', url: '/api/team/U2', headers: auth, payload: { isAdmin: true } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: 'U2', isAdmin: true });
    const self = await app.inject({ method: 'PATCH', url: '/api/team/U1', headers: auth, payload: { isAdmin: false } });
    expect(self.statusCode).toBe(400);
    expect(self.json()).toMatchObject({ code: 'CANNOT_CHANGE_SELF' });
  });
});

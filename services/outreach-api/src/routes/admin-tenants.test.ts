import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { buildTestApp, fakeDb, mockCreateTenant, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
// `createTenant` runs inside `db.transaction(...)` on the real `Db` and its
// slug-collision check is meaningless against fakeDb (whose `findFirst` always
// returns fixture[0], not a real match) — the fixture here already holds one
// organization (the super admin's own tenant), so the real `createTenant`
// would spuriously randomize the new tenant's slug. `mockCreateTenant` (from
// the harness) replays its real insert sequence without that lookup.
vi.mock('@cti/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/auth')>();
  return {
    ...actual,
    resolveSession: async () => state.session,
    // Deferred to call time (not `createTenant: mockCreateTenant()` here):
    // this factory runs while `harness.js` — which exports `mockCreateTenant`
    // — is still being resolved (it's a transitive importer of `@cti/auth`
    // too), so referencing the binding eagerly throws "before initialization".
    createTenant: (...args: Parameters<typeof actual.createTenant>) => mockCreateTenant()(...args),
  };
});

const cfg = testConfig();
const org = { id: '11111111-1111-4111-8111-111111111111', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const superAdmin = { userId: 'U1', orgId: org.id, email: 'me@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: true };
let app: FastifyInstance;
let idp: FakeIdentityProvider;
let writes: ReturnType<typeof fakeDb>['writes'];
afterEach(async () => { await app.close(); });
beforeEach(async () => {
  state.session = superAdmin;
  idp = new FakeIdentityProvider();
  // `ensureWorkosOrg` (provision.ts) does a conditional `update(...).returning()`
  // to record the new WorkOS org id — seed a matched row so it doesn't
  // spuriously conclude a concurrent write already claimed it (see harness.ts's
  // `Fixtures.updateReturning`).
  const fake = fakeDb({ organizations: [org], updateReturning: [{ id: org.id }] });
  writes = fake.writes;
  app = await buildTestApp({ cfg, db: fake.db, idp });
});
const auth = { authorization: 'Bearer t' };

describe('admin tenant routes', () => {
  it('lists tenants for a super admin and refuses everyone else', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/admin/tenants', headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tenants: [expect.objectContaining({ id: org.id, slug: 'gg-homes', workosLinked: false })] });
    state.session = { ...superAdmin, isSuperAdmin: false };
    const no = await app.inject({ method: 'GET', url: '/api/admin/tenants', headers: auth });
    expect(no.statusCode).toBe(403);
    expect(no.json()).toMatchObject({ code: 'SUPER_ADMIN_ONLY' });
  });
  it('provisions a tenant (201) and validates the body', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: auth, payload: { name: 'Acme Buyers', adminEmail: 'Owner@Acme.com' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ tenant: { name: 'Acme Buyers', slug: 'acme-buyers', workosLinked: true }, inviteId: expect.any(String) });
    const bad = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: auth, payload: { name: '' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'VALIDATION' });
  });
  it('links an existing tenant to WorkOS and invites the admin', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/admin/tenants/${org.id}/link-workos`, headers: auth, payload: { adminEmail: 'you@gg.co' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenant: { id: org.id, workosLinked: true }, inviteId: expect.any(String) });
  });
  it('404s TENANT_NOT_FOUND for a non-uuid tenant id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/tenants/not-a-uuid/link-workos', headers: auth, payload: { adminEmail: 'you@gg.co' } });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
  it('refuses a non-super-admin from provisioning a tenant, with no side effects', async () => {
    state.session = { ...superAdmin, isSuperAdmin: false };
    const createSpy = vi.spyOn(idp, 'createOrganization');
    const res = await app.inject({ method: 'POST', url: '/api/admin/tenants', headers: auth, payload: { name: 'Acme Buyers', adminEmail: 'owner@acme.com' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'SUPER_ADMIN_ONLY' });
    expect(writes).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });
  it('refuses a non-super-admin from linking a tenant to WorkOS, with no side effects', async () => {
    state.session = { ...superAdmin, isSuperAdmin: false };
    const createSpy = vi.spyOn(idp, 'createOrganization');
    const res = await app.inject({ method: 'POST', url: `/api/admin/tenants/${org.id}/link-workos`, headers: auth, payload: { adminEmail: 'you@gg.co' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'SUPER_ADMIN_ONLY' });
    expect(writes).toEqual([]);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

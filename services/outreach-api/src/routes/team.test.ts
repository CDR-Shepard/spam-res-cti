import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const cfg = testConfig();
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
// Real uuids: the PATCH route now parses `:userId` with `z.string().uuid()`.
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const REP_ID = '22222222-2222-4222-8222-222222222222';
const admin = { userId: ADMIN_ID, orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const users = [
  { id: ADMIN_ID, orgId: 'O1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, externalAuthId: 'wos_1', kind: 'human' },
  { id: REP_ID, orgId: 'O1', email: 'rep@gg.co', displayName: 'Rep', isAdmin: false, powerDialerEnabled: true, externalAuthId: null, kind: 'human' },
];
let app: FastifyInstance;
let idp: FakeIdentityProvider;
let captured: { where: unknown[] };
let writes: Array<{ op: 'insert' | 'update'; table: unknown; values: Record<string, unknown> }>;
const auth = { authorization: 'Bearer t' };

async function build(over: { organizations?: Array<Record<string, unknown>>; updateReturning?: Array<Record<string, unknown>> } = {}): Promise<FastifyInstance> {
  const fixture = fakeDb({ organizations: over.organizations ?? [org], users, updateReturning: over.updateReturning });
  captured = fixture.captured;
  writes = fixture.writes;
  return buildTestApp({ cfg, db: fixture.db, idp });
}

beforeEach(async () => {
  state.session = admin;
  idp = new FakeIdentityProvider();
  app = await build();
});
afterEach(async () => { await app.close(); });

describe('team routes', () => {
  it('lists human members ordered by display name then email, predicated on org and human kind', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/team', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: [
      { id: ADMIN_ID, email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, signedIn: true },
      { id: REP_ID, email: 'rep@gg.co', displayName: 'Rep', isAdmin: false, powerDialerEnabled: true, signedIn: false },
    ] });
    // captured.where[0] is requireContext's own organizations lookup; the
    // roster query's where is the last one pushed.
    const whereSql = new PgDialect().sqlToQuery(captured.where.at(-1) as SQL).sql;
    expect(whereSql).toContain('"users"."org_id" = ');
    expect(whereSql).toContain('"users"."kind" = ');
  });

  it('invites are admin-only, go through the provider with the tenant org, and record the caller as inviter', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'New@GG.co', role: 'admin' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: expect.any(String), email: 'new@gg.co', role: 'admin', state: 'pending', expiresAt: expect.any(String) });
    expect(idp.lastInvite()).toMatchObject({ organizationId: 'org_gg', inviterExternalId: 'wos_1' });
    const list = await app.inject({ method: 'GET', url: '/api/team/invites', headers: auth });
    // Exactly the Invite contract's keys — no organizationId leak from the provider.
    expect(list.json().invites).toEqual([{ id: expect.any(String), email: 'new@gg.co', role: 'admin', state: 'pending', expiresAt: expect.any(String) }]);
    const bad = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'nope' } });
    expect(bad.statusCode).toBe(400);
    state.session = { ...admin, isAdmin: false };
    const denied = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'a@b.co' } });
    expect(denied.statusCode).toBe(403);
  });

  it('POST invites validates the body before the WorkOS-link gate: a malformed body on an unlinked tenant is 400, not 409', async () => {
    await app.close();
    app = await build({ organizations: [{ ...org, workosOrgId: null }] });
    const res = await app.inject({ method: 'POST', url: '/api/team/invites', headers: auth, payload: { email: 'nope' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('409 when the tenant is not linked to WorkOS', async () => {
    await app.close();
    app = await build({ organizations: [{ ...org, workosOrgId: null }] });
    const res = await app.inject({ method: 'GET', url: '/api/team/invites', headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'WORKOS_NOT_LINKED' });
  });

  describe('PATCH /api/team/:userId', () => {
    it('toggles the admin flag on another human (seeded updateReturning), predicated on id, org, and human kind', async () => {
      await app.close();
      app = await build({ updateReturning: [{ id: REP_ID, orgId: 'O1', email: 'rep@gg.co', displayName: 'Rep', isAdmin: true, powerDialerEnabled: true, externalAuthId: null, kind: 'human' }] });
      const res = await app.inject({ method: 'PATCH', url: `/api/team/${REP_ID}`, headers: auth, payload: { isAdmin: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: REP_ID, isAdmin: true });
      const whereSql = new PgDialect().sqlToQuery(captured.where.at(-1) as SQL).sql;
      expect(whereSql).toContain('"users"."id" = ');
      expect(whereSql).toContain('"users"."org_id" = ');
      expect(whereSql).toContain('"users"."kind" = ');
    });

    it('refuses only a self-demotion: 403 CANNOT_DEMOTE_SELF and no write', async () => {
      const res = await app.inject({ method: 'PATCH', url: `/api/team/${ADMIN_ID}`, headers: auth, payload: { isAdmin: false } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'CANNOT_DEMOTE_SELF' });
      expect(writes).toEqual([]);
    });

    it('allows a self-target promotion (idempotent) with 200', async () => {
      await app.close();
      app = await build({ updateReturning: [{ id: ADMIN_ID, orgId: 'O1', email: 'admin@gg.co', displayName: 'Admin', isAdmin: true, powerDialerEnabled: false, externalAuthId: 'wos_1', kind: 'human' }] });
      const res = await app.inject({ method: 'PATCH', url: `/api/team/${ADMIN_ID}`, headers: auth, payload: { isAdmin: true } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ id: ADMIN_ID, isAdmin: true });
    });

    it('a non-uuid userId is 404 MEMBER_NOT_FOUND and makes no write', async () => {
      const res = await app.inject({ method: 'PATCH', url: '/api/team/not-a-uuid', headers: auth, payload: { isAdmin: true } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'MEMBER_NOT_FOUND' });
      expect(writes).toEqual([]);
    });

    it('an unknown/foreign/service user id (no updateReturning seeded) is 404 MEMBER_NOT_FOUND', async () => {
      const otherUuid = '33333333-3333-4333-8333-333333333333';
      const res = await app.inject({ method: 'PATCH', url: `/api/team/${otherUuid}`, headers: auth, payload: { isAdmin: true } });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    });

    it('rejects a non-admin caller with 403 ADMIN_ONLY and makes no write', async () => {
      state.session = { ...admin, isAdmin: false };
      const res = await app.inject({ method: 'PATCH', url: `/api/team/${REP_ID}`, headers: auth, payload: { isAdmin: true } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ADMIN_ONLY' });
      expect(writes).toEqual([]);
    });

    it('400 VALIDATION with flattened details for a malformed body', async () => {
      const res = await app.inject({ method: 'PATCH', url: `/api/team/${REP_ID}`, headers: auth, payload: { isAdmin: 'yes' } });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'VALIDATION' });
      expect(res.json().details).toBeDefined();
    });
  });
});

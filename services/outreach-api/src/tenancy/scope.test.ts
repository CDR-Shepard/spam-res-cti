import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { fakeDb } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
import { requireAdmin, requireContext } from './scope.js';

const human = { userId: 'U1', orgId: 'O1', email: 'a@b.co', isAdmin: false, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const org1 = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles' };
const org2 = { id: '11111111-1111-4111-8111-111111111111', name: 'Other', slug: 'other', status: 'active', timezone: 'UTC' };

async function run(db: unknown, headers: Record<string, string> = {}) {
  const app = Fastify();
  app.get('/x', async (req, reply) => {
    const ctx = await requireContext(db as never, req, reply);
    if (!ctx) return;
    return { orgId: ctx.orgId, admin: requireAdmin(ctx, reply) };
  });
  const res = await app.inject({ method: 'GET', url: '/x', headers: { authorization: 'Bearer t', ...headers } });
  await app.close();
  return res;
}

beforeEach(() => { state.session = human; });

describe('requireContext', () => {
  it('401 without a valid session', async () => {
    state.session = null;
    const res = await run(fakeDb({ organizations: [org1] }).db);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
  });
  it("resolves the session's own tenant and ignores X-Org-Id for non-super-admins", async () => {
    // Admin, so the run() harness's own requireAdmin() call (exercised together
    // with requireContext on every /x request) doesn't send its own 403 and
    // clobber the 200 this test is actually checking — see report deviations.
    state.session = { ...human, isAdmin: true };
    const res = await run(fakeDb({ organizations: [org1] }).db, { 'x-org-id': org2.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId: 'O1' });
  });
  it('lets a super admin switch to another active tenant, and rejects a bad or unknown id', async () => {
    state.session = { ...human, isSuperAdmin: true };
    const ok = await run(fakeDb({ organizations: [org2] }).db, { 'x-org-id': org2.id });
    expect(ok.json()).toMatchObject({ orgId: org2.id });
    const bad = await run(fakeDb({ organizations: [org2] }).db, { 'x-org-id': 'not-a-uuid' });
    expect(bad.statusCode).toBe(403);
    const unknown = await run(fakeDb({ organizations: [] }).db, { 'x-org-id': org2.id });
    expect(unknown.statusCode).toBe(403);
  });
  it('403 TENANT_SUSPENDED when the tenant is not active', async () => {
    const res = await run(fakeDb({ organizations: [{ ...org1, status: 'suspended' }] }).db);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'TENANT_SUSPENDED' });
  });
  it('requireAdmin sends 403 ADMIN_ONLY for non-admins', async () => {
    const res = await run(fakeDb({ organizations: [org1] }).db);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ADMIN_ONLY' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { buildTestApp, fakeDb, testConfig } from '../test/harness.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
// `createTenant` runs inside `db.transaction(...)` on the real `Db` and its
// slug-collision check is meaningless against fakeDb (whose `findFirst` always
// returns fixture[0], not a real match) — see provision.test.ts for the same
// override, needed here because the route under test calls provisionTenant too.
vi.mock('@cti/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/auth')>();
  return {
    ...actual,
    resolveSession: async () => state.session,
    createTenant: async (
      db: { insert: (t: unknown) => { values: (v: Record<string, unknown>) => { returning: () => Promise<unknown[]>; onConflictDoNothing: () => Promise<unknown> } } },
      input: { name: string; slug?: string; timezone?: string },
    ) => {
      const slug = actual.slugify(input.slug ?? input.name) || 'org';
      const timezone = input.timezone ?? 'America/Los_Angeles';
      const [org] = (await db.insert(schema.organizations).values({ name: input.name, slug, timezone }).returning()) as [Record<string, unknown>];
      const [agent] = (await db.insert(schema.users).values({ orgId: org!.id, email: actual.aiAgentEmail(slug), displayName: actual.AI_AGENT_DISPLAY_NAME, kind: 'service', timezone }).returning()) as [{ id: string }];
      await db.insert(schema.campaignConfigs).values({ orgId: org!.id, key: 'default', name: 'Default Campaign' }).onConflictDoNothing();
      return { org, aiAgentUserId: agent!.id };
    },
  };
});

const cfg = testConfig();
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const superAdmin = { userId: 'U1', orgId: 'O1', email: 'me@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: true };
let app: FastifyInstance;
afterEach(async () => { await app.close(); });
beforeEach(async () => {
  state.session = superAdmin;
  app = await buildTestApp({ cfg, db: fakeDb({ organizations: [org] }).db, idp: new FakeIdentityProvider() });
});
const auth = { authorization: 'Bearer t' };

describe('admin tenant routes', () => {
  it('lists tenants for a super admin and refuses everyone else', async () => {
    const ok = await app.inject({ method: 'GET', url: '/api/admin/tenants', headers: auth });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tenants: [expect.objectContaining({ id: 'O1', slug: 'gg-homes', workosLinked: false })] });
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
    const res = await app.inject({ method: 'POST', url: '/api/admin/tenants/O1/link-workos', headers: auth, payload: { adminEmail: 'you@gg.co' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ tenant: { id: 'O1', workosLinked: true }, inviteId: expect.any(String) });
  });
});

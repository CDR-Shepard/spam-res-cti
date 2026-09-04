import { describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { fakeDb } from '../test/harness.js';

// `createTenant` runs its work inside `db.transaction(...)` against the real
// `Db` (see @cti/auth/tenancy.ts); the harness's `fakeDb` has no `.transaction`.
// Mock only `createTenant`, replaying its real insert sequence directly against
// `db` (no transaction wrapper) so `provisionTenant`'s own logic — the
// WorkOS-linking and invite steps that come after — is what's under test here.
vi.mock('@cti/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/auth')>();
  return {
    ...actual,
    createTenant: async (db: { insert: (t: unknown) => { values: (v: Record<string, unknown>) => { returning: () => Promise<unknown[]>; onConflictDoNothing: () => Promise<unknown> } } }, input: { name: string; slug?: string; timezone?: string }) => {
      const slug = actual.slugify(input.slug ?? input.name) || 'org';
      const timezone = input.timezone ?? 'America/Los_Angeles';
      const [org] = (await db.insert(schema.organizations).values({ name: input.name, slug, timezone }).returning()) as [Record<string, unknown>];
      const [agent] = (await db.insert(schema.users).values({ orgId: org!.id, email: actual.aiAgentEmail(slug), displayName: actual.AI_AGENT_DISPLAY_NAME, kind: 'service', timezone }).returning()) as [{ id: string }];
      await db.insert(schema.campaignConfigs).values({ orgId: org!.id, key: 'default', name: 'Default Campaign' }).onConflictDoNothing();
      return { org, aiAgentUserId: agent!.id };
    },
  };
});

import { linkTenantToWorkos, provisionTenant } from './provision.js';

const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };

describe('provisionTenant', () => {
  it('creates the tenant, a WorkOS organization tagged with our org id, links it, and invites the admin', async () => {
    const { db, writes } = fakeDb({ organizations: [] });
    const idp = new FakeIdentityProvider();
    const out = await provisionTenant({ db, idp, log }, { name: 'Acme Buyers', timezone: 'America/Chicago', adminEmail: 'owner@acme.com' });
    expect(writes.map((w) => w.op)).toEqual(['insert', 'insert', 'insert', 'update']);
    expect(writes[0]).toMatchObject({ table: schema.organizations, values: { name: 'Acme Buyers', slug: 'acme-buyers', timezone: 'America/Chicago' } });
    expect(writes[3]).toMatchObject({ table: schema.organizations, values: { workosOrgId: 'org_fake_1' } });
    expect(out.tenant.workosOrgId).toBe('org_fake_1');
    const invites = await idp.listInvites('org_fake_1');
    expect(invites).toEqual([expect.objectContaining({ email: 'owner@acme.com', role: 'admin', state: 'pending' })]);
    expect(out.inviteId).toBe(invites[0]!.id);
  });
  it('alerts and rethrows when the provider fails after the tenant row exists', async () => {
    const { db } = fakeDb({ organizations: [] });
    const idp = new FakeIdentityProvider();
    idp.createOrganization = async () => { throw new Error('workos down'); };
    await expect(provisionTenant({ db, idp, log }, { name: 'Acme', timezone: 'UTC', adminEmail: 'o@a.com' })).rejects.toThrow('workos down');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ alert: 'provisioning_failed' }), expect.any(String));
  });
});

describe('linkTenantToWorkos', () => {
  const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
  it('creates and stores a WorkOS organization for an unlinked tenant, then invites the admin', async () => {
    const { db, writes } = fakeDb({ organizations: [org] });
    const idp = new FakeIdentityProvider();
    const out = await linkTenantToWorkos({ db, idp, log }, 'O1', 'you@gghomes.com');
    expect(writes).toEqual([expect.objectContaining({ op: 'update', values: { workosOrgId: 'org_fake_1' } })]);
    expect(out.tenant.workosOrgId).toBe('org_fake_1');
    expect((await idp.listInvites('org_fake_1'))[0]).toMatchObject({ email: 'you@gghomes.com', role: 'admin' });
  });
  it('reuses an existing link and only sends the invite', async () => {
    const { db, writes } = fakeDb({ organizations: [{ ...org, workosOrgId: 'org_existing' }] });
    const idp = new FakeIdentityProvider();
    await linkTenantToWorkos({ db, idp, log }, 'O1', 'you@gghomes.com');
    expect(writes).toEqual([]);
    expect(await idp.listInvites('org_existing')).toHaveLength(1);
  });
  it('throws for an unknown tenant', async () => {
    const { db } = fakeDb({ organizations: [] });
    await expect(linkTenantToWorkos({ db, idp: new FakeIdentityProvider(), log }, 'nope', 'a@b.co')).rejects.toThrow('Unknown tenant');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from '../auth/fake-provider.js';
import { fakeDb } from '../test/harness.js';
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
  it('reuses a WorkOS org already tagged with the tenant id instead of creating a second one', async () => {
    const { db, writes } = fakeDb({ organizations: [org] });
    const idp = new FakeIdentityProvider();
    idp.seedOrganization({ id: 'org_existing_tagged', name: 'GG Homes', externalId: 'O1' });
    const createSpy = vi.spyOn(idp, 'createOrganization');
    const out = await linkTenantToWorkos({ db, idp, log }, 'O1', 'you@gghomes.com');
    expect(createSpy).not.toHaveBeenCalled();
    expect(out.tenant.workosOrgId).toBe('org_existing_tagged');
    expect(writes).toEqual([expect.objectContaining({ op: 'update', values: { workosOrgId: 'org_existing_tagged' } })]);
  });
  it('fails loudly when the conditional update matches no row', async () => {
    const { db } = fakeDb({ organizations: [org], updateReturning: [] });
    const idp = new FakeIdentityProvider();
    await expect(linkTenantToWorkos({ db, idp, log }, 'O1', 'you@gg.co')).rejects.toThrow('tenant was linked concurrently');
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ alert: 'provisioning_failed' }), expect.any(String));
  });
});

import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from './fake-provider.js';
import { completeSignIn } from './sign-in.js';
import { fakeDb } from '../test/harness.js';

const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', workosOrgId: 'org_gg' };
const other = { id: 'O2', name: 'Other', slug: 'other', status: 'active', workosOrgId: 'org_other' };

type FakeMembership = { organizationId: string; role: string; status?: 'active' | 'inactive' | 'pending' };

function idpWith(email: string, orgs: FakeMembership[], organizationId: string | null = null) {
  const idp = new FakeIdentityProvider();
  idp.addUser({ externalId: 'wos_u1', email, firstName: 'Ann', lastName: 'Rep' }, orgs);
  idp.setNextCode('code-1', 'wos_u1', organizationId);
  return idp;
}

describe('completeSignIn', () => {
  it('creates a human user in the tenant matching the WorkOS org and links the external id', async () => {
    const { db, writes, captured } = fakeDb({ organizations: [tenant], users: [] });
    const idp = idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]);
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'new-1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'insert', table: schema.users, values: { orgId: 'O1', email: 'ann@gg.co', kind: 'human', externalAuthId: 'wos_u1', isAdmin: false, displayName: 'Ann Rep' } });
    // Prove the tenant lookup actually predicates on workos_org_id (the fake DB
    // doesn't filter `where` itself, so a wrong column would still "pass" on
    // outcome alone) — captured.where[0] is the organizations.findMany call.
    const orgsWhereSql = new PgDialect().sqlToQuery(captured.where[0] as SQL).sql;
    expect(orgsWhereSql).toContain('"organizations"."workos_org_id" in (');
  });
  it('links an existing human user, promotes on admin role, never demotes', async () => {
    const existing = { id: 'U1', orgId: 'O1', email: 'ann@gg.co', kind: 'human', isAdmin: true, externalAuthId: null, displayName: 'Ann' };
    const { db, writes } = fakeDb({ organizations: [tenant], users: [existing] });
    const out = await completeSignIn({ db, idp: idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'U1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'update', table: schema.users, values: { externalAuthId: 'wos_u1', isAdmin: true } });
  });
  it('links an existing user by normalized email regardless of the case the provider returned', async () => {
    const existing = { id: 'U1', orgId: 'O1', email: 'ann@gg.co', kind: 'human', isAdmin: false, externalAuthId: null, displayName: 'Ann' };
    const { db, writes, captured } = fakeDb({ organizations: [tenant], users: [existing] });
    const idp = idpWith('Ann@GG.co', [{ organizationId: 'org_gg', role: 'member' }]);
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'U1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'update', table: schema.users });
    // The fake DB never filters `where` itself (findFirst always returns the
    // fixture row), so the outcome alone can't prove the lookup normalized the
    // email — inspect the actual compiled predicate's bound parameter instead.
    const usersWhere = captured.where[1];
    const { params } = new PgDialect().sqlToQuery(usersWhere as SQL);
    expect(params).toContain('ann@gg.co');
    expect(params).not.toContain('Ann@GG.co');
  });
  it('prefers the organization WorkOS selected, then the first active membership we know', async () => {
    const { db } = fakeDb({ organizations: [other, tenant], users: [] });
    const idp = idpWith('ann@gg.co', [{ organizationId: 'org_other', role: 'member' }, { organizationId: 'org_gg', role: 'admin' }], 'org_gg');
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toMatchObject({ ok: true, orgId: 'O1' });
  });
  it('ignores a provider-selected org the user is not an active member of', async () => {
    const membership: FakeMembership[] = [{ organizationId: 'org_other', role: 'member' }];
    const { db: withBothTenants } = fakeDb({ organizations: [tenant, other], users: [] });
    const outWithBoth = await completeSignIn({ db: withBothTenants, idp: idpWith('ann@gg.co', membership, 'org_gg') }, 'code-1');
    expect(outWithBoth).toMatchObject({ ok: true, orgId: 'O2' });

    const { db: withOnlySelected } = fakeDb({ organizations: [tenant], users: [] });
    const outWithOnlySelected = await completeSignIn({ db: withOnlySelected, idp: idpWith('ann@gg.co', membership, 'org_gg') }, 'code-1');
    expect(outWithOnlySelected).toEqual({ ok: false, reason: 'no_tenant' });
  });
  it('a pending admin membership grants nothing, even when WorkOS selected that org', async () => {
    const { db } = fakeDb({ organizations: [tenant], users: [] });
    const idp = idpWith(
      'ann@gg.co',
      [
        { organizationId: 'org_gg', role: 'admin', status: 'pending' },
        { organizationId: 'org_elsewhere', role: 'member' },
      ],
      'org_gg',
    );
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toEqual({ ok: false, reason: 'no_tenant' });
  });
  it('refuses a user whose memberships match no tenant', async () => {
    const { db, writes } = fakeDb({ organizations: [], users: [] });
    const out = await completeSignIn({ db, idp: idpWith('x@y.co', [{ organizationId: 'org_unknown', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: false, reason: 'no_tenant' });
    expect(writes).toHaveLength(0);
  });
  it('refuses a suspended tenant', async () => {
    const { db } = fakeDb({ organizations: [{ ...tenant, status: 'suspended' }], users: [] });
    const out = await completeSignIn({ db, idp: idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: false, reason: 'tenant_suspended' });
  });
  it('propagates an invalid code as IdentityExchangeError', async () => {
    const { db } = fakeDb({ organizations: [tenant] });
    await expect(completeSignIn({ db, idp: new FakeIdentityProvider() }, 'bad')).rejects.toMatchObject({ name: 'IdentityExchangeError' });
  });
});

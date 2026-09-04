import { describe, expect, it } from 'vitest';
import { schema } from '@cti/db';
import { FakeIdentityProvider } from './fake-provider.js';
import { completeSignIn } from './sign-in.js';
import { fakeDb } from '../test/harness.js';

const tenant = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', workosOrgId: 'org_gg' };
const other = { id: 'O2', name: 'Other', slug: 'other', status: 'active', workosOrgId: 'org_other' };

function idpWith(email: string, orgs: Array<{ organizationId: string; role: string }>, organizationId: string | null = null) {
  const idp = new FakeIdentityProvider();
  idp.addUser({ externalId: 'wos_u1', email, firstName: 'Ann', lastName: 'Rep' }, orgs);
  idp.setNextCode('code-1', 'wos_u1', organizationId);
  return idp;
}

describe('completeSignIn', () => {
  it('creates a human user in the tenant matching the WorkOS org and links the external id', async () => {
    const { db, writes } = fakeDb({ organizations: [tenant], users: [] });
    const idp = idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]);
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'new-1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'insert', table: schema.users, values: { orgId: 'O1', email: 'ann@gg.co', kind: 'human', externalAuthId: 'wos_u1', isAdmin: false, displayName: 'Ann Rep' } });
  });
  it('links an existing human user, promotes on admin role, never demotes', async () => {
    const existing = { id: 'U1', orgId: 'O1', email: 'ann@gg.co', kind: 'human', isAdmin: true, externalAuthId: null, displayName: 'Ann' };
    const { db, writes } = fakeDb({ organizations: [tenant], users: [existing] });
    const out = await completeSignIn({ db, idp: idpWith('ann@gg.co', [{ organizationId: 'org_gg', role: 'member' }]) }, 'code-1');
    expect(out).toEqual({ ok: true, userId: 'U1', orgId: 'O1' });
    expect(writes[0]).toMatchObject({ op: 'update', table: schema.users, values: { externalAuthId: 'wos_u1', isAdmin: true } });
  });
  it('prefers the organization WorkOS selected, then the first active membership we know', async () => {
    const { db } = fakeDb({ organizations: [other, tenant], users: [] });
    const idp = idpWith('ann@gg.co', [{ organizationId: 'org_other', role: 'member' }, { organizationId: 'org_gg', role: 'admin' }], 'org_gg');
    const out = await completeSignIn({ db, idp }, 'code-1');
    expect(out).toMatchObject({ ok: true, orgId: 'O1' });
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

import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import type { SalesforceIdentity } from './salesforce-identity.js';
import { matchSalesforceUser, syntheticSalesforceEmail } from './salesforce-user.js';

const hex = () => randomBytes(6).toString('hex').toUpperCase();

describe('syntheticSalesforceEmail', () => {
  it("is cti-api's lower-cased fallback address", () => {
    expect(syntheticSalesforceEmail({ sfUserId: '005ABC000000001AAA', sfOrgId: '00DXYZ000000001AAA' })).toBe('sf-005abc000000001aaa@00dxyz000000001aaa.salesforce.local');
  });
});

describe.skipIf(!pgLane)('matchSalesforceUser (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);
  afterAll(async () => {
    await t?.drop();
  }, 30_000);

  /** Each case seeds its own org and Salesforce ids, so cases never see each other's rows. */
  async function seedOrg(over: Partial<typeof schema.organizations.$inferInsert> = {}) {
    const core = `00D${hex()}`;
    const sfOrgId = `${core}AAA`;
    const slug = `sfu-${hex().toLowerCase()}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: slug, slug, sfOrgId, ...over }).returning();
    return { orgId: org!.id, sfOrgId };
  }
  async function seedUser(orgId: string, email: string, over: Partial<typeof schema.users.$inferInsert> = {}): Promise<string> {
    const [u] = await t.db.insert(schema.users).values({ orgId, email, ...over }).returning({ id: schema.users.id });
    return u!.id;
  }
  async function connect(userId: string, sfOrgId: string, sfUserId: string): Promise<void> {
    await t.db.insert(schema.salesforceConnections).values({ userId, instanceUrl: 'https://x.my.salesforce.com', sfUserId, sfOrgId, accessTokenEnc: 'enc' });
  }
  const identity = (sfOrgId: string, over: Partial<SalesforceIdentity> = {}): SalesforceIdentity => ({ sfOrgId, sfUserId: `005${hex()}AAA`, email: null, name: null, ...over });
  const counts = async () => {
    const r = await t.pool.query(`select (select count(*)::int from organizations) as orgs, (select count(*)::int from users) as users`);
    return r.rows[0] as { orgs: number; users: number };
  };

  it('1: matches the user holding the CTI Salesforce connection, even when their CTI email differs', async () => {
    const { orgId, sfOrgId } = await seedOrg();
    const userId = await seedUser(orgId, 'old-address@gg.com');
    const id = identity(sfOrgId, { email: 'new-address@gg.com' });
    await connect(userId, sfOrgId, id.sfUserId);
    expect(await matchSalesforceUser(t.db, id)).toEqual({ ok: true, userId, orgId });
  });

  it('2: matches 15- and 18-character Ids both ways, for the org and the user', async () => {
    const stored18 = await seedOrg();
    const user18 = await seedUser(stored18.orgId, 'a@gg.com');
    const id18 = identity(stored18.sfOrgId);
    await connect(user18, stored18.sfOrgId, id18.sfUserId);
    expect(await matchSalesforceUser(t.db, { ...id18, sfOrgId: stored18.sfOrgId.slice(0, 15), sfUserId: id18.sfUserId.slice(0, 15) })).toEqual({ ok: true, userId: user18, orgId: stored18.orgId });

    const core = `00D${hex()}`;
    const stored15 = await seedOrg({ sfOrgId: core });
    const user15 = await seedUser(stored15.orgId, 'b@gg.com');
    const id15 = identity(`${core}AAA`);
    await connect(user15, core, id15.sfUserId.slice(0, 15));
    expect(await matchSalesforceUser(t.db, id15)).toEqual({ ok: true, userId: user15, orgId: stored15.orgId });
  });

  it('3: without a connection row, matches a human user by the lower-cased Salesforce email', async () => {
    const { orgId, sfOrgId } = await seedOrg();
    const userId = await seedUser(orgId, 'rep@gg.com');
    expect(await matchSalesforceUser(t.db, identity(sfOrgId, { email: 'rep@gg.com' }))).toEqual({ ok: true, userId, orgId });
  });

  it("4: with no Salesforce email, matches cti-api's synthetic sf-<user>@<org>.salesforce.local user", async () => {
    const { orgId, sfOrgId } = await seedOrg();
    const id = identity(sfOrgId);
    const userId = await seedUser(orgId, syntheticSalesforceEmail(id));
    expect(await matchSalesforceUser(t.db, id)).toEqual({ ok: true, userId, orgId });
  });

  it('5: a connection row pointing at a user in another org is ignored; the match falls through to email in this org', async () => {
    const mine = await seedOrg();
    const other = await seedOrg();
    const id = identity(mine.sfOrgId, { email: 'rep@gg.com' });
    const stranger = await seedUser(other.orgId, 'stranger@gg.com');
    await connect(stranger, mine.sfOrgId, id.sfUserId);
    const expected = await seedUser(mine.orgId, 'rep@gg.com');
    expect(await matchSalesforceUser(t.db, id)).toEqual({ ok: true, userId: expected, orgId: mine.orgId });
  });

  it('5b: a connection row pointing at another org alone does not match', async () => {
    const mine = await seedOrg();
    const other = await seedOrg();
    const id = identity(mine.sfOrgId, { email: 'nobody@gg.com' });
    await connect(await seedUser(other.orgId, 'stranger@gg.com'), mine.sfOrgId, id.sfUserId);
    expect(await matchSalesforceUser(t.db, id)).toEqual({ ok: false, reason: 'no_account' });
  });

  it('6: never matches a service user', async () => {
    const { orgId, sfOrgId } = await seedOrg();
    await seedUser(orgId, 'agent@gg.com', { kind: 'service' });
    expect(await matchSalesforceUser(t.db, identity(sfOrgId, { email: 'agent@gg.com' }))).toEqual({ ok: false, reason: 'no_account' });
  });

  it('6b: never matches a service user through a connection row either', async () => {
    const { orgId, sfOrgId } = await seedOrg();
    const id = identity(sfOrgId);
    await connect(await seedUser(orgId, 'agent@gg.com', { kind: 'service' }), sfOrgId, id.sfUserId);
    expect(await matchSalesforceUser(t.db, id)).toEqual({ ok: false, reason: 'no_account' });
  });

  it('7: an unknown Salesforce org is no_tenant, and nothing is inserted', async () => {
    const before = await counts();
    expect(await matchSalesforceUser(t.db, identity(`00D${hex()}AAA`, { email: 'rep@gg.com' }))).toEqual({ ok: false, reason: 'no_tenant' });
    expect(await counts()).toEqual(before);
  });

  it('8: a known org with no matching user is no_account, and nothing is inserted', async () => {
    const { sfOrgId } = await seedOrg();
    const before = await counts();
    expect(await matchSalesforceUser(t.db, identity(sfOrgId, { email: 'nobody@gg.com' }))).toEqual({ ok: false, reason: 'no_account' });
    expect(await counts()).toEqual(before);
  });

  it('9: a suspended org is tenant_suspended', async () => {
    const { orgId, sfOrgId } = await seedOrg({ status: 'suspended' });
    await seedUser(orgId, 'rep@gg.com');
    expect(await matchSalesforceUser(t.db, identity(sfOrgId, { email: 'rep@gg.com' }))).toEqual({ ok: false, reason: 'tenant_suspended' });
  });

  it('10: never changes is_admin', async () => {
    const { orgId, sfOrgId } = await seedOrg();
    const admin = await seedUser(orgId, 'boss@gg.com', { isAdmin: true });
    const rep = await seedUser(orgId, 'rep@gg.com', { isAdmin: false });
    await matchSalesforceUser(t.db, identity(sfOrgId, { email: 'boss@gg.com' }));
    await matchSalesforceUser(t.db, identity(sfOrgId, { email: 'rep@gg.com' }));
    const rows = await t.db.select({ id: schema.users.id, isAdmin: schema.users.isAdmin }).from(schema.users).where(sql`${schema.users.id} in (${admin}, ${rep})`);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.isAdmin]))).toEqual({ [admin]: true, [rep]: false });
    expect(await t.db.select().from(schema.users).where(eq(schema.users.id, rep))).toHaveLength(1);
  });
});

/**
 * Smoke test of the real-Postgres lane itself: every migration applies to a
 * fresh database, and the one-active-campaign-per-person index
 * (enrollment_contact_keys_active_unique, PARTIAL on active) really rejects a
 * second active key and really frees the person once the first goes inactive.
 * Skipped unless TEST_DATABASE_URL is set (root `npm run test:pg`).
 */
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrationFiles, schema } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from './pg.js';

describe.skipIf(!pgLane)('real-Postgres lane', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await t?.drop();
  }, 30_000);

  /** One org, two campaigns, two records, one enrollment in each campaign. */
  async function seedTwoEnrollments() {
    const slug = `pg-lane-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: 'PG Lane', slug }).returning();
    const orgId = org!.id;
    const [first, second] = await t.db
      .insert(schema.campaigns)
      .values([
        { orgId, name: 'First', sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead' },
        { orgId, name: 'Second', sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead' },
      ])
      .returning();
    const [recA, recB] = await t.db
      .insert(schema.crmRecords)
      .values([
        { orgId, sfObject: 'Lead', sfRecordId: '00Q000000000001AAA' },
        { orgId, sfObject: 'Lead', sfRecordId: '00Q000000000002AAA' },
      ])
      .returning();
    const [enrA, enrB] = await t.db
      .insert(schema.campaignEnrollments)
      .values([
        { orgId, campaignId: first!.id, crmRecordId: recA!.id },
        { orgId, campaignId: second!.id, crmRecordId: recB!.id },
      ])
      .returning();
    return { orgId, enrollmentA: enrA!.id, enrollmentB: enrB!.id };
  }

  it('applies every migration to the fresh database, outreach tables included', async () => {
    const applied = await t.pool.query<{ filename: string }>('SELECT filename FROM cti_schema_migrations ORDER BY filename');
    expect(applied.rows.map((r) => r.filename)).toEqual((await loadMigrationFiles()).map((f) => f.name));
    const tables = await t.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [['ai_usage_days', 'campaign_enrollments', 'campaigns', 'crm_connections', 'crm_oauth_states', 'crm_records', 'enrollment_contact_keys', 'record_triage', 'sf_writes', 'touches']],
    );
    expect(tables.rows).toHaveLength(10);
  });

  it('rejects a second ACTIVE key for the same person (23505 on the partial index), and allows it once the first is inactive', async () => {
    const { orgId, enrollmentA, enrollmentB } = await seedTwoEnrollments();
    const key = '+15125550101';
    await t.db.insert(schema.enrollmentContactKeys).values({ enrollmentId: enrollmentA, orgId, key });

    await expect(t.db.insert(schema.enrollmentContactKeys).values({ enrollmentId: enrollmentB, orgId, key })).rejects.toMatchObject({
      code: '23505',
      constraint: 'enrollment_contact_keys_active_unique',
    });

    await t.db
      .update(schema.enrollmentContactKeys)
      .set({ active: false })
      .where(and(eq(schema.enrollmentContactKeys.enrollmentId, enrollmentA), eq(schema.enrollmentContactKeys.key, key)));
    await t.db.insert(schema.enrollmentContactKeys).values({ enrollmentId: enrollmentB, orgId, key });

    const rows = await t.db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.key, key));
    expect(rows.map((r) => [r.enrollmentId, r.active]).sort()).toEqual(
      [
        [enrollmentA, false],
        [enrollmentB, true],
      ].sort(),
    );
  });

  it('reads back the defaults the planner relies on (touch_days, phones, gate_audit)', async () => {
    const { enrollmentA } = await seedTwoEnrollments();
    const [enrollment] = await t.db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, enrollmentA));
    const [campaign] = await t.db.select().from(schema.campaigns).where(eq(schema.campaigns.id, enrollment!.campaignId));
    expect(campaign!.touchDays).toEqual([0, 1, 3, 6, 10, 14]);
    expect(campaign!.status).toBe('draft');
    const [record] = await t.db.select().from(schema.crmRecords).where(eq(schema.crmRecords.id, enrollment!.crmRecordId));
    expect(record!.phones).toEqual([]);
    expect(record!.triageNeeded).toBe(true);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { loadPlan, planPageQuery } from './plan.js';

describe.skipIf(!pgLane)('plan query (real Postgres)', () => {
  let t: TestDb;
  const ids = { orgA: '', orgB: '', campaign: '', e1: '', e2: '', e3: '', e4: '' };
  const day = 86_400_000;
  const now = Date.now();
  const audit = [{ rule: 'rule1_live', channel: 'rep_call', verdict: 'kept', detail: 'calls are live' }];
  const triage = (summary: string) => ({ summary, channels: [], timing: null, tags: [], doNotContact: null });

  beforeAll(async () => {
    t = await createTestDb();
    const { db } = t;
    const [orgA, orgB] = await db.insert(schema.organizations).values([{ name: 'A', slug: 'a-org' }, { name: 'B', slug: 'b-org' }]).returning();
    ids.orgA = orgA!.id;
    ids.orgB = orgB!.id;
    const [campaign] = await db.insert(schema.campaigns).values({ orgId: ids.orgA, name: 'C', sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead' }).returning();
    ids.campaign = campaign!.id;
    const records = await db.insert(schema.crmRecords).values([1, 2, 3, 4].map((n) => ({ orgId: n === 4 ? ids.orgB : ids.orgA, sfObject: 'Lead' as const, sfRecordId: `00Q00000000000${n}AAA`, name: `Lead ${n}` }))).returning();
    const enrollments = await db.insert(schema.campaignEnrollments).values([
      { orgId: ids.orgA, campaignId: ids.campaign, crmRecordId: records[0]!.id, status: 'active' as const },
      { orgId: ids.orgA, campaignId: ids.campaign, crmRecordId: records[1]!.id, status: 'exited' as const, exitReason: 'left_query' },
      { orgId: ids.orgA, campaignId: ids.campaign, crmRecordId: records[2]!.id, status: 'active' as const },
      // Another tenant's enrollment under the same campaign id: must never show in this tenant's plan.
      { orgId: ids.orgB, campaignId: ids.campaign, crmRecordId: records[3]!.id, status: 'active' as const },
    ]).returning();
    ids.e1 = enrollments[0]!.id;
    ids.e2 = enrollments[1]!.id;
    ids.e3 = enrollments[2]!.id;
    ids.e4 = enrollments[3]!.id;
    await db.insert(schema.recordTriage).values([
      { orgId: ids.orgA, crmRecordId: records[0]!.id, notesHash: 'h1', model: 'm', result: triage('old'), inputTokens: 1, outputTokens: 1, createdAt: new Date(now - day) },
      { orgId: ids.orgA, crmRecordId: records[0]!.id, notesHash: 'h2', model: 'm', result: triage('new'), inputTokens: 1, outputTokens: 1, createdAt: new Date(now - 1000) },
      { orgId: ids.orgB, crmRecordId: records[0]!.id, notesHash: 'h3', model: 'm', result: triage('foreign'), inputTokens: 1, outputTokens: 1, createdAt: new Date(now) },
    ]);
    await db.insert(schema.touches).values([
      { orgId: ids.orgA, enrollmentId: ids.e1, seq: 1, channel: 'rep_call', status: 'sent', dueAt: new Date(now - day) },
      { orgId: ids.orgA, enrollmentId: ids.e1, seq: 2, channel: 'rep_call', status: 'planned', dueAt: new Date('2026-10-06T15:00:00Z'), gateAudit: audit },
      { orgId: ids.orgA, enrollmentId: ids.e2, seq: 1, channel: 'rep_call', status: 'sent', dueAt: new Date(now - 2 * day) },
      { orgId: ids.orgA, enrollmentId: ids.e2, seq: 2, channel: 'sms', status: 'skipped', dueAt: new Date('2026-10-03T15:00:00Z') },
    ]);
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('shows each enrollment once with its latest same-tenant triage and its open-or-latest touch', async () => {
    const plan = await loadPlan(t.db, { orgId: ids.orgA, campaignId: ids.campaign });
    const byId = new Map(plan.rows.map((r) => [r.enrollmentId, r]));
    expect([...byId.keys()].sort()).toEqual([ids.e1, ids.e2, ids.e3].sort());
    expect(plan.rows.map((r) => r.enrollmentId)).toEqual([...plan.rows.map((r) => r.enrollmentId)].sort());
    expect(byId.get(ids.e1)).toMatchObject({ triage: { summary: 'new' }, nextTouch: { seq: 2, status: 'planned', channel: 'rep_call', dueAt: '2026-10-06T15:00:00.000Z', gateAudit: audit } });
    expect(byId.get(ids.e2)).toMatchObject({ status: 'exited', exitReason: 'left_query', triage: null, nextTouch: { seq: 2, status: 'skipped', channel: 'sms' } });
    expect(byId.get(ids.e3)).toMatchObject({ triage: null, nextTouch: null });
    expect(plan.counts).toEqual({ active: 2, exited: 1 });
    expect(plan.nextCursor).toBeNull();
  });

  it('pages by enrollment id and filters by status', async () => {
    const sorted = [ids.e1, ids.e2, ids.e3].sort();
    const first = await planPageQuery(t.db, { orgId: ids.orgA, campaignId: ids.campaign, limit: 2 });
    expect(first.map((r) => r.enrollmentId)).toEqual(sorted.slice(0, 2));
    const rest = await planPageQuery(t.db, { orgId: ids.orgA, campaignId: ids.campaign, cursor: sorted[1], limit: 2 });
    expect(rest.map((r) => r.enrollmentId)).toEqual(sorted.slice(2));
    const exited = await loadPlan(t.db, { orgId: ids.orgA, campaignId: ids.campaign, status: 'exited' });
    expect(exited.rows.map((r) => r.enrollmentId)).toEqual([ids.e2]);
  });

  it('keeps tenants apart even under one campaign id', async () => {
    const plan = await loadPlan(t.db, { orgId: ids.orgB, campaignId: ids.campaign });
    expect(plan.rows.map((r) => r.enrollmentId)).toEqual([ids.e4]);
    expect(plan.counts).toEqual({ active: 1 });
  });
});

/** Real Postgres: "Call all approved". */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { seedCampaign, seedOrg } from '../test/outreach-fixtures.js';
import { ctxOf, seedAiCallCampaign, seedPlanLead, seedUser, SEED_NOW } from '../test/call-plan-seed.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DecisionError } from './decisions.js';
import { releaseApprovedCalls } from './release.js';

describe.skipIf(!pgLane)('releaseApprovedCalls (real Postgres)', () => {
  let db: Db;
  let pool: Awaited<ReturnType<typeof createTestDb>>['pool'];
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, pool, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup(status: 'dry_run' | 'active' | 'paused' = 'active') {
    const base = await seedAiCallCampaign(db, status);
    const admin = await seedUser(db, base.orgId);
    return { ...base, admin, ctx: ctxOf(base.orgId, admin, true) };
  }
  const approvedLead = async (b: { orgId: string; campaignId: string; admin: string }, o: Parameters<typeof seedPlanLead>[2] = {}) => {
    const lead = await seedPlanLead(db, b, { callStage: 'approved', planStatus: 'approved', approvedBy: b.admin, ...o });
    await db.execute(sql`insert into campaign_selections (org_id, campaign_id, sf_record_id) select ${b.orgId}::uuid, ${b.campaignId}::uuid, sf_record_id from crm_records where id = ${lead.crmRecordId}::uuid`);
    return lead;
  };
  const touches = (enrollmentId: string) => db.select().from(schema.touches).where(eq(schema.touches.enrollmentId, enrollmentId));
  const stage = async (id: string) => (await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, id)))[0]!.callStage;
  const refused = async (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e instanceof DecisionError ? { code: e.code, status: e.status } : e));

  it('11: releases the approved leads, one planned ai_call touch each; a lead the engine would refuse stays approved and counts as skipped', async () => {
    const b = await setup();
    const a = await approvedLead(b);
    const c = await approvedLead(b);
    const blocked = await approvedLead(b, { recordOver: { sfDoNotCall: true } });

    const res = await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW);

    expect(res).toEqual({ released: 2, skipped: 1 });
    for (const lead of [a, c]) {
      const [t, ...rest] = await touches(lead.enrollmentId);
      expect(rest).toEqual([]);
      expect(t).toMatchObject({ channel: 'ai_call', status: 'planned', seq: 1, callPlanId: lead.planId, requestedBy: b.admin });
      expect(t!.dueAt).toEqual(SEED_NOW);
      expect(await stage(lead.enrollmentId)).toBe('queued');
    }
    expect(await touches(blocked.enrollmentId)).toEqual([]);
    expect(await stage(blocked.enrollmentId)).toBe('approved');
  });

  it('12: releasing twice releases nothing the second time', async () => {
    const b = await setup();
    const lead = await approvedLead(b);
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 1, skipped: 0 });
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 0, skipped: 0 });
    expect(await touches(lead.enrollmentId)).toHaveLength(1);
  });

  it('13: a dry_run or paused campaign is CAMPAIGN_NOT_ACTIVE; a sequence campaign NOT_AI_CALL_CAMPAIGN; another tenant NOT_FOUND', async () => {
    for (const status of ['dry_run', 'paused'] as const) {
      const b = await setup(status);
      await approvedLead(b);
      expect(await refused(releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW))).toEqual({ code: 'CAMPAIGN_NOT_ACTIVE', status: 409 });
    }
    const orgId = await seedOrg(db);
    const seq = await seedCampaign(db, orgId, { mode: 'sequence', status: 'active' });
    expect(await refused(releaseApprovedCalls(db, ctxOf(orgId, await seedUser(db, orgId), true), seq.id, SEED_NOW))).toEqual({ code: 'NOT_AI_CALL_CAMPAIGN', status: 409 });
    const b = await setup();
    const other = await setup();
    expect(await refused(releaseApprovedCalls(db, other.ctx, b.campaignId, SEED_NOW))).toEqual({ code: 'NOT_FOUND', status: 404 });
  });

  it('14: an exit that commits while the release is inserting wins: no touch for an exited enrollment', async () => {
    const b = await setup();
    const lead = await approvedLead(b);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`update campaign_enrollments set status = 'exited', exit_reason = 'left_query' where id = $1`, [lead.enrollmentId]);
      const release = releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await client.query('commit');
      expect(await release).toEqual({ released: 0, skipped: 1 });
    } finally {
      client.release();
    }
    expect(await touches(lead.enrollmentId)).toEqual([]);
  });

  it('skips every lead whose consent is not exactly yes, whatever the engine would say later (CF-5, CF-10b)', async () => {
    const b = await setup();
    const leads = [await approvedLead(b, { consent: 'no' }), await approvedLead(b, { consent: 'unknown' }), await approvedLead(b, { consent: null }), await approvedLead(b, { consent: 'field_missing' })];
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 0, skipped: 4 });
    for (const l of leads) expect(await touches(l.enrollmentId)).toEqual([]);
  });

  it("uses the approved plan's own research for consent (CF-6), not a newer research row", async () => {
    const b = await setup();
    const lead = await approvedLead(b, { consent: 'no' });
    await db.execute(sql`
      insert into call_research (org_id, enrollment_id, crm_record_id, version, snapshot, size_chars, content_hash)
      select org_id, enrollment_id, crm_record_id, 2, jsonb_set(snapshot, '{consent}', '"yes"'), size_chars, 'newer' from call_research where id = ${lead.researchId}::uuid`);
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 0, skipped: 1 });
  });

  it('skips a plan the model flagged do-not-contact until a person dismissed the flag (CF-10c)', async () => {
    const b = await setup();
    const lead = await approvedLead(b, { dncFlagged: true });
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 0, skipped: 1 });
    const [triage] = (await db.execute(sql`
      insert into record_triage (org_id, crm_record_id, notes_hash, model, result, input_tokens, output_tokens)
      values (${b.orgId}::uuid, ${lead.crmRecordId}::uuid, 'h', 'm', ${JSON.stringify({ summary: 's', channels: [], timing: null, tags: [], doNotContact: { category: 'attorney', quote: 'q' } })}::jsonb, 1, 1) returning id`) as unknown as { rows: Array<{ id: string }> }).rows;
    await db.execute(sql`update crm_records set dnc_dismissed_triage_id = ${triage!.id}::uuid where id = ${lead.crmRecordId}::uuid`);
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 1, skipped: 0 });
  });

  it('a lead deselected after approval is skipped, never queued', async () => {
    const b = await setup();
    const lead = await approvedLead(b);
    await db.execute(sql`delete from campaign_selections where campaign_id = ${b.campaignId}::uuid`);
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 0, skipped: 1 });
    expect(await touches(lead.enrollmentId)).toEqual([]);
  });

  it('CF-3: an old dialing touch from before a reactivation neither blocks the release nor gets reused; seq continues', async () => {
    const b = await setup();
    const lead = await approvedLead(b);
    await db.insert(schema.touches).values({ orgId: b.orgId, enrollmentId: lead.enrollmentId, seq: 1, channel: 'ai_call', status: 'dialing', dueAt: SEED_NOW });
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 1, skipped: 0 });
    const all = await touches(lead.enrollmentId);
    expect(all.map((t) => [t.seq, t.status]).sort()).toEqual([[1, 'dialing'], [2, 'planned']]);
  });

  it('a touch of this plan that is already open blocks a second one', async () => {
    const b = await setup();
    const lead = await approvedLead(b);
    await db.insert(schema.touches).values({ orgId: b.orgId, enrollmentId: lead.enrollmentId, seq: 1, channel: 'ai_call', status: 'planned', dueAt: SEED_NOW, callPlanId: lead.planId });
    expect(await releaseApprovedCalls(db, b.ctx, b.campaignId, SEED_NOW)).toEqual({ released: 0, skipped: 1 });
    expect(await touches(lead.enrollmentId)).toHaveLength(1);
  });
});

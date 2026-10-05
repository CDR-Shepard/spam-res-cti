/** Real Postgres: the `ai_call.place` tick's carry-forward guards (CF-1, CF-2, CF-3, CF-10, CF-12). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { SalesforceApiError } from '@cti/salesforce';
import { approvePlan } from '../call-plans/decisions.js';
import { enrollmentById, planById, seedAiCall, seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { ctxOf, seedPlanLead, seedUser } from '../test/call-plan-seed.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { ACTIVITY_CHECK_RETRY_MS } from './pace-context.js';
import { BACK_TO_RESEARCH_WORDS, PARK_WORDS } from './stage.js';
import { STALE_DIALING_MS } from './touches.js';

const NOW = new Date('2026-10-05T23:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
/** The research seed's collectedAt (call-plan-seed SEED_NOW); `researchedAt` pins the row's created_at to it too. */
const RESEARCHED = new Date('2026-10-05T19:00:00.000Z');

describe.skipIf(!pgLane)('placeDueAiCalls guards (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  const researchedAt = (researchId: string | null) =>
    db.update(schema.callResearch).set({ createdAt: RESEARCHED }).where(eq(schema.callResearch.id, researchId!));

  describe('CF-1: Salesforce activity newer than the research', () => {
    it.each([
      ['a Task', 'tasks', { WhoId: 'self' }],
      ['an Event', 'events', { WhatId: 'self' }],
    ] as const)('%s logged after the research sends the lead back to research; no trigger', async (_label, list, ref) => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      await researchedAt(lead.researchId);
      const self = Object.fromEntries(Object.entries(ref).map(([k]) => [k, lead.sfRecordId]));
      h.sf.state[list].push({ Id: '00T000000000009AAA', ...self, LastModifiedDate: at(RESEARCHED, MIN).toISOString() });

      expect((await h.run(NOW)).researched).toBe(1);

      expect(h.cti.requests).toEqual([]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'skipped', skipReason: 'new_salesforce_activity' });
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({
        status: 'active',
        callStage: 'research',
        callPrepareAttemptedAt: null,
        callPrepareError: BACK_TO_RESEARCH_WORDS,
      });
      expect(h.sf.state.soql.some((q) => q.includes(' FROM Task ') && q.includes(lead.sfRecordId))).toBe(true);
    });

    it('activity from before the research, and the engine\'s own call Task, are not news: the call goes ahead', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      await researchedAt(lead.researchId);
      await seedAiCall(db, h.base.orgId, lead.approver, { status: 'completed', sfObject: 'Lead', sfRecordId: lead.sfRecordId, sfTaskId: '00T000000000077AAA' });
      h.sf.state.tasks.push(
        { Id: '00T000000000076AAA', WhoId: lead.sfRecordId, LastModifiedDate: at(RESEARCHED, -MIN).toISOString() },
        { Id: '00T000000000077AAA', WhoId: lead.sfRecordId, LastModifiedDate: at(RESEARCHED, 60 * MIN).toISOString() },
      );
      expect((await h.run(NOW)).placed).toBe(1);
    });

    it('when the activity check fails, nobody in the tenant is called and the touches wait', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      h.sf.state.activityError = new SalesforceApiError('INVALID_TYPE', 400, null);

      await h.run(NOW);

      expect(h.cti.requests).toEqual([]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, lastBlockReason: 'activity_check_failed', dueAt: at(NOW, ACTIVITY_CHECK_RETRY_MS) });
    });
  });

  it('CF-2: a lead deselected after the release is never called (the claim refuses it)', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    await db.execute(sql`delete from campaign_selections where campaign_id = ${h.base.campaignId}::uuid and sf_record_id = ${lead.sfRecordId}`);

    expect((await h.run(NOW)).deferred).toBe(1);

    expect(h.cti.requests).toEqual([]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, lastBlockReason: 'not_claimable' });
  });

  it('CF-10: consent not exactly yes on the plan\'s research is never called', async () => {
    const h = await paceHarness(db);
    await seedReleasedLead(db, h.base, { consent: 'unknown' });
    await h.run(NOW);
    expect(h.cti.requests).toEqual([]);
  });

  it('CF-3: a dialing touch left from before a reactivation is reaped and skipped, never called, and does not block the new plan\'s touch', async () => {
    const h = await paceHarness(db);
    const approver = await seedUser(db, h.base.orgId);
    const lead = await seedReleasedLead(db, h.base, { approver });
    // Its earlier life: the touch was claimed long ago and its tick died; then the lead was deselected and reactivated.
    await db
      .update(schema.touches)
      .set({ status: 'dialing', attempts: 1, triggerKey: `touch:${lead.touchId}:1`, claimedAt: at(NOW, -STALE_DIALING_MS - MIN) })
      .where(eq(schema.touches.id, lead.touchId));
    await db.update(schema.callPlans).set({ status: 'superseded' }).where(eq(schema.callPlans.id, lead.planId!));
    await db.update(schema.campaignEnrollments).set({ callStage: 'research' }).where(eq(schema.campaignEnrollments.id, lead.enrollmentId));

    await h.run(NOW);

    expect(h.cti.requests).toEqual([]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'skipped', skipReason: 'plan_not_approved' });
    expect((await enrollmentById(db, lead.enrollmentId)).callStage).toBe('research');

    // The new life: a new approved plan and its own touch are called; the old touch never is.
    const fresh = await seedPlanLead(db, h.base, { planStatus: 'approved' });
    await db.update(schema.callResearch).set({ enrollmentId: lead.enrollmentId, version: 2 }).where(eq(schema.callResearch.id, fresh.researchId!));
    await db.update(schema.callPlans).set({ enrollmentId: lead.enrollmentId, version: 2 }).where(eq(schema.callPlans.id, fresh.planId!));
    await db.update(schema.campaignEnrollments).set({ callStage: 'queued' }).where(eq(schema.campaignEnrollments.id, lead.enrollmentId));
    const [next] = await db
      .insert(schema.touches)
      .values({ orgId: h.base.orgId, enrollmentId: lead.enrollmentId, seq: 2, channel: 'ai_call', status: 'planned', dueAt: NOW, callPlanId: fresh.planId, requestedBy: approver })
      .returning({ id: schema.touches.id });
    expect((await h.run(NOW)).placed).toBe(1);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([`touch:${next!.id}:1`]);
  });

  describe('CF-12: a refused plan or an approver who cannot call goes back to the board, never retried', () => {
    it.each(['plan_rejected', 'unknown_user'] as const)('cti-api answers %s', async (reason) => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ result: 'failed', reason });

      expect((await h.run(NOW)).parked).toBe(1);

      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'failed', lastBlockReason: reason, triggerKey: null });
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'active', callStage: 'review', callPrepareError: PARK_WORDS[reason] });
      expect(await planById(db, lead.planId!)).toMatchObject({ status: 'proposed', decidedBy: null, decidedAt: null });
      await h.run(at(NOW, 60 * MIN));
      expect(h.cti.requests).toHaveLength(1);

      // A person approves it again: the board's error goes away.
      const admin = await seedUser(db, h.base.orgId);
      await approvePlan(db, ctxOf(h.base.orgId, admin, true), lead.enrollmentId, { version: (await planById(db, lead.planId!)).version }, NOW);
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ callStage: 'approved', callPrepareError: null });
    });

    it('a touch whose approver was deleted (requested_by null) is parked unknown_user without a trigger', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base, { touch: { requestedBy: null } });
      expect((await h.run(NOW)).parked).toBe(1);
      expect(h.cti.requests).toEqual([]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'failed', lastBlockReason: 'unknown_user', attempts: 0 });
      expect((await enrollmentById(db, lead.enrollmentId)).callPrepareError).toBe(PARK_WORDS.unknown_user);
    });

    it('a stored plan the voice agent\'s check refuses is parked plan_rejected before any trigger', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base, { planOver: { talkingPoints: ['We can pay $250k cash'] } });
      expect((await h.run(NOW)).parked).toBe(1);
      expect(h.cti.requests).toEqual([]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'failed', lastBlockReason: 'plan_rejected' });
      expect((await planById(db, lead.planId!)).status).toBe('proposed');
      const warned = h.logs.find((l) => l.msg === 'ai_call.place: the plan fails the voice agent text check');
      expect(JSON.stringify(warned)).not.toContain('250');
    });
  });
});

/** Real Postgres: the AI call touch claims, counts and settles behind the `ai_call.place` tick. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { enrollmentById, planById, seedAiCall, seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { seedCampaign } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import {
  claimAiTouch,
  deferTouch,
  dueAiCallTouches,
  finishAiEnrollment,
  liveAiCallCount,
  orgsWithDueAiCalls,
  placedInLastDay,
  reapStaleDialing,
  settleTouch,
  STALE_DIALING_MS,
} from './touches.js';
import { IN_FLIGHT_RETRY_MS } from './pacing-rules.js';

const NOW = new Date('2026-10-05T23:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
/** The key a claim at `at` mints: the touch, the attempt and the claim time (I-1: unique even when an attempt is given back). */
const keyOf = (touchId: string, attempt: number, at: Date = NOW) => `touch:${touchId}:${attempt}:${at.getTime()}`;

describe.skipIf(!pgLane)('AI call touches (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  const setTouch = (id: string, set: Partial<typeof schema.touches.$inferInsert>) => db.update(schema.touches).set(set).where(eq(schema.touches.id, id));

  it('1: dueAiCallTouches returns only planned, due ai_call touches of active enrollments in active ai_call campaigns of this tenant, oldest first', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const older = await seedReleasedLead(db, base, { dueAt: ago(20 * MIN) });
    const newer = await seedReleasedLead(db, base, { dueAt: ago(5 * MIN) });
    const future = await seedReleasedLead(db, base, { dueAt: new Date(NOW.getTime() + MIN) });
    const exited = await seedReleasedLead(db, base, { dueAt: ago(MIN) });
    await db.update(schema.campaignEnrollments).set({ status: 'exited' }).where(eq(schema.campaignEnrollments.id, exited.enrollmentId));
    const dialing = await seedReleasedLead(db, base, { dueAt: ago(MIN), touch: { status: 'dialing' } });
    const paused = await seedAiCallCampaign(db, 'paused');
    await seedReleasedLead(db, paused, { dueAt: ago(MIN) });
    const seqCampaign = await seedCampaign(db, base.orgId, { mode: 'sequence', status: 'active' });
    await seedReleasedLead(db, { orgId: base.orgId, campaignId: seqCampaign.id }, { dueAt: ago(MIN) });
    const other = await seedAiCallCampaign(db, 'active');
    await seedReleasedLead(db, other, { dueAt: ago(MIN) });

    const due = await dueAiCallTouches(db, base.orgId, NOW, 20);
    expect(due.map((d) => d.touchId)).toEqual([older.touchId, newer.touchId]);
    expect(due[0]).toMatchObject({
      orgId: base.orgId,
      enrollmentId: older.enrollmentId,
      crmRecordId: older.crmRecordId,
      sfObject: 'Lead',
      sfRecordId: older.sfRecordId,
      seq: 1,
      attempts: 0,
      callPlanId: older.planId,
      requestedBy: older.approver,
      phones: [{ field: 'MobilePhone', e164: '+15125550100' }],
      firstAiTouch: true,
    });
    expect(await dueAiCallTouches(db, base.orgId, NOW, 1)).toHaveLength(1);
    expect(future.touchId && dialing.touchId).toBeTruthy();
    const orgs = await orgsWithDueAiCalls(db, NOW);
    expect(orgs).toContain(base.orgId);
    expect(orgs).toContain(other.orgId);
    expect(orgs).not.toContain(paused.orgId);
  });

  it('1: firstAiTouch is false once an earlier ai_call touch of the enrollment was sent', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base, { dueAt: ago(MIN), touch: { seq: 2 } });
    await db.insert(schema.touches).values({ orgId: base.orgId, enrollmentId: lead.enrollmentId, seq: 1, channel: 'ai_call', status: 'sent', dueAt: ago(60 * MIN) });
    expect((await dueAiCallTouches(db, base.orgId, NOW, 20))[0]?.firstAiTouch).toBe(false);
  });

  it('2-3: the first claim mints touch:<id>:1:<claim ms> and marks it dialing; a second claim gets nothing', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    expect(await claimAiTouch(db, lead.touchId, NOW)).toEqual({ attempts: 1, triggerKey: keyOf(lead.touchId, 1) });
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'dialing', claimedAt: NOW, attempts: 1 });
    expect(await claimAiTouch(db, lead.touchId, NOW)).toBeNull();
  });

  it('4: a retry that kept the key reuses it; one that cleared it mints the attempt number', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    await claimAiTouch(db, lead.touchId, NOW);
    await settleTouch(db, lead.touchId, { kind: 'retry', at: NOW, reason: 'transport', keepKey: true, refundAttempt: false }, NOW);
    expect(await claimAiTouch(db, lead.touchId, NOW)).toEqual({ attempts: 2, triggerKey: keyOf(lead.touchId, 1) });
    await settleTouch(db, lead.touchId, { kind: 'retry', at: NOW, reason: 'calling_hours', keepKey: false, refundAttempt: false }, NOW);
    expect(await claimAiTouch(db, lead.touchId, NOW)).toEqual({ attempts: 3, triggerKey: keyOf(lead.touchId, 3) });
  });

  it('I-1: a retry that gives its attempt back counts nothing, and the next claim still mints a key never sent before', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    const later = new Date(NOW.getTime() + 30 * MIN);
    expect(await claimAiTouch(db, lead.touchId, NOW)).toEqual({ attempts: 1, triggerKey: keyOf(lead.touchId, 1) });
    await settleTouch(db, lead.touchId, { kind: 'retry', at: later, reason: 'ai_voice_unavailable', keepKey: false, refundAttempt: true }, NOW);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, triggerKey: null, lastBlockReason: 'ai_voice_unavailable' });
    // cti-api stored the refusal under the first key: the same attempt number must come with a new key.
    expect(await claimAiTouch(db, lead.touchId, later)).toEqual({ attempts: 1, triggerKey: keyOf(lead.touchId, 1, later) });
    // A transport failure gives the attempt back too, and keeps its key (CF-13).
    await settleTouch(db, lead.touchId, { kind: 'retry', at: later, reason: 'transport', keepKey: true, refundAttempt: true }, later);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, triggerKey: keyOf(lead.touchId, 1, later) });
  });

  it('5: an exited enrollment is not claimed and its touch is untouched', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    await db.update(schema.campaignEnrollments).set({ status: 'exited' }).where(eq(schema.campaignEnrollments.id, lead.enrollmentId));
    expect(await claimAiTouch(db, lead.touchId, NOW)).toBeNull();
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, triggerKey: null, claimedAt: null });
  });

  describe('CF-2, CF-10, CF-11: the claim re-checks everything in its own statement', () => {
    const refused: Array<[string, (db: Db, lead: Awaited<ReturnType<typeof seedReleasedLead>>) => Promise<unknown>]> = [
      ['the campaign was paused', (d, l) => d.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, l.campaignId))],
      ['the enrollment is held in needs_review', (d, l) => d.update(schema.campaignEnrollments).set({ status: 'needs_review' }).where(eq(schema.campaignEnrollments.id, l.enrollmentId))],
      ['the stage is not queued', (d, l) => d.update(schema.campaignEnrollments).set({ callStage: 'review' }).where(eq(schema.campaignEnrollments.id, l.enrollmentId))],
      ['the plan is no longer approved', (d, l) => d.update(schema.callPlans).set({ status: 'proposed' }).where(eq(schema.callPlans.id, l.planId!))],
      ['the lead was deselected', (d, l) => d.execute(sql`delete from campaign_selections where campaign_id = ${l.campaignId}::uuid`)],
      ['the plan research read consent unknown', (d, l) => d.execute(sql`update call_research set snapshot = jsonb_set(snapshot, '{consent}', '"unknown"') where id = ${l.researchId}::uuid`)],
      ['the plan research read consent no', (d, l) => d.execute(sql`update call_research set snapshot = jsonb_set(snapshot, '{consent}', '"no"') where id = ${l.researchId}::uuid`)],
      ['the plan research has no consent value', (d, l) => d.execute(sql`update call_research set snapshot = snapshot - 'consent' where id = ${l.researchId}::uuid`)],
      ['the plan was flagged do-not-contact and nobody dismissed it', (d, l) => d.update(schema.callPlans).set({ dncFlagged: true }).where(eq(schema.callPlans.id, l.planId!))],
      [
        'a do-not-contact flag on the record is pending',
        (d, l) =>
          d.insert(schema.recordTriage).values({
            orgId: l.orgId,
            crmRecordId: l.crmRecordId,
            notesHash: 'h',
            model: 'm',
            result: { summary: 's', channels: [], timing: null, tags: [], doNotContact: { category: 'sold', quote: 'sold it' } },
            inputTokens: 0,
            outputTokens: 0,
          }),
      ],
    ];
    it.each(refused)('refuses when %s', async (_label, change) => {
      const base = await seedAiCallCampaign(db, 'active');
      const lead = await seedReleasedLead(db, base);
      await change(db, lead);
      expect(await claimAiTouch(db, lead.touchId, NOW)).toBeNull();
      expect((await touchById(db, lead.touchId)).status).toBe('planned');
    });

    it('claims a flagged plan whose flag a person dismissed (CF-7)', async () => {
      const base = await seedAiCallCampaign(db, 'active');
      const lead = await seedReleasedLead(db, base);
      await db.update(schema.callPlans).set({ dncFlagged: true, dncDismissedAt: NOW }).where(eq(schema.callPlans.id, lead.planId!));
      expect(await claimAiTouch(db, lead.touchId, NOW)).not.toBeNull();
    });

    it('CF-3: a touch carrying a plan from before a reactivation (superseded) is never claimed', async () => {
      const base = await seedAiCallCampaign(db, 'active');
      const lead = await seedReleasedLead(db, base);
      await db.update(schema.callPlans).set({ status: 'superseded' }).where(eq(schema.callPlans.id, lead.planId!));
      expect(await claimAiTouch(db, lead.touchId, NOW)).toBeNull();
    });
  });

  it('6: settling placed marks the touch sent with the call and clears the key and reason', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base, { touch: { lastBlockReason: 'calling_hours' } });
    await claimAiTouch(db, lead.touchId, NOW);
    const aiCallId = await seedAiCall(db, base.orgId, lead.approver);
    await settleTouch(db, lead.touchId, { kind: 'placed', aiCallId }, NOW);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', sentAt: NOW, aiCallId, triggerKey: null, lastBlockReason: null });
  });

  it('7: settling a retry plans it again at the time with the reason, keeping or clearing the key', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    const at = new Date(NOW.getTime() + 10 * MIN);
    await claimAiTouch(db, lead.touchId, NOW);
    await settleTouch(db, lead.touchId, { kind: 'retry', at, reason: 'in_flight', keepKey: true, refundAttempt: false }, NOW);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', dueAt: at, lastBlockReason: 'in_flight', triggerKey: keyOf(lead.touchId, 1) });
    await claimAiTouch(db, lead.touchId, NOW);
    await settleTouch(db, lead.touchId, { kind: 'retry', at, reason: 'twilio_error', keepKey: false, refundAttempt: false }, NOW);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', lastBlockReason: 'twilio_error', triggerKey: null });
  });

  it('8: settling final marks it failed with the reason, keeping the call id when given', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    const aiCallId = await seedAiCall(db, base.orgId, lead.approver, { status: 'blocked' });
    await claimAiTouch(db, lead.touchId, NOW);
    await settleTouch(db, lead.touchId, { kind: 'failed', reason: 'no_consent', aiCallId }, NOW);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'failed', lastBlockReason: 'no_consent', aiCallId, triggerKey: null });
  });

  it('9: settling a touch that is not dialing changes nothing', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    await settleTouch(db, lead.touchId, { kind: 'failed', reason: 'no_consent', aiCallId: null }, NOW);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', lastBlockReason: null });
  });

  it('deferTouch moves a planned touch only', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    const at = new Date(NOW.getTime() + 60 * MIN);
    await deferTouch(db, lead.touchId, at, 'outside_window');
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', dueAt: at, lastBlockReason: 'outside_window', attempts: 0 });
    await claimAiTouch(db, lead.touchId, NOW);
    await deferTouch(db, lead.touchId, NOW, 'x');
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'dialing', dueAt: at });
  });

  it('10: reapStaleDialing returns a stale unanswered dialing touch to planned now with its key; a fresh one stays', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const stale = await seedReleasedLead(db, base);
    const fresh = await seedReleasedLead(db, base);
    const placed = await seedReleasedLead(db, base);
    await claimAiTouch(db, stale.touchId, ago(STALE_DIALING_MS + MIN));
    await claimAiTouch(db, fresh.touchId, ago(MIN));
    await claimAiTouch(db, placed.touchId, ago(STALE_DIALING_MS + MIN));
    await setTouch(placed.touchId, { aiCallId: await seedAiCall(db, base.orgId, placed.approver) });

    expect(await reapStaleDialing(db, NOW)).toBe(1);
    // A3: the key is kept, so the retry waits at least IN_FLIGHT_RETRY_MS after the original reservation (CF-13).
    expect(await touchById(db, stale.touchId)).toMatchObject({
      status: 'planned', dueAt: new Date(ago(STALE_DIALING_MS + MIN).getTime() + IN_FLIGHT_RETRY_MS), triggerKey: keyOf(stale.touchId, 1, ago(STALE_DIALING_MS + MIN)), attempts: 1,
    });
    expect((await touchById(db, fresh.touchId)).status).toBe('dialing');
    expect((await touchById(db, placed.touchId)).status).toBe('dialing');
  });

  it('A3: a touch claimed long ago is due now; a touch of an ended enrollment is skipped, not planned', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const old = await seedReleasedLead(db, base);
    const ended = await seedReleasedLead(db, base);
    await claimAiTouch(db, old.touchId, ago(30 * MIN));
    await claimAiTouch(db, ended.touchId, ago(30 * MIN));
    await db.update(schema.campaignEnrollments).set({ status: 'exited', exitReason: 'opted_out' }).where(eq(schema.campaignEnrollments.id, ended.enrollmentId));

    expect(await reapStaleDialing(db, NOW)).toBe(2);
    expect(await touchById(db, old.touchId)).toMatchObject({ status: 'planned', dueAt: NOW, triggerKey: keyOf(old.touchId, 1, ago(30 * MIN)) });
    expect(await touchById(db, ended.touchId)).toMatchObject({ status: 'skipped', skipReason: 'enrollment_ended' });
  });

  it('11: live calls count dialing touches and sent touches whose call is still live; the day counts sent touches of the last 24 hours', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const user = await seedUser(db, base.orgId);
    const dialing = await seedReleasedLead(db, base, { approver: user });
    await claimAiTouch(db, dialing.touchId, ago(MIN));
    const sentTouch = async (status: string, sentAgo: number, createdAgo = MIN) => {
      const lead = await seedReleasedLead(db, base, { approver: user });
      const aiCallId = await seedAiCall(db, base.orgId, user, { status, createdAt: ago(createdAgo) });
      await setTouch(lead.touchId, { status: 'sent', aiCallId, sentAt: ago(sentAgo) });
    };
    await sentTouch('ringing', MIN);
    await sentTouch('in_progress', 2 * MIN);
    await sentTouch('transferring', 3 * MIN);
    await sentTouch('completed', 4 * MIN);
    await sentTouch('queued', 25 * 60 * MIN, 25 * 60 * MIN); // a call stuck queued for a day is not live, nor today's
    const other = await seedAiCallCampaign(db, 'active');
    const otherLead = await seedReleasedLead(db, other);
    await claimAiTouch(db, otherLead.touchId, NOW);

    expect(await liveAiCallCount(db, base.orgId, NOW)).toBe(4);
    expect(await placedInLastDay(db, base.orgId, NOW)).toBe(4);
  });

  it('12: finishAiEnrollment ends an active enrollment at done, frees its keys and skips its open touches; a held one is left alone', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const lead = await seedReleasedLead(db, base);
    await db.insert(schema.enrollmentContactKeys).values({ enrollmentId: lead.enrollmentId, orgId: base.orgId, key: '+15125550100', active: true });
    await finishAiEnrollment(db, lead.enrollmentId, 'ai_call_no_consent', 'exited');
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'ai_call_no_consent', callStage: 'done', nextTouchAt: null });
    expect((await db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.enrollmentId, lead.enrollmentId)))[0]?.active).toBe(false);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'skipped', skipReason: 'ai_call_no_consent' });

    const held = await seedReleasedLead(db, base, { status: 'needs_review' });
    await finishAiEnrollment(db, held.enrollmentId, 'ai_call_no_answer', 'completed');
    expect(await enrollmentById(db, held.enrollmentId)).toMatchObject({ status: 'needs_review', callStage: 'queued', exitReason: null });
    expect((await planById(db, held.planId!)).status).toBe('approved');
  });
});

/** Real Postgres: the `ai_call.results` tick turns finished calls into hand-offs, exits and next-day retries. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { enrollmentById, seedAiCall, seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { nextAttemptAt } from './pacing-rules.js';
import { collectAiCallResults } from './results.js';

const NOW = new Date('2026-10-05T23:30:00.000Z');
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(!pgLane)('collectAiCallResults (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  /** A lead whose touch `seq` was placed and whose call is now in `status` with `outcome`. */
  async function placed(status: string, outcome: string | null, o: { settings?: Record<string, unknown>; seq?: number; enrollment?: 'active' | 'needs_review' } = {}) {
    const base = await seedAiCallCampaign(db, 'active');
    if (o.settings) await db.update(schema.organizations).set({ settings: o.settings }).where(eq(schema.organizations.id, base.orgId));
    const lead = await seedReleasedLead(db, base, { touch: { seq: o.seq ?? 1 }, ...(o.enrollment ? { status: o.enrollment } : {}) });
    await db.insert(schema.enrollmentContactKeys).values({ enrollmentId: lead.enrollmentId, orgId: base.orgId, key: '+15125550100', active: true });
    for (let s = 1; s < (o.seq ?? 1); s += 1) {
      await db.insert(schema.touches).values({ orgId: base.orgId, enrollmentId: lead.enrollmentId, seq: s, channel: 'ai_call', status: 'sent', dueAt: NOW, countedAt: NOW });
    }
    const aiCallId = await seedAiCall(db, base.orgId, lead.approver, { status, outcome, endedAt: NOW });
    await db.update(schema.touches).set({ status: 'sent', aiCallId, sentAt: NOW, attempts: 1 }).where(eq(schema.touches.id, lead.touchId));
    return { ...lead, aiCallId };
  }
  const touchesOf = (enrollmentId: string) => db.select().from(schema.touches).where(eq(schema.touches.enrollmentId, enrollmentId)).orderBy(schema.touches.seq);
  const keyActive = async (enrollmentId: string) =>
    (await db.select().from(schema.enrollmentContactKeys).where(eq(schema.enrollmentContactKeys.enrollmentId, enrollmentId)))[0]?.active;

  it('1: a ringing call is not finished: nothing happens', async () => {
    const lead = await placed('ringing', null);
    await collectAiCallResults(db, NOW, quiet);
    expect(await touchById(db, lead.touchId)).toMatchObject({ outcome: null, countedAt: null });
    expect((await enrollmentById(db, lead.enrollmentId)).touchesDone).toBe(0);
  });

  it('2: completed / qualified_callback: the touch is counted and the person is handed off', async () => {
    const lead = await placed('completed', 'qualified_callback');
    const res = await collectAiCallResults(db, NOW, quiet);
    expect(res.handedOff).toBeGreaterThanOrEqual(1);
    expect(await touchById(db, lead.touchId)).toMatchObject({ outcome: 'qualified_callback', countedAt: NOW });
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'handed_off', callStage: 'done', nextTouchAt: null, touchesDone: 1 });
    expect(await keyActive(lead.enrollmentId)).toBe(true);
  });

  it('3: completed / not_interested: the enrollment exits not_interested and the contact keys are freed', async () => {
    const lead = await placed('completed', 'not_interested');
    await collectAiCallResults(db, NOW, quiet);
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'not_interested', callStage: 'done', touchesDone: 1 });
    expect(await keyActive(lead.enrollmentId)).toBe(false);
  });

  it('4: completed / voicemail on attempt 1 of 3: a new planned ai_call touch for the next day with the same plan and approver', async () => {
    const lead = await placed('completed', 'voicemail');
    await collectAiCallResults(db, NOW, quiet);
    const [first, next, ...rest] = await touchesOf(lead.enrollmentId);
    expect(rest).toEqual([]);
    expect(first).toMatchObject({ outcome: 'voicemail', countedAt: NOW });
    expect(next).toMatchObject({ seq: 2, channel: 'ai_call', status: 'planned', callPlanId: lead.planId, requestedBy: lead.approver, attempts: 0, triggerKey: null });
    expect(next!.dueAt).toEqual(nextAttemptAt('+15125550100', NOW));
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'active', callStage: 'queued', touchesDone: 1 });
  });

  it('5: the same on attempt 3 of 3 completes with ai_call_no_answer', async () => {
    const lead = await placed('completed', 'no_answer', { seq: 3 });
    await collectAiCallResults(db, NOW, quiet);
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'completed', exitReason: 'ai_call_no_answer', callStage: 'done' });
    expect(await touchesOf(lead.enrollmentId)).toHaveLength(3);
  });

  it('5b: the tenant\'s aiCallMaxAttempts decides: 1 attempt completes at once', async () => {
    const lead = await placed('failed', null, { settings: { aiCallMaxAttempts: 1 } });
    await collectAiCallResults(db, NOW, quiet);
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'completed', exitReason: 'ai_call_no_answer' });
  });

  it('6: running twice changes nothing the second time', async () => {
    const lead = await placed('completed', 'busy');
    await collectAiCallResults(db, NOW, quiet);
    const after = { e: await enrollmentById(db, lead.enrollmentId), t: await touchesOf(lead.enrollmentId) };
    await collectAiCallResults(db, new Date(NOW.getTime() + 60_000), quiet);
    expect(await enrollmentById(db, lead.enrollmentId)).toEqual(after.e);
    expect(await touchesOf(lead.enrollmentId)).toEqual(after.t);
  });

  it('7: an enrollment held in needs_review meanwhile: only the touch outcome is recorded', async () => {
    const lead = await placed('completed', 'not_interested', { enrollment: 'needs_review' });
    await collectAiCallResults(db, NOW, quiet);
    expect(await touchById(db, lead.touchId)).toMatchObject({ outcome: 'not_interested', countedAt: NOW });
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'needs_review', callStage: 'queued', exitReason: null });
    expect(await keyActive(lead.enrollmentId)).toBe(true);
    expect(await touchesOf(lead.enrollmentId)).toHaveLength(1);
  });

  it('Part 4 Fix 1 (I-2): a touch linked to a practice call is never counted as the real call', async () => {
    const lead = await placed('completed', 'not_interested');
    await db.update(schema.aiCalls).set({ isTest: true, practice: true }).where(eq(schema.aiCalls.id, lead.aiCallId));
    await collectAiCallResults(db, NOW, quiet);
    expect(await touchById(db, lead.touchId)).toMatchObject({ outcome: null, countedAt: null });
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'active', touchesDone: 0 });
  });

  it('8: a test call has no touch and is never picked up', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const admin = await seedUser(db, base.orgId);
    const testCall = await seedAiCall(db, base.orgId, admin, { isTest: true, status: 'completed', outcome: 'voicemail' });
    await collectAiCallResults(db, NOW, quiet);
    const linked = await db.select().from(schema.touches).where(and(eq(schema.touches.aiCallId, testCall)));
    expect(linked).toEqual([]);
  });

  const writebacksOf = (aiCallId: string) => db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.aiCallId, aiCallId));

  it('9: completed / appointment_set: handed off, and one pending write-back row in the same step', async () => {
    const lead = await placed('completed', 'appointment_set', { settings: { aiCallWriteback: true } });
    await collectAiCallResults(db, NOW, quiet);
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'handed_off' });
    expect(await writebacksOf(lead.aiCallId)).toEqual([
      expect.objectContaining({
        orgId: lead.orgId,
        touchId: lead.touchId,
        enrollmentId: lead.enrollmentId,
        sfObject: 'Lead',
        sfRecordId: lead.sfRecordId,
        outcome: 'appointment_set',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: NOW,
        lastError: null,
      }),
    ]);
  });

  it('10: running the tick twice still leaves one row', async () => {
    const lead = await placed('completed', 'not_interested');
    await collectAiCallResults(db, NOW, quiet);
    await db.update(schema.touches).set({ countedAt: null }).where(eq(schema.touches.id, lead.touchId));
    await collectAiCallResults(db, new Date(NOW.getTime() + 60_000), quiet);
    expect(await writebacksOf(lead.aiCallId)).toHaveLength(1);
  });

  it('11: voicemail enqueues nothing', async () => {
    const lead = await placed('completed', 'voicemail');
    await collectAiCallResults(db, NOW, quiet);
    expect(await writebacksOf(lead.aiCallId)).toEqual([]);
  });

  it("final review WEB I-2: a tenant that never turned write-back on: the row is born skipped with 'write-back is off'", async () => {
    const lead = await placed('completed', 'qualified_callback');
    await collectAiCallResults(db, NOW, quiet);
    expect(await writebacksOf(lead.aiCallId)).toEqual([expect.objectContaining({ status: 'skipped', lastError: 'write-back is off' })]);
  });

  it("12: the tenant's aiCallWriteback false: the row is born skipped with 'write-back is off'", async () => {
    const lead = await placed('completed', 'qualified_callback', { settings: { aiCallWriteback: false } });
    await collectAiCallResults(db, NOW, quiet);
    expect(await writebacksOf(lead.aiCallId)).toEqual([expect.objectContaining({ status: 'skipped', lastError: 'write-back is off' })]);
  });

  it('13: an is_test call seeded with a touch: no row', async () => {
    const lead = await placed('completed', 'appointment_set');
    await db.update(schema.aiCalls).set({ isTest: true }).where(eq(schema.aiCalls.id, lead.aiCallId));
    await collectAiCallResults(db, NOW, quiet);
    expect(await writebacksOf(lead.aiCallId)).toEqual([]);
  });

  it('14: a practice call (is_test, practice, no touch) that booked: no row', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const admin = await seedUser(db, base.orgId);
    const practice = await seedAiCall(db, base.orgId, admin, { isTest: true, practice: true, status: 'completed', outcome: 'appointment_set', endedAt: NOW });
    await collectAiCallResults(db, NOW, quiet);
    expect(await writebacksOf(practice)).toEqual([]);
  });

  it('a retry is not planned while another touch of the lead is still open (CF-3: an old dialing touch of another plan does not count)', async () => {
    const lead = await placed('completed', 'voicemail');
    await db.insert(schema.touches).values({ orgId: lead.orgId, enrollmentId: lead.enrollmentId, seq: 5, channel: 'ai_call', status: 'planned', dueAt: NOW, callPlanId: lead.planId });
    await collectAiCallResults(db, NOW, quiet);
    expect((await touchesOf(lead.enrollmentId)).map((t) => t.seq)).toEqual([1, 5]);

    const other = await placed('completed', 'voicemail');
    await db.insert(schema.touches).values({ orgId: other.orgId, enrollmentId: other.enrollmentId, seq: 4, channel: 'ai_call', status: 'dialing', dueAt: NOW, callPlanId: null });
    await collectAiCallResults(db, NOW, quiet);
    const after = await touchesOf(other.enrollmentId);
    expect(after.map((t) => [t.seq, t.status])).toEqual([[1, 'sent'], [4, 'dialing'], [5, 'planned']]);
  });

  it('A2: a lead reactivated while its call was live gets no retry with the old plan (the plan is no longer approved)', async () => {
    const lead = await placed('completed', 'voicemail');
    // Reactivated mid-call: the plan was superseded and the lead went back to research (still active).
    await db.update(schema.callPlans).set({ status: 'superseded' }).where(eq(schema.callPlans.id, lead.planId!));
    const res = await collectAiCallResults(db, NOW, quiet);
    expect(await touchById(db, lead.touchId)).toMatchObject({ outcome: 'voicemail', countedAt: NOW });
    expect((await touchesOf(lead.enrollmentId)).map((t) => t.seq)).toEqual([1]);
    expect(res.retried).toBe(0);
  });

  it('A2: a plan approved for another enrollment never carries a retry', async () => {
    const lead = await placed('completed', 'voicemail');
    const other = await placed('completed', 'qualified_callback');
    await db.update(schema.touches).set({ callPlanId: other.planId }).where(eq(schema.touches.id, lead.touchId));
    await collectAiCallResults(db, NOW, quiet);
    expect((await touchesOf(lead.enrollmentId)).map((t) => t.seq)).toEqual([1]);
  });
});

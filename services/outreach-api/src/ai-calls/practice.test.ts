/** Real Postgres: practice AI calls (plan 1D Task 28). A real record's plan rung to an admin's test number; nothing is ever written. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PracticeCallsResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { collectAiCallResults } from './results.js';
import { listPracticeCalls, startPractice } from './practice.js';
import { loadTranscript } from './results-query.js';
import { runWritebacks } from '../writeback/run.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { ctxOf, seedAiCallCampaign, seedPlanLead, seedUser, type PlanLeadOptions } from '../test/call-plan-seed.js';
import { fakeCti } from '../test/fake-pace.js';
import { fakeSfWrites, type FakeSfWrites } from '../test/fake-sf-writes.js';
import { seedCampaign, seedEnrollment, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { depsFor, GRANT, PHONE_BOOKING, quiet } from '../test/writeback-harness.js';

const TEST_NUMBER = '+15125550111';
/** Tue Oct 6, 9:00 AM PT: the default phone hours leave free times today and tomorrow. */
const NOW = new Date('2026-10-06T16:00:00.000Z');

/** A Salesforce org that answers only the offer's reads (the owner and their calendar) and records every request. */
function readOnlyOrg(): FakeSfWrites {
  return fakeSfWrites({
    queries: [
      [/^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' }]],
      [/^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event/, []],
    ],
  });
}

describe.skipIf(!pgLane)('practice AI calls (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup(o: { planStatus?: 'proposed' | 'approved'; planOver?: PlanLeadOptions['planOver']; settings?: Record<string, unknown> } = {}) {
    const base = await seedAiCallCampaign(db, 'active');
    if (o.settings) await db.update(schema.organizations).set({ settings: o.settings }).where(eq(schema.organizations.id, base.orgId));
    const admin = await seedUser(db, base.orgId);
    const lead = await seedPlanLead(db, base, { planStatus: o.planStatus ?? 'approved', approvedBy: admin, ...(o.planOver ? { planOver: o.planOver } : {}) });
    const cti = fakeCti(db);
    cti.available = { available: true, testNumbers: [TEST_NUMBER, '+12125550100'] };
    const sf = readOnlyOrg();
    const deps = { db, clients: async () => sf.client, cti: cti.cti, now: NOW, log: quiet, defaultSpecialists: [GRANT] };
    const ctx = ctxOf(base.orgId, admin, true);
    return { base, admin, lead, cti, sf, deps, ctx };
  }
  const practiceRows = (enrollmentId: string) => db.select().from(schema.aiPracticeCalls).where(eq(schema.aiPracticeCalls.enrollmentId, enrollmentId));
  const count = async (table: string) => Number(((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);

  it('1: an approved plan and a listed number trigger a practice target with the rendered plan text, under a practice: key, stored with its ai call', async () => {
    const s = await setup();
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: '(512) 555-0111' });
    if (!res.ok) throw new Error(`refused: ${res.error}`);
    expect(res.response.result).toBe('placed');
    const [req] = s.cti.requests;
    expect(req).toMatchObject({ orgId: s.base.orgId, userId: s.admin });
    expect(req!.idempotencyKey).toMatch(/^practice:[0-9a-f-]{36}$/);
    expect(req!.target).toMatchObject({ kind: 'practice', objectType: 'Lead', recordId: s.lead.sfRecordId, to: TEST_NUMBER, context: { returning: false } });
    if (req!.target.kind !== 'practice') throw new Error('not a practice target');
    expect(req!.target.planText).toContain('Opener: Ask whether the family has decided');
    const [row] = await practiceRows(s.lead.enrollmentId);
    expect(row).toMatchObject({
      orgId: s.base.orgId, campaignId: s.base.campaignId, callPlanId: s.lead.planId, planVersion: 1, requestedBy: s.admin,
      toE164: TEST_NUMBER, idempotencyKey: req!.idempotencyKey, aiCallId: res.response.aiCallId, result: res.response,
    });
  });

  it('2: a proposed plan works too (practice never approves it)', async () => {
    const s = await setup({ planStatus: 'proposed' });
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(res.ok).toBe(true);
    const [plan] = await db.select().from(schema.callPlans).where(eq(schema.callPlans.id, s.lead.planId!));
    expect(plan!.status).toBe('proposed');
  });

  it('3: a rejected plan\'s version, or a version that does not exist, is no_plan', async () => {
    const s = await setup();
    expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 2, to: TEST_NUMBER })).toEqual({ ok: false, error: 'no_plan' });
    await db.update(schema.callPlans).set({ status: 'rejected' }).where(eq(schema.callPlans.id, s.lead.planId!));
    expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'no_plan' });
    expect(s.cti.requests).toHaveLength(0);
  });

  it('4: plan text the voice agent cannot be given ("300k") is plan_text_rejected with its words, and nothing is triggered or stored', async () => {
    const s = await setup({ planOver: { opener: 'Ask whether 300k still works for them.' } });
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(res).toEqual({ ok: false, error: 'plan_text_rejected', words: ['the opener: a price or an amount'] });
    expect(s.cti.requests).toHaveLength(0);
    expect(await practiceRows(s.lead.enrollmentId)).toHaveLength(0);
  });

  it('5: a number not on the test list is not_a_test_number; cti-api not answering is cti_unreachable', async () => {
    const s = await setup();
    expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: '+16195550123' })).toEqual({ ok: false, error: 'not_a_test_number' });
    s.cti.available = null;
    expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
    expect(s.cti.requests).toHaveLength(0);
  });

  it('5b: another tenant\'s enrollment is not_found; a sequence campaign\'s is not_ai_call_campaign', async () => {
    const s = await setup();
    const other = await setup();
    expect(await startPractice(s.deps, s.ctx, other.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'not_found' });
    const seqCampaign = await seedCampaign(db, s.base.orgId, { mode: 'sequence', status: 'active' });
    const rec = await seedRecord(db, s.base.orgId, snapshot({ sfRecordId: '00Q8X00000Seq01AAA' }));
    const enr = await seedEnrollment(db, s.base.orgId, seqCampaign.id, rec, {});
    expect(await startPractice(s.deps, s.ctx, enr, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'not_ai_call_campaign' });
  });

  it('5c: a transport failure is cti_unreachable and the row keeps a null result', async () => {
    const s = await setup();
    s.cti.answers.push({ transport: 'timeout' });
    expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
    const [row] = await practiceRows(s.lead.enrollmentId);
    expect(row).toMatchObject({ result: null, aiCallId: null });
  });

  // Final review WEB I-2: booking is off until an admin turns it on; these tenants have.
  const BOOKING_ON = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] } };

  it('final review WEB I-2: a tenant that never turned booking on gets no times, even with a default owner configured', async () => {
    const s = await setup();
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(s.cti.requests[0]!.target).not.toHaveProperty('slots');
  });

  it('6: with booking active the trigger carries the owner\'s free times, read only', async () => {
    const s = await setup({ settings: BOOKING_ON });
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const target = s.cti.requests[0]!.target;
    if (target.kind !== 'practice') throw new Error('not a practice target');
    expect(target.slots?.length).toBeGreaterThan(0);
    expect(target.slots!.every((slot) => slot.specialistSfUserId === GRANT)).toBe(true);
    expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
  });

  it('P6 M-1: a time another real AI call already booked with the owner is not offered (as the pacer does)', async () => {
    const s = await setup({ settings: BOOKING_ON });
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const first = s.cti.requests[0]!.target;
    if (first.kind !== 'practice' || !first.slots?.length) throw new Error('no slots offered');
    const taken = first.slots[0]!;
    await seedAiCall(db, s.base.orgId, s.admin, {
      status: 'in_progress', outcome: 'appointment_set', endedAt: null,
      appointment: { ...PHONE_BOOKING, slotId: taken.id, kind: taken.kind, start: taken.start, end: taken.end, specialistSfUserId: GRANT },
    });
    // The first practice call has ended (one at a time per admin, final review).
    await db.update(schema.aiCalls).set({ status: 'completed' }).where(eq(schema.aiCalls.startedBy, s.admin));
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const again = s.cti.requests[1]!.target;
    if (again.kind !== 'practice') throw new Error('not a practice target');
    expect(again.slots?.map((slot) => slot.start)).not.toContain(taken.start);
    expect(again.slots?.length).toBeGreaterThan(0);
  });

  describe('final review: one practice call at a time per admin (a double click never rings twice)', () => {
    it('two starts at once: one rings, the other is practice_in_progress', async () => {
      const s = await setup();
      const both = await Promise.all([1, 2].map(() => startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })));
      expect(both.filter((r) => r.ok)).toHaveLength(1);
      expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, error: 'practice_in_progress' }]);
      expect(s.cti.requests).toHaveLength(1);
      expect(await practiceRows(s.lead.enrollmentId)).toHaveLength(1);
    });

    it('a practice call still live blocks the next; once it has ended the next one goes', async () => {
      const s = await setup();
      expect((await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).ok).toBe(true);
      const later = { ...s.deps, now: new Date(NOW.getTime() + 5 * 60_000) };
      expect(await startPractice(later, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'practice_in_progress' });
      await db.update(schema.aiCalls).set({ status: 'completed' }).where(eq(schema.aiCalls.startedBy, s.admin));
      expect((await startPractice(later, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).ok).toBe(true);
    });

    it('a start whose answer never came blocks for two minutes, then not; another admin is never blocked', async () => {
      const s = await setup();
      s.cti.answers.push({ transport: 'timeout' });
      expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
      const soon = { ...s.deps, now: new Date(NOW.getTime() + 60_000) };
      expect(await startPractice(soon, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'practice_in_progress' });
      const other = await seedUser(db, s.base.orgId);
      expect((await startPractice(soon, ctxOf(s.base.orgId, other, true), s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).ok).toBe(true);
      const after = { ...s.deps, now: new Date(NOW.getTime() + 3 * 60_000) };
      expect((await startPractice(after, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).ok).toBe(true);
    });
  });

  it('6b: booking off sends no slots; a Salesforce failure sends none and the call still goes', async () => {
    const s = await setup({ settings: { aiCallBooking: { enabled: false, specialists: [GRANT], convertLeads: true, days: [1, 2, 3, 4, 5], phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 }, walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 } } } });
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(s.cti.requests[0]!.target).not.toHaveProperty('slots');
    const t = await setup();
    const res = await startPractice({ ...t.deps, clients: async () => { throw new Error('not connected'); } }, t.ctx, t.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(res.ok).toBe(true);
    expect(t.cti.requests[0]!.target).not.toHaveProperty('slots');
  });

  it('7: listPracticeCalls is newest first, at most 20, joined to the call (status, outcome, summary, appointment); drifted JSON reads as null', async () => {
    const s = await setup();
    const callId = await seedAiCall(db, s.base.orgId, s.admin, { isTest: true, practice: true, status: 'completed', outcome: 'appointment_set', summary: 'Booked a call with Grant.', appointment: PHONE_BOOKING });
    const drifted = await seedAiCall(db, s.base.orgId, s.admin, { isTest: true, practice: true, status: 'completed', appointment: { slotId: 'zz' } });
    for (let i = 0; i < 22; i += 1) {
      const aiCallId = i === 21 ? callId : i === 20 ? drifted : null;
      await db.insert(schema.aiPracticeCalls).values({
        orgId: s.base.orgId, campaignId: s.base.campaignId, enrollmentId: s.lead.enrollmentId, callPlanId: s.lead.planId, planVersion: 1, aiCallId,
        requestedBy: s.admin, toE164: TEST_NUMBER, idempotencyKey: `practice:${i}`, createdAt: new Date(NOW.getTime() + i * 1000),
        result: i === 20 ? { result: 'nonsense' } : aiCallId ? { result: 'placed', aiCallId } : null,
      });
    }
    const other = await setup();
    await startPractice(other.deps, other.ctx, other.lead.enrollmentId, { version: 1, to: TEST_NUMBER });

    const res = await listPracticeCalls(db, s.base.orgId, s.base.campaignId);
    expect(PracticeCallsResponse.parse(res)).toEqual(res);
    expect(res.items).toHaveLength(20);
    expect(res.items[0]).toMatchObject({
      enrollmentId: s.lead.enrollmentId, name: 'Pat Seller', sfObject: 'Lead', sfRecordId: s.lead.sfRecordId, planVersion: 1, aiCallId: callId,
      callStatus: 'completed', outcome: 'appointment_set', summary: 'Booked a call with Grant.', appointment: PHONE_BOOKING,
      result: { result: 'placed', aiCallId: callId }, createdAt: new Date(NOW.getTime() + 21_000).toISOString(),
    });
    expect(res.items[1]).toMatchObject({ aiCallId: drifted, appointment: null, result: null });
    expect(res.items.at(-1)!.createdAt).toBe(new Date(NOW.getTime() + 2_000).toISOString());
  });

  it('8 and 9: a practice call that booked never makes a touch or a write-back, and Salesforce only ever sees the offer\'s reads', async () => {
    const s = await setup();
    const touchesBefore = await count('touches');
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    if (!res.ok || res.response.result !== 'placed') throw new Error('not placed');
    // What cti-api writes for a practice call that booked: is_test + practice, the record, the stored appointment.
    await db.update(schema.aiCalls)
      .set({ isTest: true, practice: true, sfObject: 'Lead', sfRecordId: s.lead.sfRecordId, status: 'completed', outcome: 'appointment_set', appointment: PHONE_BOOKING, endedAt: NOW })
      .where(eq(schema.aiCalls.id, res.response.aiCallId));

    await collectAiCallResults(db, NOW, quiet);
    await runWritebacks(depsFor(db, s.sf, { now: NOW }));

    expect(await count('touches')).toBe(touchesBefore);
    expect(await db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.aiCallId, res.response.aiCallId))).toEqual([]);
    expect(s.sf.creates).toEqual([]);
    expect(s.sf.updates).toEqual([]);
    expect(s.sf.soapBodies).toEqual([]);
    expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
    expect(s.sf.soql.every((q) => /^SELECT .* FROM (User|Event) /.test(q))).toBe(true);

    // Belt and braces (Task 26): even a write-back row a bug enqueued for it is skipped before any Salesforce request.
    const requestsBefore = s.sf.log.length;
    await db.insert(schema.aiCallWritebacks).values({ orgId: s.base.orgId, aiCallId: res.response.aiCallId, sfObject: 'Lead', sfRecordId: s.lead.sfRecordId, outcome: 'appointment_set', nextAttemptAt: NOW });
    await runWritebacks(depsFor(db, s.sf, { now: NOW }));
    const [wb] = await db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.aiCallId, res.response.aiCallId));
    expect(wb).toMatchObject({ status: 'skipped' });
    expect(s.sf.log.length).toBe(requestsBefore);
  });

  it('10: cti-api refusing the plan (plan_rejected) is returned as it is and stored', async () => {
    const s = await setup();
    s.cti.answers.push({ result: 'failed', reason: 'plan_rejected' });
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(res).toEqual({ ok: true, response: { result: 'failed', reason: 'plan_rejected', aiCallId: null } });
    const [row] = await practiceRows(s.lead.enrollmentId);
    expect(row!.result).toEqual({ result: 'failed', reason: 'plan_rejected', aiCallId: null });
  });

  it('the transcript of a practice call: an admin of its tenant reads it, a rep is forbidden, another tenant gets nothing', async () => {
    const s = await setup();
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    if (!res.ok || res.response.result !== 'placed') throw new Error('not placed');
    const aiCallId = res.response.aiCallId;
    await db.update(schema.aiCalls).set({ isTest: true, practice: true, transcript: [{ role: 'agent', text: 'Hi Pat', at: null }] }).where(eq(schema.aiCalls.id, aiCallId));
    const rep = await seedUser(db, s.base.orgId);
    expect(await loadTranscript(db, s.ctx, aiCallId)).toEqual({ aiCallId, lines: [{ role: 'agent', text: 'Hi Pat', at: null }] });
    expect(await loadTranscript(db, ctxOf(s.base.orgId, rep, false), aiCallId)).toBe('forbidden');
    const other = await setup();
    expect(await loadTranscript(db, other.ctx, aiCallId)).toBeNull();
  });

  it('P6 M-10: cti-api placed the call but its answer was lost: the list and the transcript find the call by the practice key', async () => {
    const s = await setup();
    s.cti.answers.push({ lostPlaced: true, createdAt: NOW });
    expect(await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
    const [row] = await practiceRows(s.lead.enrollmentId);
    expect(row).toMatchObject({ result: null, aiCallId: null });
    const [request] = await db.select().from(schema.aiCallRequests).where(eq(schema.aiCallRequests.idempotencyKey, row!.idempotencyKey));
    const aiCallId = request!.aiCallId!;
    await db.update(schema.aiCalls).set({ isTest: true, practice: true, transcript: [{ role: 'agent', text: 'Hi Pat', at: null }] }).where(eq(schema.aiCalls.id, aiCallId));

    const [item] = (await listPracticeCalls(db, s.base.orgId, s.base.campaignId)).items;
    expect(item).toMatchObject({ aiCallId, callStatus: 'queued', result: { result: 'placed', aiCallId } });
    expect(await loadTranscript(db, s.ctx, aiCallId)).toEqual({ aiCallId, lines: [{ role: 'agent', text: 'Hi Pat', at: null }] });
    const other = await setup();
    expect(await loadTranscript(db, other.ctx, aiCallId)).toBeNull();
  });
});

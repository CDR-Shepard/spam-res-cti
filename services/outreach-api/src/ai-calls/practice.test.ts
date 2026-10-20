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
import { BLAKE, CHANCE, fakeMaps, SD_LEAD_ADDRESS, SETH, THOMAS, USERS, usersWithInactive } from '../test/fake-offer.js';
import { fakeCti } from '../test/fake-pace.js';
import { fakeSfWrites, type FakeSfWrites } from '../test/fake-sf-writes.js';
import { rowsWhere } from '../test/fake-soql-where.js';
import { seedCampaign, seedEnrollment, seedRecord, snapshot } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { depsFor, GRANT, PHONE_BOOKING, quiet } from '../test/writeback-harness.js';

const TEST_NUMBER = '+15125550111';
/** Tue Oct 6, 9:00 AM PT: the San Diego region leaves free times today and on the next days. */
const NOW = new Date('2026-10-06T16:00:00.000Z');
const SD_REPS = [SETH, THOMAS];

type Row = Record<string, unknown>;
interface OrgOptions {
  users?: Row[];
  consultations?: Row[];
}

/**
 * A Salesforce org that answers only the offer's reads (the reps' User rows and calendars, the seller's consultations and
 * the property address of a made-up San Diego Lead) and records every request.
 */
function readOnlyOrg(o: OrgOptions = {}): FakeSfWrites {
  return fakeSfWrites({
    queries: [
      [/Subject LIKE '%Consultation%'/, o.consultations ?? []],
      [/^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/, (q: string) => rowsWhere(q, o.users ?? USERS)],
      [/^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate, OwnerId, Location, Subject FROM Event/, []],
      [/ FROM Lead WHERE Id = /, [{ Name: 'Pat Seller', OwnerId: '005000000000001AAA', IsConverted: false, ...SD_LEAD_ADDRESS }]],
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

  async function setup(o: { planStatus?: 'proposed' | 'approved'; planOver?: PlanLeadOptions['planOver']; settings?: Record<string, unknown> } & OrgOptions = {}) {
    const base = await seedAiCallCampaign(db, 'active');
    if (o.settings) await db.update(schema.organizations).set({ settings: o.settings }).where(eq(schema.organizations.id, base.orgId));
    const admin = await seedUser(db, base.orgId);
    const lead = await seedPlanLead(db, base, { planStatus: o.planStatus ?? 'approved', approvedBy: admin, ...(o.planOver ? { planOver: o.planOver } : {}) });
    const cti = fakeCti(db);
    cti.available = { available: true, testNumbers: [TEST_NUMBER, '+12125550100'] };
    const sf = readOnlyOrg(o);
    const deps = { db, clients: async () => sf.client, cti: cti.cti, now: NOW, log: quiet, defaultSpecialists: [GRANT], maps: fakeMaps().maps };
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

  it("5a (final review I-1): a phone only on the org's own Test phones list is a test number, asked for this org", async () => {
    const s = await setup();
    const listed = '+16195550142';
    s.cti.orgTestPhones.set(s.base.orgId, [listed]);
    const res = await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: '(619) 555-0142' });
    expect(res.ok).toBe(true);
    expect(s.cti.availabilityOrgs).toEqual([s.base.orgId]);
    expect(s.cti.requests[0]!.target).toMatchObject({ kind: 'practice', to: listed });
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

  // Booking and write-back both on (fix 2: booking needs write-back).
  const BOOKING_ON = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] }, aiCallWriteback: true };

  it('fix 2: a tenant that never turned booking on still hears the region\'s times, and nothing is written', async () => {
    const s = await setup();
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const target = s.cti.requests[0]!.target;
    if (target.kind !== 'practice') throw new Error('not a practice target');
    expect(target.slots?.length).toBeGreaterThan(0);
    expect(target.slots!.every((slot) => slot.region === 'SD' && SD_REPS.includes(slot.specialistSfUserId))).toBe(true);
    expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
  });

  it('6: with booking active the trigger carries the region\'s free times, read only', async () => {
    const s = await setup({ settings: BOOKING_ON });
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const target = s.cti.requests[0]!.target;
    if (target.kind !== 'practice') throw new Error('not a practice target');
    expect(target.slots?.length).toBeGreaterThan(0);
    expect(target.slots!.every((slot) => slot.region === 'SD' && SD_REPS.includes(slot.specialistSfUserId))).toBe(true);
    expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
  });

  it('6a: the trigger carries the seller\'s consultations, read from the lead and the records its research found, and Grant\'s high-priority offer', async () => {
    const contact = '0038X00000BcdeFQAR';
    const s = await setup({ consultations: [{ StartDateTime: '2026-03-12T17:00:00.000+0000', Subject: 'Phone Consultation', Owner: { Name: 'Blake Person' } }] });
    const [plan] = await db.select({ researchId: schema.callPlans.researchId }).from(schema.callPlans).where(eq(schema.callPlans.id, s.lead.planId!));
    const [research] = await db.select({ snapshot: schema.callResearch.snapshot }).from(schema.callResearch).where(eq(schema.callResearch.id, plan!.researchId));
    const snapshot = research!.snapshot as { records: Row[] };
    const records = [...snapshot.records, { relation: 'converted_contact', sfObject: 'Contact', id: contact, role: null, fields: [] }];
    await db.update(schema.callResearch).set({ snapshot: { ...snapshot, records } }).where(eq(schema.callResearch.id, plan!.researchId));

    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const target = s.cti.requests[0]!.target;
    if (target.kind !== 'practice') throw new Error('not a practice target');
    expect(target.context).toEqual({
      returning: false,
      consultations: { last: { start: '2026-03-12T17:00:00.000Z', kind: 'phone', ownerName: 'Blake Person' }, next: null },
    });
    // Wednesday 09:00 PDT: the next booking day after Tuesday.
    expect(target.priority).toEqual({ specialistSfUserId: GRANT, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-07T16:00:00.000Z' });
    const consultationsRead = s.sf.soql.find((q) => /Subject LIKE '%Consultation%'/.test(q))!;
    expect(consultationsRead).toContain(s.lead.sfRecordId);
    expect(consultationsRead).toContain(contact);
  });

  it('P6 M-1: a time another real AI call already booked with a rep is not offered with that rep (as the pacer does)', async () => {
    // San Diego with one active rep (Seth), so a time he is booked for has nobody else to take it.
    const s = await setup({ settings: BOOKING_ON, users: usersWithInactive(THOMAS) });
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    const first = s.cti.requests[0]!.target;
    if (first.kind !== 'practice' || !first.slots?.length) throw new Error('no slots offered');
    const taken = first.slots[0]!;
    await seedAiCall(db, s.base.orgId, s.admin, {
      status: 'in_progress', outcome: 'appointment_set', endedAt: null,
      appointment: { ...PHONE_BOOKING, slotId: taken.id, kind: taken.kind, start: taken.start, end: taken.end, specialistSfUserId: taken.specialistSfUserId },
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

  it('6b: whatever the toggles, no active rep and no high-priority rep sends no slots or priority; a Salesforce failure sends none and the call still goes', async () => {
    const emptyList = { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [] as string[] }, aiCallWriteback: true };
    const s = await setup({ settings: emptyList, users: usersWithInactive(CHANCE, BLAKE, SETH, THOMAS) });
    await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(s.cti.requests[0]!.target).not.toHaveProperty('slots');
    expect(s.cti.requests[0]!.target).not.toHaveProperty('priority');
    expect(s.sf.soql.filter((q) => / FROM Event WHERE OwnerId /.test(q))).toEqual([]);
    const t = await setup();
    const res = await startPractice({ ...t.deps, clients: async () => { throw new Error('not connected'); } }, t.ctx, t.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
    expect(res.ok).toBe(true);
    expect(t.cti.requests[0]!.target).not.toHaveProperty('slots');
    expect(t.cti.requests[0]!.target).not.toHaveProperty('priority');
    expect(t.cti.requests[0]!.target).toMatchObject({ context: { returning: false } });
    expect(t.cti.requests[0]!.target).not.toHaveProperty('context.consultations');
  });

  it('6c: booking ticked off, or on with write-back off, still offers times (a practice call never books)', async () => {
    for (const settings of [
      { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: false, specialists: [GRANT] } },
      { aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] }, aiCallWriteback: false },
    ]) {
      const s = await setup({ settings });
      await startPractice(s.deps, s.ctx, s.lead.enrollmentId, { version: 1, to: TEST_NUMBER });
      const target = s.cti.requests[0]!.target;
      if (target.kind !== 'practice') throw new Error('not a practice target');
      expect(target.slots?.length).toBeGreaterThan(0);
      expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
    }
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
    expect(s.sf.soql.every((q) => /^SELECT .* FROM (User|Event|Lead) /.test(q))).toBe(true);

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
    expect(await loadTranscript(db, s.ctx, aiCallId)).toEqual({ aiCallId, lines: [{ role: 'agent', text: 'Hi Pat', at: null }], turnStats: null });
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
    expect(await loadTranscript(db, s.ctx, aiCallId)).toEqual({ aiCallId, lines: [{ role: 'agent', text: 'Hi Pat', at: null }], turnStats: null });
    const other = await setup();
    expect(await loadTranscript(db, other.ctx, aiCallId)).toBeNull();
  });
});

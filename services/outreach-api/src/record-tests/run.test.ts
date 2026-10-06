/**
 * Real Postgres: running a Test a record call (plan 1E Task 8), to an admin's test number (a 1D practice target) or to the
 * admin's own browser (practice_browser). Only the admin's own number or identity is ever sent (G-3), only checked plan text
 * reaches the trigger (G-5), and a test call that booked leaves no touch, write-back or Salesforce write (G-2, G-6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { RecordTestCall, type CallPlan } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { collectAiCallResults } from '../ai-calls/results.js';
import { runWritebacks } from '../writeback/run.js';
import { ctxOf, seedUser } from '../test/call-plan-seed.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { fakeCti } from '../test/fake-pace.js';
import { fakeSfWrites } from '../test/fake-sf-writes.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { RT_LEAD } from '../test/record-test-org.js';
import { depsFor, GRANT, PHONE_BOOKING, quiet } from '../test/writeback-harness.js';
import { startRecordTestCall } from './run.js';
import { insertRecordTest, loadRecordTestCalls } from './store.js';

const TEST_NUMBER = '+15125550111';
/** Tue Oct 6, 9:00 AM PT: the default phone hours leave free times today and tomorrow. */
const NOW = new Date('2026-10-06T16:00:00.000Z');
/** The slots cti-api stored on the call (ai_calls.offered_slots): the booked one names its specialist. */
const OFFERED = [{ id: 'p1', kind: 'phone', start: PHONE_BOOKING.start, end: PHONE_BOOKING.end, specialistSfUserId: GRANT, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles' }];
const identityOf = (userId: string, nonce = 'a1b2c3d4e5f6') => `aitest_${userId.replace(/-/g, '')}_${nonce}`;

function readOnlyOrg() {
  return fakeSfWrites({
    queries: [
      [/^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles' }]],
      [/^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event/, []],
    ],
  });
}

describe.skipIf(!pgLane)('running a record test call (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup(o: { status?: 'running' | 'ready' | 'failed'; plan?: CallPlan; settings?: Record<string, unknown> } = {}) {
    const orgId = await seedOrg(db, o.settings ?? {});
    const admin = await seedUser(db, orgId);
    const testId = await insertRecordTest(db, { orgId, requestedBy: admin, sfObject: 'Lead', sfRecordId: RT_LEAD });
    await db.update(schema.aiRecordTests)
      .set({ status: o.status ?? 'ready', plan: o.plan ?? validPlan, planText: 'stored text is never sent', name: 'Pat Seller', completedAt: NOW })
      .where(eq(schema.aiRecordTests.id, testId));
    const cti = fakeCti(db);
    cti.available = { available: true, testNumbers: [TEST_NUMBER], browserCalls: true };
    const sf = readOnlyOrg();
    const deps = { db, clients: async () => sf.client, cti: cti.cti, now: NOW, log: quiet, defaultSpecialists: [GRANT] };
    // As requireContext builds it: the tenant is the org row, settings included.
    const [tenant] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    return { orgId, admin, testId, cti, sf, deps, ctx: { ...ctxOf(orgId, admin, true), tenant: tenant! } };
  }
  const callRows = (testId: string) => db.select().from(schema.aiRecordTestCalls).where(eq(schema.aiRecordTestCalls.recordTestId, testId));
  const count = async (table: string) => Number(((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n);

  it('1: a listed number triggers a practice target with the freshly rendered plan text under an rtest: key; the row keeps the call', async () => {
    const s = await setup();
    const res = await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: '(512) 555-0111' });
    if (!('ok' in res) || !res.ok) throw new Error(`refused: ${JSON.stringify(res)}`);
    const [req] = s.cti.requests;
    expect(req).toMatchObject({ orgId: s.orgId, userId: s.admin });
    expect(req!.idempotencyKey).toMatch(/^rtest:[0-9a-f-]{36}$/);
    expect(req!.target).toMatchObject({ kind: 'practice', objectType: 'Lead', recordId: RT_LEAD, to: TEST_NUMBER, context: { returning: false } });
    if (req!.target.kind !== 'practice') throw new Error('not a practice target');
    expect(req!.target.planText).toContain('Opener: Ask whether the family has decided');
    expect(req!.target.planText).not.toContain('stored text');
    const [row] = await callRows(s.testId);
    expect(row).toMatchObject({
      id: res.callId, orgId: s.orgId, requestedBy: s.admin, mode: 'phone', toE164: TEST_NUMBER, clientIdentity: null,
      idempotencyKey: req!.idempotencyKey, aiCallId: res.response.aiCallId, result: res.response, createdAt: NOW,
    });
  });

  it('2: the admin\'s own browser identity triggers practice_browser with that identity and no number', async () => {
    const s = await setup();
    const identity = identityOf(s.admin);
    const res = await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'browser', identity });
    expect('ok' in res && res.ok).toBe(true);
    const target = s.cti.requests[0]!.target;
    expect(target).toMatchObject({ kind: 'practice_browser', objectType: 'Lead', recordId: RT_LEAD, clientIdentity: identity });
    expect(target).not.toHaveProperty('to');
    const [row] = await callRows(s.testId);
    expect(row).toMatchObject({ mode: 'browser', clientIdentity: identity, toE164: null });
  });

  it('3 (G-5): a stored plan that no longer renders ("300k") is plan_text_rejected with its words; nothing is triggered or stored', async () => {
    const s = await setup({ plan: { ...validPlan, opener: 'Ask whether 300k still works for them.' } });
    const res = await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER });
    expect(res).toEqual({ ok: false, error: 'plan_text_rejected', words: ['the opener: a price or an amount'] });
    expect(s.cti.requests).toHaveLength(0);
    expect(await callRows(s.testId)).toHaveLength(0);
  });

  it('4 (G-3): a number not on the test list is not_a_test_number; cti-api not answering is cti_unreachable; nothing is triggered', async () => {
    const s = await setup();
    expect(await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: '+16195550123' })).toEqual({ ok: false, error: 'not_a_test_number' });
    s.cti.available = null;
    expect(await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
    expect(s.cti.requests).toHaveLength(0);
    expect(await callRows(s.testId)).toHaveLength(0);
  });

  it("5 (G-3): another admin's browser identity is not_your_browser; nothing is triggered", async () => {
    const s = await setup();
    const other = await seedUser(db, s.orgId);
    expect(await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'browser', identity: identityOf(other) })).toEqual({ ok: false, error: 'not_your_browser' });
    expect(s.cti.requests).toHaveLength(0);
    expect(await callRows(s.testId)).toHaveLength(0);
  });

  it('6: a running or failed preview is not_ready', async () => {
    for (const status of ['running', 'failed'] as const) {
      const s = await setup({ status });
      expect(await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER })).toEqual({ ok: false, error: 'not_ready' });
      expect(s.cti.requests).toHaveLength(0);
    }
  });

  it("7 (G-8): another tenant's test is not_found", async () => {
    const a = await setup();
    const b = await setup();
    expect(await startRecordTestCall(b.deps, b.ctx, a.testId, { mode: 'phone', to: TEST_NUMBER })).toEqual({ ok: false, error: 'not_found' });
    expect(b.cti.requests).toHaveLength(0);
  });

  it("8: with booking on the trigger carries the owner's free times, read only; booking off sends none", async () => {
    const s = await setup();
    await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'browser', identity: identityOf(s.admin) });
    const target = s.cti.requests[0]!.target;
    if (target.kind !== 'practice_browser') throw new Error('not a browser target');
    expect(target.slots?.length).toBeGreaterThan(0);
    expect(target.slots!.every((slot) => slot.specialistSfUserId === GRANT)).toBe(true);
    expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
    const booking = {
      enabled: false, specialists: [GRANT], convertLeads: true, days: [1, 2, 3, 4, 5],
      phone: { enabled: true, durationMinutes: 15, startHour: 10, endHour: 18, stepMinutes: 30, minLeadMinutes: 120, horizonBusinessDays: 2, bufferMinutes: 0, maxOffered: 6 },
      walkthrough: { enabled: true, durationMinutes: 60, startHour: 9, endHour: 17, stepMinutes: 60, minLeadMinutes: 1200, horizonBusinessDays: 5, bufferMinutes: 30, maxOffered: 6 },
    };
    const off = await setup({ settings: { aiCallBooking: booking } });
    await startRecordTestCall(off.deps, off.ctx, off.testId, { mode: 'phone', to: TEST_NUMBER });
    expect(off.cti.requests[0]!.target).not.toHaveProperty('slots');
  });

  it('9: a transport failure (or a 409) is cti_unreachable and the row keeps a null result', async () => {
    const s = await setup();
    s.cti.answers.push({ transport: 'timeout' });
    expect(await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
    expect((await callRows(s.testId))[0]).toMatchObject({ result: null, aiCallId: null });
    const c = await setup();
    c.cti.answers.push({ conflict: true });
    expect(await startRecordTestCall(c.deps, c.ctx, c.testId, { mode: 'phone', to: TEST_NUMBER })).toEqual({ ok: false, error: 'cti_unreachable' });
  });

  it('a limit refusal is returned and inserts nothing: a second call while the first is live is CALL_IN_PROGRESS', async () => {
    const s = await setup();
    await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER });
    const again = await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'browser', identity: identityOf(s.admin) });
    expect(again).toEqual({ ok: false, refusal: { code: 'CALL_IN_PROGRESS' } });
    expect(s.cti.requests).toHaveLength(1);
    expect(await callRows(s.testId)).toHaveLength(1);
  });

  it('10 (G-2, G-6): a test call that booked makes no touch or write-back, and Salesforce only ever sees the offer\'s reads', async () => {
    for (const mode of ['phone', 'browser'] as const) {
      const s = await setup();
      const touchesBefore = await count('touches');
      const res = await startRecordTestCall(s.deps, s.ctx, s.testId, mode === 'phone' ? { mode, to: TEST_NUMBER } : { mode, identity: identityOf(s.admin) });
      if (!('ok' in res) || !res.ok || res.response.result !== 'placed') throw new Error('not placed');
      // What cti-api writes for a test call that booked: is_test + practice, the record, the stored appointment.
      await db.update(schema.aiCalls)
        .set({ isTest: true, practice: true, sfObject: 'Lead', sfRecordId: RT_LEAD, status: 'completed', outcome: 'appointment_set', appointment: PHONE_BOOKING, endedAt: NOW })
        .where(eq(schema.aiCalls.id, res.response.aiCallId));
      await collectAiCallResults(db, NOW, quiet);
      await runWritebacks(depsFor(db, s.sf, { now: NOW }));
      expect(await count('touches')).toBe(touchesBefore);
      expect(await db.select().from(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.aiCallId, res.response.aiCallId))).toEqual([]);
      expect(s.sf.creates).toEqual([]);
      expect(s.sf.updates).toEqual([]);
      expect(s.sf.soapBodies).toEqual([]);
      expect(s.sf.log.every((entry) => entry === 'query')).toBe(true);
    }
  });

  it('11b: "with <name>" is null when the booked slot is not among the offered ones', async () => {
    const s = await setup();
    const res = await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER });
    if (!('ok' in res) || !res.ok || res.response.result !== 'placed') throw new Error('not placed');
    await db.update(schema.aiCalls)
      .set({ status: 'completed', outcome: 'appointment_set', appointment: { ...PHONE_BOOKING, slotId: 'p2' }, offeredSlots: OFFERED })
      .where(eq(schema.aiCalls.id, res.response.aiCallId));
    expect((await loadRecordTestCalls(db, s.orgId, s.testId))[0]!.appointmentWith).toBeNull();
  });

  it('11: loadRecordTestCalls is newest first, joined to the call; a lost answer is found through ai_call_requests', async () => {
    const s = await setup();
    const first = await startRecordTestCall(s.deps, s.ctx, s.testId, { mode: 'phone', to: TEST_NUMBER });
    if (!('ok' in first) || !first.ok || first.response.result !== 'placed') throw new Error('not placed');
    await db.update(schema.aiCalls)
      .set({ isTest: true, practice: true, status: 'completed', outcome: 'appointment_set', summary: 'Booked Grant.', durationSeconds: 95, appointment: PHONE_BOOKING, qualification: { timeline: '30 days', beds: 3 }, offeredSlots: OFFERED })
      .where(eq(schema.aiCalls.id, first.response.aiCallId));
    s.cti.answers.push({ lostPlaced: true, createdAt: NOW });
    const later = { ...s.deps, now: new Date(NOW.getTime() + 60_000) };
    expect(await startRecordTestCall(later, s.ctx, s.testId, { mode: 'browser', identity: identityOf(s.admin) })).toEqual({ ok: false, error: 'cti_unreachable' });

    const calls = await loadRecordTestCalls(db, s.orgId, s.testId);
    expect(calls).toHaveLength(2);
    for (const c of calls) RecordTestCall.parse(c);
    const [lost, placed] = calls;
    expect(lost).toMatchObject({ mode: 'browser', toE164: null, callStatus: 'queued', result: { result: 'placed' } });
    expect(lost!.aiCallId).toBe((lost!.result as { aiCallId: string }).aiCallId);
    // What cti-api would have written for the lost browser leg (E-3: the fake seeds it as cti-api does).
    const [lostRow] = await db.select().from(schema.aiCalls).where(eq(schema.aiCalls.id, lost!.aiCallId!));
    expect(lostRow).toMatchObject({ isTest: true, practice: true, sfObject: 'Lead', sfRecordId: RT_LEAD, toE164: expect.stringMatching(/^client:aitest_/) });
    expect(placed).toMatchObject({
      mode: 'phone', toE164: TEST_NUMBER, aiCallId: first.response.aiCallId, callStatus: 'completed', outcome: 'appointment_set',
      summary: 'Booked Grant.', durationSeconds: 95, appointment: PHONE_BOOKING, appointmentWith: 'Grant', qualification: { timeline: '30 days' }, dryRun: null,
    });
    expect(lost!.appointmentWith).toBeNull();
    expect(await loadRecordTestCalls(db, (await setup()).orgId, s.testId)).toEqual([]);
  });
});

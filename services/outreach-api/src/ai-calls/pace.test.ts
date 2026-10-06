/** Real Postgres: the `ai_call.place` tick with a fake CtiClient and a fake Salesforce. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AppointmentSlots, EditableCallPlan, type InternalAiCallRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError } from '@cti/salesforce';
import { enrollmentById, planById, seedAiCall, seedAiCallRequest, seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { CONSENT_FIELD, paceHarness } from '../test/fake-pace.js';
import { placeDueAiCalls } from './pace.js';
import { nextAttemptAt } from './pacing-rules.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { renderPlanForAgent } from './plan-text.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';

/** Monday 18:00 CDT: inside the plan fixture's `evening` window for a Texas number. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
/** Monday 14:00 CDT: outside `evening`, inside the calling window. */
const AFTERNOON = new Date('2026-10-05T19:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
/** The key a claim at `when` mints (I-1: the claim time keeps it unique when an attempt is given back). */
const keyOf = (touchId: string, attempt: number, when: Date = NOW) => `touch:${touchId}:${attempt}:${when.getTime()}`;
const planText = () => {
  const r = renderPlanForAgent(EditableCallPlan.parse(validPlan));
  if (!r.ok) throw new Error('the fixture plan must pass the agent text check');
  return r.text;
};

describe.skipIf(!pgLane)('placeDueAiCalls (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  it('1: two due touches with concurrency 2: two triggers carrying the approver, the touch key and the rendered plan; both sent', async () => {
    const h = await paceHarness(db);
    const a = await seedReleasedLead(db, h.base);
    const b = await seedReleasedLead(db, h.base);

    const counts = await h.run(NOW);

    expect(counts).toMatchObject({ placed: 2, retried: 0, failed: 0, deferred: 0, held: 0 });
    // Both are due at the same moment, so their order (due_at, then the random id) is not part of the test.
    expect(h.cti.requests).toHaveLength(2);
    expect(h.cti.requests).toEqual(
      expect.arrayContaining([a, b].map((l) => ({
        orgId: h.base.orgId,
        userId: l.approver,
        idempotencyKey: keyOf(l.touchId, 1),
        target: { kind: 'record', objectType: 'Lead', recordId: l.sfRecordId, planText: planText(), context: { returning: false } },
      }))),
    );
    for (const l of [a, b]) {
      const t = await touchById(db, l.touchId);
      expect(t).toMatchObject({ status: 'sent', sentAt: NOW, attempts: 1, triggerKey: null });
      expect(t.aiCallId).toEqual(expect.any(String));
    }
  });

  it('2: three due, concurrency 2, one call already live: one trigger this tick', async () => {
    const h = await paceHarness(db);
    const live = await seedReleasedLead(db, h.base);
    const aiCallId = await seedAiCall(db, h.base.orgId, live.approver, { status: 'ringing', createdAt: at(NOW, -MIN) });
    await db.update(schema.touches).set({ status: 'sent', aiCallId, sentAt: at(NOW, -MIN) }).where(eq(schema.touches.id, live.touchId));
    for (let i = 0; i < 3; i += 1) await seedReleasedLead(db, h.base);

    expect((await h.run(NOW)).placed).toBe(1);
    expect(h.cti.requests).toHaveLength(1);
  });

  it('3: a daily cap of 1 with one call placed in the last 24 hours: no trigger', async () => {
    const h = await paceHarness(db, { aiCallDailyCap: 1 });
    const done = await seedReleasedLead(db, h.base);
    const aiCallId = await seedAiCall(db, h.base.orgId, done.approver, { status: 'completed', createdAt: at(NOW, -3 * 60 * MIN) });
    await db.update(schema.touches).set({ status: 'sent', aiCallId, sentAt: at(NOW, -3 * 60 * MIN) }).where(eq(schema.touches.id, done.touchId));
    const waiting = await seedReleasedLead(db, h.base);

    await h.run(NOW);

    expect(h.cti.requests).toEqual([]);
    expect((await touchById(db, waiting.touchId)).status).toBe('planned');
    expect(h.logs.some((l) => l.msg === 'ai_call.place: daily AI call cap reached')).toBe(true);
  });

  it('4: outside the plan\'s evening window the first trigger waits for the opening; nothing claimed', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);

    expect((await h.run(AFTERNOON)).deferred).toBe(1);

    expect(h.cti.requests).toEqual([]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', dueAt: new Date('2026-10-05T22:00:00.000Z'), attempts: 0, lastBlockReason: 'outside_window' });
  });

  it('4b: a later trigger uses the whole calling window', async () => {
    const h = await paceHarness(db);
    await seedReleasedLead(db, h.base, { touch: { attempts: 1 } });
    expect((await h.run(AFTERNOON)).placed).toBe(1);
  });

  it('5: blocked no_consent: the touch fails and the enrollment exits ai_call_no_consent at done', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ result: 'blocked', reason: 'no_consent' });

    expect((await h.run(NOW)).failed).toBe(1);

    const t = await touchById(db, lead.touchId);
    expect(t).toMatchObject({ status: 'failed', lastBlockReason: 'no_consent', triggerKey: null });
    expect(t.aiCallId).toEqual(expect.any(String));
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'ai_call_no_consent', callStage: 'done' });
  });

  it('6: a transport failure plans the touch again with its key; the next trigger carries the SAME key', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ transport: 'timeout' });

    expect((await h.run(NOW)).retried).toBe(1);
    const t = await touchById(db, lead.touchId);
    // I-1: a transport failure is about the system, so its attempt is given back.
    expect(t).toMatchObject({ status: 'planned', triggerKey: keyOf(lead.touchId, 1), lastBlockReason: 'transport', attempts: 0 });

    await h.run(t.dueAt);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([keyOf(lead.touchId, 1), keyOf(lead.touchId, 1)]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('7: in_flight waits at least 10 minutes and retries with the same key', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ result: 'failed', reason: 'in_flight' });

    await h.run(NOW);
    const t = await touchById(db, lead.touchId);
    expect(t.dueAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(10 * MIN);
    await h.run(t.dueAt);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([keyOf(lead.touchId, 1), keyOf(lead.touchId, 1)]);
  });

  it('8: calling_hours retries at the window opening with a NEW key', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ result: 'blocked', reason: 'calling_hours' });

    await h.run(NOW);
    const t = await touchById(db, lead.touchId);
    expect(t).toMatchObject({ status: 'planned', triggerKey: null, lastBlockReason: 'calling_hours' });
    expect(t.dueAt).toEqual(at(NOW, 15 * MIN)); // inside our window, so the engine's refusal waits 15 minutes
    await h.run(t.dueAt);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([keyOf(lead.touchId, 1), keyOf(lead.touchId, 2, t.dueAt)]);
  });

  it('M-2: twilio_error (the carrier may have taken the call) waits like no answer: the next calling window 20+ hours on, with a new key', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ result: 'failed', reason: 'twilio_error' });

    expect((await h.run(NOW)).retried).toBe(1);

    expect(await touchById(db, lead.touchId)).toMatchObject({
      status: 'planned', dueAt: nextAttemptAt('+15125550100', NOW), triggerKey: null, lastBlockReason: 'twilio_error', attempts: 1,
    });
    expect((await touchById(db, lead.touchId)).dueAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(20 * 60 * MIN);
  });

  it('M-3: a 409 idempotency conflict drops the key: the retry goes once with a NEW key and is placed', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ conflict: true });

    expect((await h.run(NOW)).retried).toBe(1);
    const t = await touchById(db, lead.touchId);
    expect(t).toMatchObject({ status: 'planned', triggerKey: null, lastBlockReason: 'idempotency_conflict', attempts: 1 });
    expect(t.dueAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(10 * MIN);

    expect((await h.run(t.dueAt)).placed).toBe(1);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([keyOf(lead.touchId, 1), keyOf(lead.touchId, 2, t.dueAt)]);
  });

  describe('round 2 I-1: a 409 asks cti-api\'s request store what happened under the key before a new key is minted', () => {
    const EARLIER = at(NOW, -30 * MIN);

    it('a stored placed answer: the touch is sent and linked to that call, and no new trigger goes', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const aiCallId = await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: EARLIER });
      await seedAiCallRequest(db, { orgId: h.base.orgId, key: keyOf(lead.touchId, 1), userId: lead.approver, response: { result: 'placed', aiCallId }, createdAt: EARLIER });
      h.cti.answers.push({ conflict: true });

      expect((await h.run(NOW)).placed).toBe(1);

      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', aiCallId, triggerKey: null, attempts: 1 });
      await h.run(at(NOW, 60 * MIN));
      expect(h.cti.requests).toHaveLength(1);
    });

    it('a stale reservation with no answer and an ai_calls row since it: placed with that call, and no new trigger goes', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      await seedAiCallRequest(db, { orgId: h.base.orgId, key: keyOf(lead.touchId, 1), userId: lead.approver, createdAt: EARLIER });
      const aiCallId = await seedAiCall(db, h.base.orgId, lead.approver, { sfRecordId: lead.sfRecordId, createdAt: at(EARLIER, MIN), callSid: 'CA1' });
      h.cti.answers.push({ conflict: true });

      expect((await h.run(NOW)).placed).toBe(1);

      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', aiCallId, triggerKey: null });
      await h.run(at(NOW, 60 * MIN));
      expect(h.cti.requests).toHaveLength(1);
    });

    it('a stale reservation with no answer and no call: exactly one new key', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      await seedAiCallRequest(db, { orgId: h.base.orgId, key: keyOf(lead.touchId, 1), userId: lead.approver, createdAt: EARLIER });
      h.cti.answers.push({ conflict: true });

      expect((await h.run(NOW)).retried).toBe(1);
      const t = await touchById(db, lead.touchId);
      expect(t).toMatchObject({ status: 'planned', triggerKey: null, lastBlockReason: 'idempotency_conflict', attempts: 1 });

      expect((await h.run(t.dueAt)).placed).toBe(1);
      expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([keyOf(lead.touchId, 1), keyOf(lead.touchId, 2, t.dueAt)]);
    });

    it('a reservation still in flight: the key is kept and asked again once it can be stale (as in_flight)', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      await seedAiCallRequest(db, { orgId: h.base.orgId, key: keyOf(lead.touchId, 1), userId: lead.approver, createdAt: EARLIER, updatedAt: at(NOW, -MIN) });
      h.cti.answers.push({ conflict: true });

      expect((await h.run(NOW)).retried).toBe(1);

      const t = await touchById(db, lead.touchId);
      expect(t).toMatchObject({ status: 'planned', triggerKey: keyOf(lead.touchId, 1), lastBlockReason: 'in_flight', attempts: 1 });
      expect(t.dueAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(10 * MIN);
    });
  });

  it('9: a retryable failure on the eighth attempt gives up: exit ai_call_gave_up', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base, { touch: { attempts: 7 } });
    h.cti.answers.push({ result: 'failed', reason: 'twilio_error' });

    await h.run(NOW);

    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'failed', lastBlockReason: 'gave_up', attempts: 8 });
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'ai_call_gave_up' });
  });

  it('10: a pending do-not-contact flag holds the person; the touch is skipped and nothing is triggered', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    await db.insert(schema.recordTriage).values({
      orgId: h.base.orgId,
      crmRecordId: lead.crmRecordId,
      notesHash: 'h',
      model: 'm',
      result: { summary: 's', channels: [], timing: null, tags: [], doNotContact: { category: 'sold', quote: 'we sold it' } },
      inputTokens: 0,
      outputTokens: 0,
    });

    expect((await h.run(NOW)).held).toBe(1);

    expect(h.cti.requests).toEqual([]);
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'needs_review', reviewCategory: 'sold' });
    expect((await touchById(db, lead.touchId)).status).toBe('skipped');
  });

  it.each([
    ['Do Not Call', { DoNotCall: true }, 'ai_call_sf_do_not_call'],
    ['Skip on Dialer', { Skip_On_Dialer__c: true }, 'ai_call_skip_on_dialer'],
    ['the record gone', null, 'ai_call_record_not_found'],
  ] as const)('11: the fresh read shows %s: exit, no trigger', async (_label, over, reason) => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.sf.state.records.set(lead.sfRecordId, over);

    expect((await h.run(NOW)).failed).toBe(1);

    expect(h.cti.requests).toEqual([]);
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: reason, callStage: 'done' });
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'skipped', skipReason: reason });
  });

  it('12: a plan no longer approved since the release: touch skipped plan_not_approved, back to review, no trigger', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    await db.update(schema.callPlans).set({ status: 'proposed', decidedBy: null, decidedAt: null }).where(eq(schema.callPlans.id, lead.planId!));

    await h.run(NOW);

    expect(h.cti.requests).toEqual([]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'skipped', skipReason: 'plan_not_approved' });
    expect((await enrollmentById(db, lead.enrollmentId)).callStage).toBe('review');
  });

  it('13: a paused campaign\'s touches are not candidates', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    await db.update(schema.campaigns).set({ status: 'paused' }).where(eq(schema.campaigns.id, h.base.campaignId));

    await h.run(NOW);

    expect(h.cti.requests).toEqual([]);
    expect((await touchById(db, lead.touchId)).status).toBe('planned');
  });

  it.each([
    ['CrmNotConnectedError', () => new CrmNotConnectedError(), 'client'],
    ['SalesforceAuthError', () => new SalesforceAuthError(), 'query'],
  ] as const)('14: %s for the tenant: skipped, nothing claimed', async (_label, err, where) => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    if (where === 'client') h.failClients(err());
    else h.sf.state.error = err();

    await h.run(NOW);

    expect(h.cti.requests).toEqual([]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0 });
    expect(h.logs.some((l) => l.msg === 'ai_call.place: Salesforce unavailable for tenant; skipped')).toBe(true);
  });

  it('logs each trigger with the org, touch, attempt and result, never the plan text or a phone number', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    await h.run(NOW);
    expect(h.logs).toContainEqual({ level: 'info', obj: { orgId: h.base.orgId, touchId: lead.touchId, attempt: 1, result: 'placed' }, msg: 'ai_call.place: trigger answered' });
    const all = JSON.stringify(h.logs);
    expect(all).not.toContain('+1512');
    expect(all).not.toContain('Oak Street');
    expect((await planById(db, lead.planId!)).status).toBe('approved');
  });

  it.each<[string, unknown]>([
    ['false', false],
    ['unknown (empty)', null],
  ])('A5: the fresh Salesforce read says consent is %s: the enrollment exits ai_call_no_consent and nothing is triggered', async (_label, value) => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.sf.state.records.set(lead.sfRecordId, { [CONSENT_FIELD]: value });

    expect((await h.run(NOW)).failed).toBe(1);
    expect(h.cti.requests).toEqual([]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'skipped', attempts: 0 });
    expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'ai_call_no_consent', callStage: 'done' });
  });

  it('A4: one tenant whose tick throws is logged with its org id and the next tenant is still paced', async () => {
    const bad = await paceHarness(db);
    const good = await paceHarness(db);
    const badLead = await seedReleasedLead(db, bad.base);
    const goodLead = await seedReleasedLead(db, good.base);
    const clients = async (orgId: string) => {
      if (orgId === bad.base.orgId) throw new TypeError('a bug in the tick');
      if (orgId === good.base.orgId) return good.sf.client;
      throw new CrmNotConnectedError();
    };
    const counts = await placeDueAiCalls({ db, clients, cti: good.cti.cti, now: NOW, log: { info: () => {}, warn: () => {}, error: (obj: unknown, msg?: string) => good.logs.push({ level: 'error', obj, msg }) }, clock: () => 0 });

    expect(counts.placed).toBeGreaterThanOrEqual(1);
    expect((await touchById(db, goodLead.touchId)).status).toBe('sent');
    expect((await touchById(db, badLead.touchId)).status).toBe('planned');
    expect(good.logs).toContainEqual({ level: 'error', obj: { orgId: bad.base.orgId, errName: 'TypeError' }, msg: 'ai_call.place: the tick failed for this tenant; the next tenant goes on' });
  });

  it.each(['HTTP 401 bad_signature', 'HTTP 404', 'HTTP 503 internal_disabled', 'timeout', 'network', 'bad_response'])(
    'F1: a transport failure (%s) is logged with what went wrong, never the plan text or a phone number',
    async (error) => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ transport: error });
      await h.run(NOW);
      expect(h.logs).toContainEqual({
        level: 'info',
        obj: { orgId: h.base.orgId, touchId: lead.touchId, attempt: 1, result: 'retry:transport', transport: error },
        msg: 'ai_call.place: trigger answered',
      });
      expect(JSON.stringify(h.logs)).not.toContain('+1512');
    },
  );
  describe('I-1: a system-wide failure never uses up a lead\'s attempts', () => {
    type Harness = Awaited<ReturnType<typeof paceHarness>>;
    /** Ticks at the touch's due time until `n` triggers have gone out (a tick outside the window only moves it on). */
    const tickUntil = async (h: Harness, touchId: string, n: number) => {
      for (let tick = 0; h.cti.requests.length < n && tick < 5 * n; tick += 1) await h.run((await touchById(db, touchId)).dueAt);
      expect(h.cti.requests).toHaveLength(n);
    };

    it('10 ai_voice_unavailable answers in a row: still active, no attempt used, a new key each time; then the call is placed', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      for (let i = 0; i < 10; i += 1) h.cti.answers.push({ result: 'blocked', reason: 'ai_voice_unavailable' });

      await tickUntil(h, lead.touchId, 10);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, triggerKey: null, lastBlockReason: 'ai_voice_unavailable' });
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });

      await tickUntil(h, lead.touchId, 11);
      expect(new Set(h.cti.requests.map((r) => r.idempotencyKey)).size).toBe(11);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('10 transport failures in a row: still active, no attempt used, the SAME key every time (CF-13); then the call is placed', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      for (let i = 0; i < 10; i += 1) h.cti.answers.push({ transport: 'network' });

      await tickUntil(h, lead.touchId, 10);
      const first = h.cti.requests[0]!.idempotencyKey;
      expect(first).toMatch(new RegExp(`^touch:${lead.touchId}:1:\\d+$`));
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, triggerKey: first, lastBlockReason: 'transport' });
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });

      await tickUntil(h, lead.touchId, 11);
      expect(new Set(h.cti.requests.map((r) => r.idempotencyKey))).toEqual(new Set([first]));
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it.each([
      ['off', { available: false, testNumbers: [] }],
      ['unreachable', null],
    ] as const)('cti-api says AI calling is %s: nothing is claimed or triggered, no attempt used, one log line', async (label, answer) => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      const before = await touchById(db, lead.touchId);
      h.cti.available = answer ? { ...answer, testNumbers: [] } : null;

      expect(await h.run(NOW)).toEqual({ placed: 0, retried: 0, failed: 0, deferred: 0, held: 0, parked: 0, researched: 0 });

      expect(h.cti.requests).toEqual([]);
      expect(h.cti.availabilityCalls).toBe(1);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'planned', attempts: 0, dueAt: before.dueAt, lastBlockReason: before.lastBlockReason, claimedAt: null });
      expect(h.logs).toEqual([{ level: 'warn', obj: { availability: label }, msg: 'ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick' }]);
    });

    it('10 daily_cap answers in a row (the org-wide state cap): still active, no attempt used; then the call is placed', async () => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base);
      for (let i = 0; i < 10; i += 1) h.cti.answers.push({ result: 'blocked', reason: 'daily_cap' });

      await tickUntil(h, lead.touchId, 10);
      const t = await touchById(db, lead.touchId);
      expect(t).toMatchObject({ status: 'planned', attempts: 0, triggerKey: null, lastBlockReason: 'daily_cap' });
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'active', exitReason: null });

      await tickUntil(h, lead.touchId, 11);
      expect(new Set(h.cti.requests.map((r) => r.idempotencyKey)).size).toBe(11);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
      // D-3: eleven ticks against real Postgres; under a full parallel PG run this has exceeded the 5 s default.
    }, 15_000);

    it.each(['call_in_progress', 'customer_ceiling'] as const)('a reason about the person (%s) still gives up at the limit', async (reason) => {
      const h = await paceHarness(db);
      const lead = await seedReleasedLead(db, h.base, { touch: { attempts: 7 } });
      h.cti.answers.push({ result: 'blocked', reason });

      await h.run(NOW);

      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'failed', lastBlockReason: 'gave_up', attempts: 8 });
      expect(await enrollmentById(db, lead.enrollmentId)).toMatchObject({ status: 'exited', exitReason: 'ai_call_gave_up' });
    });
  });

  describe('plan 1D: every trigger carries the returning flag; a freshly minted key also carries free appointment times', () => {
    const OWNER = '0058X00000Fsx39QAB';
    const ownerRow = (over: Record<string, unknown> = {}) => ({ Id: OWNER, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles', ...over });
    const bookingWith = (specialists: string[]) => ({ aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, specialists } });
    type RecordTarget = Extract<InternalAiCallRequest['target'], { kind: 'record' }>;
    const target = (r: InternalAiCallRequest): RecordTarget => {
      if (r.target.kind !== 'record') throw new Error('expected a record target');
      return r.target;
    };
    const RETURNING = { planOver: { reengagement: { lastContact: 'back in February', lastTopic: null } } };
    const offerLog = (h: { base: { orgId: string } }, touchId: string, slots: string) => ({ level: 'info', obj: { orgId: h.base.orgId, touchId, slots }, msg: 'ai_call.place: no appointment times offered' });
    const userQueries = (soql: string[]) => soql.filter((q) => / FROM User /.test(q));
    const busyQueries = (soql: string[]) => soql.filter((q) => /ShowAs != 'Free'/.test(q));

    it('1: booking on, the owner active, a free calendar: context.returning follows the plan, and 1–12 slots of the owner that parse', async () => {
      const h = await paceHarness(db, bookingWith([OWNER]));
      h.sf.state.users = [ownerRow()];
      const returning = await seedReleasedLead(db, h.base, RETURNING);
      const fresh = await seedReleasedLead(db, h.base);

      expect((await h.run(NOW)).placed).toBe(2);

      const byRecord = new Map(h.cti.requests.map((r) => [target(r).recordId, target(r)]));
      expect(byRecord.get(returning.sfRecordId)!.context).toEqual({ returning: true });
      expect(byRecord.get(fresh.sfRecordId)!.context).toEqual({ returning: false });
      for (const t of byRecord.values()) {
        expect(t.slots!.length).toBeGreaterThanOrEqual(1);
        expect(t.slots!.length).toBeLessThanOrEqual(12);
        expect(AppointmentSlots.safeParse(t.slots).success).toBe(true);
        expect(t.slots!.every((s) => s.specialistSfUserId === OWNER && s.specialistFirstName === 'Grant')).toBe(true);
        expect(t.slots![0]!.id).toBe('p1');
      }
      expect(busyQueries(h.sf.state.soql)[0]).toContain(`OwnerId = '${OWNER}'`);
      expect(h.logs.some((l) => l.msg === 'ai_call.place: no appointment times offered')).toBe(false);
    });

    it('1c (Fix 1, M-4): the plan text says when we last spoke as of the trigger, not as of planning', async () => {
      const h = await paceHarness(db);
      // Stale stored words; the date is six days before the tick's NOW (and seven or more before any real clock since).
      await seedReleasedLead(db, h.base, { planOver: { reengagement: { lastContact: 'back in February', lastContactAt: '2026-09-29T17:00:00.000Z', lastContactKind: 'call', lastTopic: null } } });

      expect((await h.run(NOW)).placed).toBe(1);
      const t = target(h.cti.requests[0]!);
      expect(t.planText).toContain('\nLast time we spoke: earlier this week\n');
      expect(t.context).toEqual({ returning: true });
    });

    it('1b: the configured default list applies while the tenant has saved none', async () => {
      const h = await paceHarness(db, {}, { defaultSpecialists: [OWNER] });
      h.sf.state.users = [ownerRow()];
      await seedReleasedLead(db, h.base);

      expect((await h.run(NOW)).placed).toBe(1);
      expect(target(h.cti.requests[0]!).slots!.length).toBeGreaterThan(0);
    });

    it('2: no specialists (empty default, nothing saved): no slots key, context present, nothing read for the offer, nothing logged', async () => {
      const h = await paceHarness(db);
      await seedReleasedLead(db, h.base);

      expect((await h.run(NOW)).placed).toBe(1);
      const t = target(h.cti.requests[0]!);
      expect('slots' in t).toBe(false);
      expect(t.context).toEqual({ returning: false });
      expect(userQueries(h.sf.state.soql)).toEqual([]);
      expect(h.logs.some((l) => l.msg === 'ai_call.place: no appointment times offered')).toBe(false);
    });

    it('2b: the owner inactive: no slots, no calendar read, and the log says no_owner', async () => {
      const h = await paceHarness(db, bookingWith([OWNER]));
      h.sf.state.users = [ownerRow({ IsActive: false })];
      const lead = await seedReleasedLead(db, h.base);

      expect((await h.run(NOW)).placed).toBe(1);
      expect('slots' in target(h.cti.requests[0]!)).toBe(false);
      expect(busyQueries(h.sf.state.soql)).toEqual([]);
      expect(h.logs).toContainEqual(offerLog(h, lead.touchId, 'no_owner'));
    });

    it('2c: a fully busy calendar: no slots, and the log says no_free_time', async () => {
      const h = await paceHarness(db, bookingWith([OWNER]));
      h.sf.state.users = [ownerRow()];
      h.sf.state.busy = [{ StartDateTime: '2026-10-01T00:00:00.000+0000', EndDateTime: '2026-11-01T00:00:00.000+0000', IsAllDayEvent: false }];
      const lead = await seedReleasedLead(db, h.base);

      expect((await h.run(NOW)).placed).toBe(1);
      expect('slots' in target(h.cti.requests[0]!)).toBe(false);
      expect(h.logs).toContainEqual(offerLog(h, lead.touchId, 'no_free_time'));
    });

    it('3 (CF-13): a touch with a kept trigger key re-sends without slots and reads no calendar', async () => {
      const h = await paceHarness(db, bookingWith([OWNER]));
      h.sf.state.users = [ownerRow()];
      const kept = 'touch:kept:1:1759700000000';
      const lead = await seedReleasedLead(db, h.base, { ...RETURNING, touch: { triggerKey: kept } });

      expect((await h.run(NOW)).placed).toBe(1);
      expect(h.cti.requests[0]).toMatchObject({ idempotencyKey: kept });
      const t = target(h.cti.requests[0]!);
      expect('slots' in t).toBe(false);
      expect(t.context).toEqual({ returning: true });
      expect(userQueries(h.sf.state.soql)).toEqual([]);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent' });
    });

    it('3b (CF-13): after a transport failure the retry keeps the key, the plan text and the context, and offers no slots', async () => {
      const h = await paceHarness(db, bookingWith([OWNER]));
      h.sf.state.users = [ownerRow()];
      const lead = await seedReleasedLead(db, h.base);
      h.cti.answers.push({ transport: 'timeout' });

      await h.run(NOW);
      const first = h.cti.requests[0]!;
      expect(target(first).slots!.length).toBeGreaterThan(0);
      const readsBefore = userQueries(h.sf.state.soql).length;

      await h.run((await touchById(db, lead.touchId)).dueAt);
      const retry = h.cti.requests[1]!;
      expect(retry.idempotencyKey).toBe(first.idempotencyKey);
      const { slots: _slots, ...firstWithoutSlots } = target(first);
      expect(target(retry)).toEqual(firstWithoutSlots);
      expect(userQueries(h.sf.state.soql)).toHaveLength(readsBefore);
      expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 1 });
    });

    it('4: the User query throws: the call is still triggered, without slots, and the log says salesforce_error', async () => {
      const h = await paceHarness(db, bookingWith([OWNER]));
      h.sf.state.userError = new Error('INVALID_SESSION_ID');
      const lead = await seedReleasedLead(db, h.base);

      expect((await h.run(NOW)).placed).toBe(1);
      expect('slots' in target(h.cti.requests[0]!)).toBe(false);
      expect(h.logs).toContainEqual(offerLog(h, lead.touchId, 'salesforce_error'));
      expect(JSON.stringify(h.logs)).not.toContain('INVALID_SESSION_ID');
    });
  });
});

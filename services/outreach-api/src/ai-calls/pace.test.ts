/** Real Postgres: the `ai_call.place` tick with a fake CtiClient and a fake Salesforce. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { EditableCallPlan } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError } from '@cti/salesforce';
import { enrollmentById, planById, seedAiCall, seedReleasedLead, touchById } from '../test/ai-call-seed.js';
import { validPlan } from '../test/call-plan-fixtures.js';
import { paceHarness } from '../test/fake-pace.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { renderPlanForAgent } from './plan-text.js';

/** Monday 18:00 CDT: inside the plan fixture's `evening` window for a Texas number. */
const NOW = new Date('2026-10-05T23:00:00.000Z');
/** Monday 14:00 CDT: outside `evening`, inside the calling window. */
const AFTERNOON = new Date('2026-10-05T19:00:00.000Z');
const MIN = 60_000;
const at = (from: Date, ms: number) => new Date(from.getTime() + ms);
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
        idempotencyKey: `touch:${l.touchId}:1`,
        target: { kind: 'record', objectType: 'Lead', recordId: l.sfRecordId, planText: planText() },
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
    expect(t).toMatchObject({ status: 'planned', triggerKey: `touch:${lead.touchId}:1`, lastBlockReason: 'transport', attempts: 1 });

    await h.run(t.dueAt);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([`touch:${lead.touchId}:1`, `touch:${lead.touchId}:1`]);
    expect(await touchById(db, lead.touchId)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('7: in_flight waits at least 10 minutes and retries with the same key', async () => {
    const h = await paceHarness(db);
    const lead = await seedReleasedLead(db, h.base);
    h.cti.answers.push({ result: 'failed', reason: 'in_flight' });

    await h.run(NOW);
    const t = await touchById(db, lead.touchId);
    expect(t.dueAt.getTime() - NOW.getTime()).toBeGreaterThanOrEqual(10 * MIN);
    await h.run(t.dueAt);
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([`touch:${lead.touchId}:1`, `touch:${lead.touchId}:1`]);
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
    expect(h.cti.requests.map((r) => r.idempotencyKey)).toEqual([`touch:${lead.touchId}:1`, `touch:${lead.touchId}:2`]);
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
});

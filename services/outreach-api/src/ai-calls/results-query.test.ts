/** Real Postgres: the AI call results table and the transcript. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { AiCallResultsResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedAiCall, seedAiCallRequest, seedReleasedLead } from '../test/ai-call-seed.js';
import { ctxOf, seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { seedConnection } from '../test/outreach-fixtures.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { NEW_OPP, PHONE_BOOKING, seedWriteback } from '../test/writeback-harness.js';
import { insertRecordTest } from '../record-tests/store.js';
import { listAiCallResults, loadTranscript, RESULTS_PAGE_SIZE, transcriptLines } from './results-query.js';

const OWNER = '005000000000001AAA';

describe('transcriptLines', () => {
  it('keeps well-formed lines in order and drops the rest', () => {
    expect(
      transcriptLines([
        { role: 'agent', text: 'Hi, I am an AI assistant.', at: '2026-10-05T23:00:01.000Z' },
        { role: 'caller', text: 'Who is this?' },
        { role: 'robot', text: 'x', at: null },
        { role: 'agent', text: 42 },
        'garbage',
        null,
        { role: 'system', text: 'Call ended', at: '2026-10-05T23:02:00.000Z' },
      ]),
    ).toEqual([
      { role: 'agent', text: 'Hi, I am an AI assistant.', at: '2026-10-05T23:00:01.000Z' },
      { role: 'caller', text: 'Who is this?', at: null },
      { role: 'system', text: 'Call ended', at: '2026-10-05T23:02:00.000Z' },
    ]);
    expect(transcriptLines({ not: 'an array' })).toEqual([]);
  });
});

describe.skipIf(!pgLane)('AI call results queries (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });

  async function setup() {
    const base = await seedAiCallCampaign(db, 'active');
    await seedConnection(db, base.orgId);
    const admin = await seedUser(db, base.orgId);
    const owner = await seedUser(db, base.orgId, { sfUserId: OWNER });
    const rep = await seedUser(db, base.orgId, { sfUserId: '005000000000002AAA' });
    return { base, admin, owner, rep };
  }
  const touchSet = (id: string, set: Partial<typeof schema.touches.$inferInsert>) => db.update(schema.touches).set(set).where(eq(schema.touches.id, id));

  it('lists the campaign\'s AI call touches newest first with the call, the record and the exit; planned and failed ones too', async () => {
    const s = await setup();
    const placed = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, {
      status: 'completed',
      outcome: 'qualified_callback',
      summary: 'Wants a call back Thursday.',
      qualification: { timeline: '3 months', condition: 'needs roof' },
      durationSeconds: 184,
      startedAt: new Date('2026-10-05T23:00:00.000Z'),
    });
    await touchSet(placed.touchId, { status: 'sent', aiCallId, sentAt: new Date(), createdAt: new Date('2026-10-05T10:00:00.000Z') });
    const refused = await seedReleasedLead(db, s.base, { approver: s.admin });
    await touchSet(refused.touchId, { status: 'failed', lastBlockReason: 'no_consent', createdAt: new Date('2026-10-05T11:00:00.000Z') });
    await db.update(schema.campaignEnrollments).set({ status: 'exited', exitReason: 'ai_call_no_consent' }).where(eq(schema.campaignEnrollments.id, refused.enrollmentId));
    const waiting = await seedReleasedLead(db, s.base, { approver: s.admin, touch: { attempts: 2, lastBlockReason: 'calling_hours' } });
    await touchSet(waiting.touchId, { createdAt: new Date('2026-10-05T12:00:00.000Z') });
    const other = await setup();
    await seedReleasedLead(db, other.base);

    const res = await listAiCallResults(db, ctxOf(s.base.orgId, s.admin, true), s.base.campaignId, null);

    expect(AiCallResultsResponse.parse(res)).toEqual(res);
    expect(res.items.map((i) => i.touchId)).toEqual([waiting.touchId, refused.touchId, placed.touchId]);
    expect(res.nextCursor).toBeNull();
    expect(res.items[2]).toMatchObject({
      name: 'Pat Seller',
      sfObject: 'Lead',
      sfRecordId: placed.sfRecordId,
      recordUrl: `https://example.my.salesforce.com/${placed.sfRecordId}`,
      touchStatus: 'sent',
      aiCallId,
      callStatus: 'completed',
      outcome: 'qualified_callback',
      summary: 'Wants a call back Thursday.',
      qualification: { timeline: '3 months', condition: 'needs roof' },
      durationSeconds: 184,
      startedAt: '2026-10-05T23:00:00.000Z',
      enrollmentStatus: 'active',
      mayReadTranscript: true,
      // No booking and no write-back row on this call.
      appointment: null,
      writeback: null,
    });
    expect(res.items[1]).toMatchObject({ touchStatus: 'failed', lastBlockReason: 'no_consent', enrollmentStatus: 'exited', exitReason: 'ai_call_no_consent', aiCallId: null, callStatus: null, mayReadTranscript: false });
    expect(res.items[0]).toMatchObject({ touchStatus: 'planned', attempts: 2, lastBlockReason: 'calling_hours', qualification: null });
  });

  it('pages by (created_at, id), 50 a page, with no row repeated or lost', async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < RESULTS_PAGE_SIZE + 3; i += 1) ids.push((await seedReleasedLead(db, s.base, { approver: s.admin })).touchId);
    // Several rows share one created_at: the id breaks the tie.
    await db.execute(sql`update touches set created_at = '2026-10-05T12:00:00.123456Z' where id in (${sql.join(ids.slice(0, 10).map((id) => sql`${id}::uuid`), sql`, `)})`);
    const ctx = ctxOf(s.base.orgId, s.admin, true);
    const first = await listAiCallResults(db, ctx, s.base.campaignId, null);
    expect(first.items).toHaveLength(RESULTS_PAGE_SIZE);
    const second = await listAiCallResults(db, ctx, s.base.campaignId, first.nextCursor);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.items, ...second.items].map((i) => i.touchId);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('a call\'s outcome or status cti-api wrote that the contract does not know reads as null', async () => {
    const s = await setup();
    const lead = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { status: 'completed', outcome: 'something_new' });
    await touchSet(lead.touchId, { status: 'sent', aiCallId });
    const [item] = (await listAiCallResults(db, ctxOf(s.base.orgId, s.admin, true), s.base.campaignId, null)).items;
    expect(item).toMatchObject({ callStatus: 'completed', outcome: null });
  });

  it('the transcript: the owner and an admin read it, another rep is forbidden, an unknown or foreign call is null', async () => {
    const s = await setup();
    const lead = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { status: 'completed', transcript: [{ role: 'agent', text: 'Hello', at: '2026-10-05T23:00:01.000Z' }, { bad: true }] });
    await touchSet(lead.touchId, { status: 'sent', aiCallId });

    const want = { aiCallId, lines: [{ role: 'agent', text: 'Hello', at: '2026-10-05T23:00:01.000Z' }] };
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.owner, false), aiCallId)).toEqual(want);
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), aiCallId)).toEqual(want);
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.rep, false), aiCallId)).toBe('forbidden');
    const other = await setup();
    expect(await loadTranscript(db, ctxOf(other.base.orgId, other.admin, true), aiCallId)).toBeNull();
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), '99999999-9999-4999-8999-999999999999')).toBeNull();
    const testCall = await seedAiCall(db, s.base.orgId, s.admin, { isTest: true, status: 'completed' });
    expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), testCall)).toBeNull();
  });

  it('mayReadTranscript follows the owner rule for a rep', async () => {
    const s = await setup();
    const lead = await seedReleasedLead(db, s.base, { approver: s.admin });
    const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { status: 'completed' });
    await touchSet(lead.touchId, { status: 'sent', aiCallId });
    const asOwner = await listAiCallResults(db, ctxOf(s.base.orgId, s.owner, false), s.base.campaignId, null);
    const asRep = await listAiCallResults(db, ctxOf(s.base.orgId, s.rep, false), s.base.campaignId, null);
    expect(asOwner.items[0]?.mayReadTranscript).toBe(true);
    expect(asRep.items[0]?.mayReadTranscript).toBe(false);
  });

  describe('plan 1D: the appointment, the conversion and the write-back', () => {
    const PLAN = {
      sfObject: 'Opportunity', result: 'appointment', patch: { StageName: 'Appointment Set' },
      changes: [{ field: 'StageName', label: 'Stage', before: 'New Opportunity', after: 'Appointment Set', why: 'status' }],
      kept: [{ field: 'Rating__c', label: 'Rating', current: 'Warm', proposed: 'Hot', evidence: 'soon' }],
      skipped: [{ field: 'Timeline__c', label: 'Timeline', why: 'not_writable' }],
      appointment: null, contactDnc: false, mapped: true, bookingThen: null,
    };
    async function listed(over: Record<string, unknown>, o: { sfObject?: 'Lead' | 'Opportunity'; admin?: boolean; appointment?: unknown } = {}) {
      const w = await seedWriteback(db, { sfObject: o.sfObject ?? 'Opportunity', outcome: 'appointment_set', researchStatus: 'New Opportunity', appointment: PHONE_BOOKING });
      if (o.appointment !== undefined) await db.update(schema.aiCalls).set({ appointment: o.appointment }).where(eq(schema.aiCalls.id, w.aiCallId));
      if (Object.keys(over).length > 0) await db.update(schema.aiCallWritebacks).set(over).where(eq(schema.aiCallWritebacks.id, w.writebackId));
      const user = await seedUser(db, w.orgId);
      const res = await listAiCallResults(db, ctxOf(w.orgId, user, o.admin ?? true), w.campaignId, null);
      expect(AiCallResultsResponse.parse(res)).toEqual(res);
      return { w, item: res.items[0]! };
    }

    it('a booked call with a done write-back lists the appointment and what was changed, kept, not written and created', async () => {
      const { item } = await listed({
        status: 'done', plan: PLAN, sfEventId: '00U8X00000Evnt1QAA', sfTaskId: '00T8X00000Task1QAA', sfFeedItemId: '0D58X00000Feed1QAA',
        steps: { fields: { status: 'done', data: {
          written: [{ field: 'StageName', label: 'Stage', before: 'New Opportunity', after: 'Appointment Set', why: 'status' }],
          notWritten: [{ label: 'Loss Reason', reason: 'Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)', field: 'Loss_Reason__c', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' }],
          notChanged: [{ field: 'Next_Follow_Up_Date__c', label: 'Next Follow-Up', now: '2026-10-09' }],
        } } },
      });
      expect(item.appointment).toEqual(PHONE_BOOKING);
      expect(item.writeback).toEqual({
        status: 'done', error: null, mayRetry: false, convertedOpportunityId: null, convertedOpportunityUrl: null,
        changes: [
          { kind: 'created', label: 'Appointment Event', before: null, after: '00U8X00000Evnt1QAA' },
          { kind: 'created', label: 'Task', before: null, after: '00T8X00000Task1QAA' },
          { kind: 'created', label: 'Chatter post', before: null, after: '0D58X00000Feed1QAA' },
          { kind: 'changed', label: 'Stage', before: 'New Opportunity', after: 'Appointment Set' },
          { kind: 'kept', label: 'Rating', before: 'Warm', after: 'Hot' },
          { kind: 'kept', label: 'Next Follow-Up', before: '2026-10-09', after: null },
          { kind: 'not_written', label: 'Timeline', before: null, after: "the connected Salesforce user can't edit it" },
          { kind: 'not_written', label: 'Loss Reason', before: null, after: 'Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)' },
        ],
      });
    });

    it('before the fields step ran, the plan\'s own changes are listed', async () => {
      const { item } = await listed({ status: 'pending', plan: PLAN });
      expect(item.writeback?.changes.filter((c) => c.kind === 'changed')).toEqual([{ kind: 'changed', label: 'Stage', before: 'New Opportunity', after: 'Appointment Set' }]);
    });

    it('a converted Lead carries the new Opportunity and a converted change; a fallback row carries the refusal as not written', async () => {
      const { w, item } = await listed({ status: 'done', plan: PLAN, convertedOpportunityId: NEW_OPP, steps: { convert: { status: 'done', detail: 'converted' } } }, { sfObject: 'Lead' });
      expect(item.writeback).toMatchObject({ convertedOpportunityId: NEW_OPP, convertedOpportunityUrl: null });
      expect(item.writeback!.changes[0]).toEqual({ kind: 'converted', label: 'Lead converted to an Opportunity', before: w.recordId, after: NEW_OPP });
      const fallback = await listed({ status: 'partial', plan: PLAN, lastError: 'INSUFFICIENT_ACCESS', sfEventId: '00U8X00000Hold1QAA', steps: { convert: { status: 'failed', detail: 'INSUFFICIENT_ACCESS: no convert permission' }, appointment: { status: 'done', detail: 'lead_hold' } } }, { sfObject: 'Lead' });
      expect(fallback.item.writeback).toMatchObject({ status: 'partial', error: 'INSUFFICIENT_ACCESS', convertedOpportunityId: null });
      expect(fallback.item.writeback!.changes).toContainEqual({ kind: 'not_written', label: 'Lead conversion', before: null, after: 'INSUFFICIENT_ACCESS: no convert permission' });
      expect(fallback.item.writeback!.changes).toContainEqual({ kind: 'created', label: 'Calendar hold', before: null, after: '00U8X00000Hold1QAA' });
    });

    it('P6 M-3: with a Salesforce connection the server sends the new Opportunity\'s link (the web never rebuilds it)', async () => {
      const w = await seedWriteback(db, { sfObject: 'Lead', outcome: 'appointment_set', researchStatus: 'New Opportunity', appointment: PHONE_BOOKING });
      await seedConnection(db, w.orgId);
      await db.update(schema.aiCallWritebacks).set({ status: 'done', plan: PLAN, convertedOpportunityId: NEW_OPP }).where(eq(schema.aiCallWritebacks.id, w.writebackId));
      const res = await listAiCallResults(db, ctxOf(w.orgId, await seedUser(db, w.orgId), true), w.campaignId, null);
      const item = res.items[0]!;
      expect(item.recordUrl).toBe(`https://example.my.salesforce.com/${w.recordId}`);
      expect(item.writeback!.convertedOpportunityUrl).toBe(`https://example.my.salesforce.com/${NEW_OPP}`);
    });

    it('a failed write-back may be retried by an admin, never by a rep', async () => {
      const asAdmin = await listed({ status: 'failed', lastError: 'SERVER_UNAVAILABLE' });
      expect(asAdmin.item.writeback).toMatchObject({ status: 'failed', mayRetry: true, error: 'SERVER_UNAVAILABLE', changes: [] });
      const asRep = await listed({ status: 'failed' }, { admin: false });
      expect(asRep.item.writeback?.mayRetry).toBe(false);
      const done = await listed({ status: 'done' });
      expect(done.item.writeback?.mayRetry).toBe(false);
    });

    it('a plan that no longer parses gives no changes, never an error; drifted appointment JSON reads as null (D-6)', async () => {
      const { item } = await listed({ status: 'done', plan: { an: 'old plan' }, sfEventId: '00U8X00000Evnt1QAA' }, { appointment: { slotId: 'nope' } });
      expect(item.writeback).toMatchObject({ status: 'done', changes: [] });
      expect(item.appointment).toBeNull();
    });

    it('no write-back row gives writeback null', async () => {
      const { w } = await listed({});
      await db.delete(schema.aiCallWritebacks).where(eq(schema.aiCallWritebacks.id, w.writebackId));
      const user = await seedUser(db, w.orgId);
      const [item] = (await listAiCallResults(db, ctxOf(w.orgId, user, true), w.campaignId, null)).items;
      expect(item).toMatchObject({ appointment: PHONE_BOOKING, writeback: null });
    });
  });

  describe('plan 1E: a Test a record call\'s transcript', () => {
    const lines = [{ role: 'agent', text: 'Hi Pat', at: null }];
    async function testCall(o: { lost?: boolean } = {}) {
      const s = await setup();
      const aiCallId = await seedAiCall(db, s.base.orgId, s.admin, { isTest: true, practice: true, status: 'completed', transcript: lines, toE164: 'client:aitest_x' });
      const testId = await insertRecordTest(db, { orgId: s.base.orgId, requestedBy: s.admin, sfObject: 'Lead', sfRecordId: '00Q8X00001AbCdEUAV' });
      const key = `rtest:${randomUUID()}`;
      await db.insert(schema.aiRecordTestCalls).values({
        orgId: s.base.orgId, recordTestId: testId, requestedBy: s.admin, mode: 'browser', clientIdentity: 'aitest_x', idempotencyKey: key,
        aiCallId: o.lost ? null : aiCallId,
      });
      if (o.lost) await seedAiCallRequest(db, { orgId: s.base.orgId, key, userId: s.admin, response: { result: 'placed', aiCallId } });
      return { s, aiCallId };
    }

    it('20: an admin of its tenant opens it, by the call it stored or (a lost answer) by its key', async () => {
      for (const lost of [false, true]) {
        const { s, aiCallId } = await testCall({ lost });
        expect(await loadTranscript(db, ctxOf(s.base.orgId, s.admin, true), aiCallId)).toEqual({ aiCallId, lines });
      }
    });

    it('21: a rep is forbidden', async () => {
      const { s, aiCallId } = await testCall();
      expect(await loadTranscript(db, ctxOf(s.base.orgId, s.rep, false), aiCallId)).toBe('forbidden');
    });

    it("22: another tenant's admin gets nothing", async () => {
      const { aiCallId } = await testCall();
      const other = await setup();
      expect(await loadTranscript(db, ctxOf(other.base.orgId, other.admin, true), aiCallId)).toBeNull();
    });
  });
});

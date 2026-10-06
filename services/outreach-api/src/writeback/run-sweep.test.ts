/**
 * Real Postgres + fake Salesforce: the sweep's rare paths of the `ai_call.writeback` tick (D-23 M5, M7, M10; D-25 N1).
 * Turning write-back off stops rows already queued; a refused step is final, so a retry never contradicts its Task; a call
 * with no end time still recognises our own conversion; a late retry finds the hold an earlier attempt made.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { convertRefused, refused } from '../test/fake-sf-writes.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { CALL_ENDED, depsFor, fakeOrg, GRANT, NEW_OPP, PHONE_BOOKING, RUN_AT, seedWriteback, SETTER, transportError, writebackById, type OrgState } from '../test/writeback-harness.js';
import { runWritebacks } from './run.js';

const PASSED_SUBJECT = 'Appointment time passed before it could be saved — call the seller to re-book';
/** After the booking's start (Wed Oct 7, 11:00 AM PT). */
const LATE = new Date('2026-10-07T19:00:00.000Z');

function oppState(recordId: string): OrgState {
  const record = { Name: 'Jane Seller', OwnerId: SETTER, StageName: 'Closed Lost', Rating__c: null, Timeline__c: null };
  return { records: new Map([[recordId, record]]), lead: null, busy: [], convertedBy: { id: SETTER, at: '2026-01-01T00:00:00.000+0000' } };
}

function leadState(leadId: string): OrgState {
  return {
    records: new Map<string, Record<string, unknown>>([
      [leadId, { Name: 'Jane Seller', OwnerId: SETTER, Status: 'Long Term Follow-Up', Rating: null, IsConverted: false }],
      [NEW_OPP, { Name: 'Jane Seller', OwnerId: GRANT, StageName: 'New Opportunity', Rating__c: null, Timeline__c: null, LeadManager__c: null }],
    ]),
    lead: { Id: leadId, Name: 'Jane Seller', OwnerId: SETTER, IsConverted: false, ConvertedOpportunityId: null, ConvertedAccountId: null, ConvertedContactId: null },
    busy: [],
    convertedBy: { id: SETTER, at: '2026-01-01T00:00:00.000+0000' },
  };
}

describe.skipIf(!pgLane)('runWritebacks: sweep rare paths (real Postgres)', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => {
    ({ db, drop } = await createTestDb());
  }, 120_000);
  afterAll(async () => {
    await drop?.();
  });
  beforeEach(async () => {
    await db.execute(sql`delete from ai_call_writebacks`);
  });

  const bookedOpp = (settings?: Record<string, unknown>) =>
    seedWriteback(db, { sfObject: 'Opportunity', outcome: 'appointment_set', researchStatus: 'Closed Lost', appointment: PHONE_BOOKING, ...(settings ? { settings } : {}) });
  const bookedLead = () => seedWriteback(db, { sfObject: 'Lead', outcome: 'appointment_set', researchStatus: 'Long Term Follow-Up', appointment: PHONE_BOOKING });
  const changesOf = (fields: Record<string, unknown>) => String(fields.AI_Last_Call_Changes__c);

  it('D-23 M5: write-back turned off after the row was queued: a row that is not a booking is skipped "write-back is off", no Salesforce call at all', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'qualified_callback', researchStatus: 'Closed Lost', settings: { aiCallWriteback: false } });
    const f = fakeOrg(oppState(s.recordId));
    let clients = 0;
    const deps = { ...depsFor(db, f), clients: async () => (clients += 1, f.client) };
    expect((await runWritebacks(deps)).skipped).toBe(1);
    expect(clients).toBe(0);
    expect(f.log).toEqual([]);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'skipped', lastError: 'write-back is off' });
  });

  it('final fix 3: write-back off, a queued booking: it is still written (Event, changes text, Chatter): the seller was told the time is set', async () => {
    const s = await bookedOpp({ aiCallWriteback: false });
    const f = fakeOrg(oppState(s.recordId));
    const counts = await runWritebacks(depsFor(db, f));
    expect(counts.skipped).toBe(0);
    expect(counts.done + counts.partial).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(f.updates).toHaveLength(1);
    expect(changesOf(f.updates[0]!.fields)).toContain('Event: Phone Consultation');
    expect(f.creates.some((c) => c.sobject === 'FeedItem')).toBe(true);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: expect.stringMatching(/^(done|partial)$/) });
  });

  it('final fix 3: write-back off, a queued booking on a Lead: the hold and its Task are still made', async () => {
    const s = await seedWriteback(db, { sfObject: 'Lead', outcome: 'appointment_set', researchStatus: 'Long Term Follow-Up', appointment: PHONE_BOOKING, settings: { aiCallWriteback: false } });
    const f = fakeOrg(leadState(s.recordId));
    f.onSoap = (body) => (body.includes('getUserInfo') ? new Error('unused') : convertRefused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Hunt Leads are converted by the Hunt winner'));
    const counts = await runWritebacks(depsFor(db, f));
    expect(counts.skipped).toBe(0);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(f.creates.filter((c) => c.sobject === 'Task')).toHaveLength(1);
    expect(await writebackById(db, s.writebackId)).not.toMatchObject({ status: 'skipped' });
  });

  it('final fix 3: a booking that is retrying when write-back is turned off is still written on the retry', async () => {
    const s = await bookedOpp();
    const f = fakeOrg(oppState(s.recordId));
    f.onCreate = () => transportError();
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    await db.execute(sql`update organizations set settings = settings || '{"aiCallWriteback": false}'::jsonb where id = ${s.orgId}::uuid`);
    f.onCreate = null;
    const counts = await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 2 * 60_000) }));
    expect(counts.skipped).toBe(0);
    expect(counts.done + counts.partial).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(await writebackById(db, s.writebackId)).not.toMatchObject({ status: 'skipped' });
  });

  it('final fix 3: write-back off, a retrying row that is not a booking: skipped "write-back is off" on the retry', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'qualified_callback', researchStatus: 'Closed Lost' });
    const f = fakeOrg(oppState(s.recordId));
    f.onUpdate = () => transportError();
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    await db.execute(sql`update organizations set settings = settings || '{"aiCallWriteback": false}'::jsonb where id = ${s.orgId}::uuid`);
    f.onUpdate = null;
    const before = f.log.length;
    expect((await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 2 * 60_000) }))).skipped).toBe(1);
    expect(f.log).toHaveLength(before);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'skipped', lastError: 'write-back is off' });
  });

  it('D-23 M7: a refused Event stays refused: a later retry never creates it after the "call the seller" Task', async () => {
    const s = await bookedOpp();
    const f = fakeOrg(oppState(s.recordId));
    f.onCreate = (c) => (c.sobject === 'Event' ? refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Owner must be active') : undefined);
    f.onUpdate = () => transportError();
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    const task = f.creates.find((c) => c.sobject === 'Task')!;
    expect(String(task.fields.Subject)).toContain('Salesforce refused the Event');

    f.onCreate = null;
    f.onUpdate = null;
    expect((await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 2 * 60_000) }))).partial).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(f.creates.filter((c) => c.sobject === 'Task')).toHaveLength(1);
    const patch = f.updates.at(-1)!;
    expect(patch.fields).toMatchObject({ StageName: 'Followup' });
    expect(changesOf(patch.fields)).not.toContain('Event: Phone Consultation');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'partial', sfEventId: null, lastError: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });

  it('D-23 M10: a call with no end time still recognises our own lost-answer conversion on a later retry (judged from the call start)', async () => {
    const s = await bookedLead();
    await db.execute(sql`update ai_calls set ended_at = null, started_at = ${new Date(CALL_ENDED.getTime() - 5 * 60_000).toISOString()}::timestamptz where id = ${s.aiCallId}::uuid`);
    const f = fakeOrg(leadState(s.recordId));
    const answer = f.onSoap!;
    f.onSoap = (body) => {
      const a = answer(body);
      return body.includes('<urn:convertLead') ? transportError() : a;
    };
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    // An hour later: "now" is long after the conversion, the call start is before it.
    expect((await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 60 * 60_000) }))).done).toBe(1);
    const row = await writebackById(db, s.writebackId);
    expect(row.steps).toMatchObject({ convert: { status: 'done', detail: 'adopted our earlier conversion' } });
    expect(f.updates[0]!.fields).toMatchObject({ LeadManager__c: SETTER });
  });

  it('D-25 N1: a late retry on the Lead fallback finds the hold an earlier attempt made: it is named, with "delete it"', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    f.onSoap = (body) => (body.includes('getUserInfo') ? new Error('unused') : convertRefused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Hunt Leads are converted by the Hunt winner'));
    f.onCreate = (c) => (c.sobject === 'Task' ? transportError() : undefined);
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);

    f.onCreate = null;
    expect((await runWritebacks(depsFor(db, f, { now: LATE }))).partial).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    const task = f.creates.filter((c) => c.sobject === 'Task').at(-1)!;
    expect(task.fields).toMatchObject({ Subject: PASSED_SUBJECT, WhoId: s.recordId, OwnerId: GRANT });
    expect(String(task.fields.Description)).toContain('A hold an earlier attempt put on the calendar at that time is still there: delete it.');
    expect(String(task.fields.Description)).not.toContain('nothing was put on the calendar');
    const text = changesOf(f.updates.find((u) => u.sobject === 'Lead')!.fields);
    expect(text).toContain("- Hold on Grant Golden's calendar: Wed Oct 7, 11:00 AM PT (the time passed: delete it)");
    expect(await writebackById(db, s.writebackId)).toMatchObject({ sfEventId: '00U8X00000Hold1QAA' });
  });
});

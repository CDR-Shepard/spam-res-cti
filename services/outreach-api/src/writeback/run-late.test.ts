/**
 * Real Postgres + fake Salesforce: a row that runs after the booked time has passed (Fix 1, I-1). It is handled like a
 * write-time conflict: no Event, no Appointment Set, the Followup moves and a Task to the appointment owner; a Lead is
 * never converted for a time that has passed, but a conversion an earlier attempt made is kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import { ACCOUNT, CONTACT, depsFor, fakeOrg, GRANT, NEW_OPP, PHONE_BOOKING, seedWriteback, SETTER, transportError, writebackById, type OrgState } from '../test/writeback-harness.js';
import { runWritebacks } from './run.js';

const PASSED_SUBJECT = 'Appointment time passed before it could be saved — call the seller to re-book';
/** After the booking's end (Wed Oct 7, 11:15 AM PT). */
const LATE = new Date('2026-10-07T19:00:00.000Z');
const DAYS_LATER = new Date('2026-10-10T17:00:00.000Z');
const BUSY_READ = /^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event/;

function oppState(recordId: string): OrgState {
  const record = { Name: 'Jane Seller', OwnerId: SETTER, StageName: 'Closed Lost', Rating__c: null, Timeline__c: null, LastModifiedDate: '2026-10-01T12:00:00.000+0000' };
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

describe.skipIf(!pgLane)('runWritebacks after the booked time has passed (real Postgres)', () => {
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

  const bookedOpp = () => seedWriteback(db, { sfObject: 'Opportunity', outcome: 'appointment_set', researchStatus: 'Closed Lost', appointment: PHONE_BOOKING });
  const bookedLead = () => seedWriteback(db, { sfObject: 'Lead', outcome: 'appointment_set', researchStatus: 'Long Term Follow-Up', appointment: PHONE_BOOKING });
  const converts = (f: ReturnType<typeof fakeOrg>) => f.soapBodies.filter((b) => b.includes('<urn:convertLead'));
  const changesOf = (fields: Record<string, unknown>) => String(fields.AI_Last_Call_Changes__c);

  it('a late first attempt on an Opportunity: no Event, Followup and a follow-up time, the passed-time Task to Grant; done', async () => {
    const s = await bookedOpp();
    const f = fakeOrg(oppState(s.recordId));
    expect((await runWritebacks(depsFor(db, f, { now: LATE }))).done).toBe(1);

    expect(f.creates.filter((c) => c.sobject === 'Event')).toEqual([]);
    expect(f.soql.some((q) => BUSY_READ.test(q))).toBe(false);
    const patch = f.updates.find((u) => u.sobject === 'Opportunity')!;
    expect(patch.fields).toMatchObject({ StageName: 'Followup', Next_Follow_Up_Date__c: LATE.toISOString() });
    expect(patch.fields).not.toHaveProperty('Rating__c');
    const task = f.creates.find((c) => c.sobject === 'Task')!;
    expect(task.fields).toMatchObject({ Subject: PASSED_SUBJECT, WhatId: s.recordId, OwnerId: GRANT, Priority: 'High', Status: 'Open' });
    expect(changesOf(patch.fields)).not.toContain('Appointment Set');
    expect(changesOf(patch.fields)).toContain('- Task to Grant Golden: call the seller to re-book (Wed Oct 7, 11:00 AM PT passed before it could be saved)');
    const post = String(f.creates.find((c) => c.sobject === 'FeedItem')!.fields.Body);
    expect(post).toContain('Booked: phone consultation for Wed Oct 7, 11:00 AM PT not booked: the time passed before it could be saved (Task to Grant Golden)');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', sfEventId: null, sfTaskId: expect.stringMatching(/^00T/) });
  });

  it('a late first attempt on a Lead: never converted, no hold, the passed-time Task on the Lead; done', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    expect((await runWritebacks(depsFor(db, f, { now: LATE }))).done).toBe(1);

    expect(f.soapBodies).toEqual([]);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toEqual([]);
    const task = f.creates.find((c) => c.sobject === 'Task')!;
    expect(task.fields).toMatchObject({ Subject: PASSED_SUBJECT, WhoId: s.recordId, OwnerId: GRANT });
    expect(task.fields).not.toHaveProperty('WhatId');
    const patch = f.updates.find((u) => u.sobject === 'Lead')!;
    expect(patch.fields).toMatchObject({ Status: 'Working' });
    const text = changesOf(patch.fields);
    expect(text).toContain('Lead not converted: the booked time passed before it could be saved');
    expect(text).not.toContain('a hold');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', convertedOpportunityId: null, sfEventId: null });
  });

  it('resumed after the conversion, once the time has passed: the conversion is kept (once), no Event, Followup and the Task on the Opportunity', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    f.queries.unshift([BUSY_READ, transportError()]);
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'pending', convertedOpportunityId: NEW_OPP });
    f.queries.shift();

    expect((await runWritebacks(depsFor(db, f, { now: LATE }))).done).toBe(1);
    expect(converts(f)).toHaveLength(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toEqual([]);
    expect(f.updates.at(-1)).toMatchObject({ sobject: 'Opportunity', id: NEW_OPP, fields: { StageName: 'Followup' } });
    expect(f.creates.find((c) => c.sobject === 'Task')!.fields).toMatchObject({ Subject: PASSED_SUBJECT, WhatId: NEW_OPP, OwnerId: GRANT });
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', convertedOpportunityId: NEW_OPP, convertedAccountId: ACCOUNT, convertedContactId: CONTACT });
  });

  it('an admin retry days after a failed row: no Event in the past, Followup and the passed-time Task', async () => {
    const s = await bookedOpp();
    await db.update(schema.aiCallWritebacks).set({ attempts: 5 }).where(eq(schema.aiCallWritebacks.id, s.writebackId));
    const f = fakeOrg(oppState(s.recordId));
    f.queries.unshift([BUSY_READ, transportError()]);
    expect((await runWritebacks(depsFor(db, f))).failed).toBe(1);
    f.queries.shift();
    // The admin retry route's update.
    await db.execute(sql`update ai_call_writebacks set status = 'pending', attempts = 0, next_attempt_at = ${DAYS_LATER.toISOString()}::timestamptz, locked_until = null, last_error = null where id = ${s.writebackId}::uuid`);

    expect((await runWritebacks(depsFor(db, f, { now: DAYS_LATER }))).done).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toEqual([]);
    expect(f.updates.find((u) => u.sobject === 'Opportunity')!.fields).toMatchObject({ StageName: 'Followup' });
    expect(f.creates.find((c) => c.sobject === 'Task')!.fields).toMatchObject({ Subject: PASSED_SUBJECT, WhatId: s.recordId });
  });
});

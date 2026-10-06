/**
 * Real Postgres + fake Salesforce: the PATCH never overwrites a rep's newer value (Fix 1, I-3). Before every PATCH the
 * patched fields are read again; a field a rep changed since the plan is left alone and listed under "Not changed", the
 * status guard is re-checked (a rep's stage holds Rating and Next Follow-Up too), and do-not-call flags always apply.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { SalesforceApiError } from '@cti/salesforce';
import { createTestDb, pgLane } from '../test/pg.js';
import { CONTACT, depsFor, fakeOrg, PHONE_BOOKING, RUN_AT, seedWriteback, SETTER, transportError, type OrgState } from '../test/writeback-harness.js';
import { runWritebacks } from './run.js';

const NOT_CHANGED = 'Not changed — a rep edited it since the call';
const later = new Date(RUN_AT.getTime() + 2 * 60_000);

function oppState(recordId: string, over: Record<string, unknown> = {}): { state: OrgState; record: Record<string, unknown> } {
  const record: Record<string, unknown> = { Name: 'Jane Seller', OwnerId: SETTER, StageName: 'Closed Lost', Rating__c: null, Timeline__c: "Didn't Ask", LastModifiedDate: '2026-10-01T12:00:00.000+0000', ...over };
  return { record, state: { records: new Map([[recordId, record]]), lead: null, busy: [], convertedBy: { id: SETTER, at: '2026-01-01T00:00:00.000+0000' } } };
}

describe.skipIf(!pgLane)('runWritebacks re-reads before the PATCH (real Postgres)', () => {
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

  const booked = () => seedWriteback(db, { sfObject: 'Opportunity', outcome: 'appointment_set', researchStatus: 'Closed Lost', appointment: PHONE_BOOKING });
  const changesOf = (fields: Record<string, unknown>) => String(fields.AI_Last_Call_Changes__c);
  const oppPatches = (f: ReturnType<typeof fakeOrg>) => f.updates.filter((u) => u.sobject === 'Opportunity');

  it('a rep edits the stage and a blank between a failed PATCH and its retry: both kept, Rating held with the stage, all listed', async () => {
    const s = await booked();
    const { state, record } = oppState(s.recordId);
    const f = fakeOrg(state);
    f.onUpdate = () => new SalesforceApiError('Composite PATCH failed (503)', 503, null);
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);

    record.StageName = 'Offer Made';
    record.Timeline__c = '30 Days';
    f.onUpdate = null;
    expect((await runWritebacks(depsFor(db, f, { now: later }))).done).toBe(1);
    const patch = oppPatches(f).at(-1)!;
    expect(patch.fields).not.toHaveProperty('StageName');
    expect(patch.fields).not.toHaveProperty('Rating__c');
    expect(patch.fields).not.toHaveProperty('Timeline__c');
    const text = changesOf(patch.fields);
    expect(text).toContain(`${NOT_CHANGED}\n- Stage (now Offer Made)\n- Rating (now (blank))\n- Timeline (now 30 Days)`);
    expect(text).not.toContain('\nChanged\n');
    expect(text).toContain('Created\n- Event: Phone Consultation');
  });

  it('on the first attempt too: a stage changed while the Event was being made is kept; the fill-blank still goes in', async () => {
    const s = await booked();
    const { state, record } = oppState(s.recordId);
    const f = fakeOrg(state);
    f.onCreate = (c) => {
      if (c.sobject === 'Event') record.StageName = 'Pending Appointment';
      return undefined;
    };
    expect((await runWritebacks(depsFor(db, f))).done).toBe(1);
    const patch = oppPatches(f)[0]!;
    expect(patch.fields).not.toHaveProperty('StageName');
    expect(patch.fields).not.toHaveProperty('Rating__c');
    expect(patch.fields).toMatchObject({ Timeline__c: '90 Days' });
    expect(changesOf(patch.fields)).toContain(`${NOT_CHANGED}\n- Stage (now Pending Appointment)`);
    expect(changesOf(patch.fields)).toContain("Changed\n- Timeline: Didn't Ask → 90 Days");
  });

  it('a value already at what the plan writes (our own earlier write, its answer lost) is written again, not "Not changed"', async () => {
    const s = await booked();
    const { state, record } = oppState(s.recordId);
    const f = fakeOrg(state);
    f.onUpdate = (u) => {
      Object.assign(record, u.fields);
      return transportError();
    };
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    f.onUpdate = null;
    expect((await runWritebacks(depsFor(db, f, { now: later }))).done).toBe(1);
    const patch = oppPatches(f).at(-1)!;
    expect(patch.fields).toMatchObject({ StageName: 'Appointment Set', Rating__c: 'Hot', Timeline__c: '90 Days' });
    expect(changesOf(patch.fields)).not.toContain(NOT_CHANGED);
  });

  it('do not call: the flags always apply; a stage a rep moved since the plan is kept with its loss reason', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'do_not_call', researchStatus: 'Followup' });
    const { state, record } = oppState(s.recordId, { StageName: 'Followup', Skip_on_Dialer__c: false });
    const f = fakeOrg(state);
    f.onUpdate = (u) => {
      if (u.sobject === 'Contact') record.StageName = 'Offer Made';
      return undefined;
    };
    expect((await runWritebacks(depsFor(db, f))).done).toBe(1);
    expect(f.updates.find((u) => u.sobject === 'Contact')).toEqual({ sobject: 'Contact', id: CONTACT, fields: { DoNotCall: true } });
    const patch = oppPatches(f)[0]!;
    expect(patch.fields).toMatchObject({ Skip_on_Dialer__c: true });
    expect(patch.fields).not.toHaveProperty('StageName');
    expect(patch.fields).not.toHaveProperty('Loss_Reason__c');
    expect(changesOf(patch.fields)).toContain(`${NOT_CHANGED}\n- Stage (now Offer Made)`);
  });
});

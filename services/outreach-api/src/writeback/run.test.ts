/** Real Postgres + fake Salesforce: the `ai_call.writeback` tick on Opportunity calls, failures and guards (Task 26). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { SalesforceApiError } from '@cti/salesforce';
import { utcDay } from '../ai/budget.js';
import { seedAiCall } from '../test/ai-call-seed.js';
import { seedAiCallCampaign, seedUser } from '../test/call-plan-seed.js';
import { refused } from '../test/fake-sf-writes.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { ACCOUNT, CONTACT, depsFor, fakeModel, fakeOrg, GRANT, PHONE_BOOKING, RUN_AT, seedWriteback, SETTER, transportError, writebackById, type OrgState } from '../test/writeback-harness.js';
import { CHATTER_MAX } from './render.js';
import { runWritebacks } from './run.js';

const MIN = 60_000;
const later = (ms: number) => new Date(RUN_AT.getTime() + ms);

function oppState(recordId: string, over: Record<string, unknown> = {}): OrgState {
  const record = {
    Name: 'Jane Seller',
    OwnerId: SETTER,
    StageName: 'Closed Lost',
    Rating__c: null,
    Timeline__c: "Didn't Ask",
    Street__c: '12 Oak St',
    City__c: 'Fresno',
    State__c: 'CA',
    Zipcode__c: '93701',
    LastModifiedDate: '2026-10-01T12:00:00.000+0000',
    ...over,
  };
  return { records: new Map([[recordId, record]]), lead: null, busy: [], convertedBy: { id: SETTER, at: '2026-01-01T00:00:00.000+0000' } };
}

describe.skipIf(!pgLane)('runWritebacks on Opportunities (real Postgres)', () => {
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
  const changesText = (fields: Record<string, unknown>) => String(fields.AI_Last_Call_Changes__c);

  it('1: Closed Lost, a phone booking, a free calendar: Event, one PATCH with the stage and the changes, one FeedItem; done', async () => {
    const s = await booked();
    const f = fakeOrg(oppState(s.recordId));
    expect(await runWritebacks(depsFor(db, f))).toEqual({ done: 1, partial: 0, skipped: 0, failed: 0, retried: 0 });

    const event = f.creates.find((c) => c.sobject === 'Event')!;
    expect(event.fields).toMatchObject({ Subject: 'Phone Consultation', WhatId: s.recordId, OwnerId: GRANT, StartDateTime: PHONE_BOOKING.start, EndDateTime: PHONE_BOOKING.end, ShowAs: 'Busy', CTI_Origin__c: 'AI Outreach' });
    expect(event.fields).not.toHaveProperty('WhoId');
    expect(String(event.fields.Description)).toContain("Seller's time zone: America/Chicago.");

    expect(f.updates).toHaveLength(1);
    const patch = f.updates[0]!;
    expect(patch).toMatchObject({ sobject: 'Opportunity', id: s.recordId, fields: { StageName: 'Appointment Set', Rating__c: 'Hot', Timeline__c: '90 Days' } });
    expect(changesText(patch.fields)).toContain('Stage: Closed Lost → Appointment Set');
    expect(changesText(patch.fields)).toContain('Timeline: Didn\'t Ask → 90 Days');
    expect(changesText(patch.fields)).toContain('Created\n- Event: Phone Consultation, Wed Oct 7, 11:00 AM PT, owner Grant Golden');

    const posts = f.creates.filter((c) => c.sobject === 'FeedItem');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.fields).toMatchObject({ ParentId: s.recordId, Type: 'TextPost', IsRichText: false });
    const body = String(posts[0]!.fields.Body);
    expect(body.length).toBeLessThanOrEqual(CHATTER_MAX);
    expect(body).toContain(`Call details: https://outreach.example/campaigns/${s.campaignId}?call=${s.aiCallId}`);
    expect(body).toContain('Booked: phone consultation with Grant, Wed Oct 7, 11:00 AM PT');
    expect(body).not.toContain('example.com/listing');
    expect(f.log.filter((l) => l !== 'query' && l !== 'describe')).toEqual(['create Event', 'update Opportunity', 'create FeedItem']);

    expect(await writebackById(db, s.writebackId)).toMatchObject({
      status: 'done',
      lastError: null,
      completedAt: RUN_AT,
      sfEventId: expect.stringMatching(/^00U/),
      sfFeedItemId: expect.stringMatching(/^0D5/),
      model: 'claude-sonnet-5-5',
      inputTokens: 1_000,
      outputTokens: 200,
    });
    const [spend] = await db.select().from(schema.aiUsageDays).where(eq(schema.aiUsageDays.orgId, s.orgId));
    expect(spend?.costMicros).toBeGreaterThan(0);
  });

  it('2: the slot is taken at write time: no Event, Followup with a follow-up time, a conflict Task to the owner; done', async () => {
    const s = await booked();
    const f = fakeOrg({ ...oppState(s.recordId), busy: [{ StartDateTime: '2026-10-07T17:45:00.000+0000', EndDateTime: '2026-10-07T18:30:00.000+0000', IsAllDayEvent: false }] });
    await runWritebacks(depsFor(db, f));
    expect(f.creates.filter((c) => c.sobject === 'Event')).toEqual([]);
    expect(f.updates[0]!.fields).toMatchObject({ StageName: 'Followup', Next_Follow_Up_Date__c: RUN_AT.toISOString() });
    const task = f.creates.find((c) => c.sobject === 'Task')!;
    expect(task.fields).toMatchObject({ OwnerId: GRANT, WhatId: s.recordId, Priority: 'High', Status: 'Open' });
    expect(String(task.fields.Subject)).toContain('the calendar was taken');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', sfTaskId: expect.stringMatching(/^00T/), sfEventId: null });
  });

  it('final review I-1: the slot is taken and the conflict Task is refused: the post says the Task was refused, never that it was sent', async () => {
    const s = await booked();
    const f = fakeOrg({ ...oppState(s.recordId), busy: [{ StartDateTime: '2026-10-07T17:45:00.000+0000', EndDateTime: '2026-10-07T18:30:00.000+0000', IsAllDayEvent: false }] });
    f.onCreate = (c) => (c.sobject === 'Task' ? refused('FIELD_CUSTOM_VALIDATION_EXCEPTION') : undefined);
    await runWritebacks(depsFor(db, f));
    const post = String(f.creates.find((c) => c.sobject === 'FeedItem')!.fields.Body);
    expect(post).toContain('not booked: the calendar was taken (the Task to Grant Golden was refused, FIELD_CUSTOM_VALIDATION_EXCEPTION: follow up by hand)');
    expect(changesText(f.updates[0]!.fields)).not.toContain('Task to Grant Golden: call the seller');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ sfTaskId: null });
  });

  it('final review: UNKNOWN_EXCEPTION on the PATCH is transient: back to pending, never a final "Not written"', async () => {
    const s = await booked();
    const f = fakeOrg(oppState(s.recordId));
    f.onUpdate = () => refused('UNKNOWN_EXCEPTION', 'An unexpected error occurred');
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'pending', lastError: expect.stringContaining('UNKNOWN_EXCEPTION') });
  });

  it('final review: a stored plan that no longer parses fails the row at once, with no Salesforce write and no retries', async () => {
    const s = await booked();
    await db.update(schema.aiCallWritebacks).set({ plan: { sfObject: 'Opportunity', result: 'not-a-result' } }).where(eq(schema.aiCallWritebacks.id, s.writebackId));
    const f = fakeOrg(oppState(s.recordId));
    expect((await runWritebacks(depsFor(db, f))).failed).toBe(1);
    expect(f.creates).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'failed', lastError: 'STORED_PLAN_INVALID' });
  });

  it('5: a 503 on the PATCH after the Event: back to pending with backoff; the next run starts at fields and makes no second Event', async () => {
    const s = await booked();
    const f = fakeOrg(oppState(s.recordId));
    f.onUpdate = () => new SalesforceApiError('Composite PATCH failed (503)', 503, null);
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'pending', attempts: 1, nextAttemptAt: later(MIN), lockedUntil: null, sfEventId: expect.stringMatching(/^00U/) });

    f.onUpdate = null;
    expect((await runWritebacks(depsFor(db, f, { now: later(2 * MIN) }))).done).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(f.creates.filter((c) => c.sobject === 'FeedItem')).toHaveLength(1);
    expect(f.updates).toHaveLength(2);
  });

  it('M4: the post\'s answer is lost: the retry finds it by the call marker and never posts twice; another call\'s post is not ours', async () => {
    const s = await booked();
    const f = fakeOrg(oppState(s.recordId));
    await f.client.createRecords([{ sobject: 'FeedItem', fields: { ParentId: s.recordId, Body: 'AI call 00000000 · Oct 1, 9:00 AM PT · Hung up' } }]);
    f.onCreate = (c) => (c.sobject === 'FeedItem' ? transportError() : undefined);
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    f.onCreate = null;
    expect((await runWritebacks(depsFor(db, f, { now: later(2 * MIN) }))).done).toBe(1);
    const posts = f.creates.filter((c) => c.sobject === 'FeedItem');
    expect(posts).toHaveLength(2);
    expect(String(posts[1]!.fields.Body).startsWith(`AI call ${s.aiCallId.slice(0, 8)} · `)).toBe(true);
    expect(f.soql.some((q) => q.startsWith(`SELECT Id, Body FROM FeedItem WHERE ParentId = '${s.recordId}' AND Type = 'TextPost' AND CreatedDate >= `))).toBe(true);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', sfFeedItemId: '0D58X0000000010AAA' });
  });

  it('6: no mapping model: the status moves are still written and the changes text says fill-blanks were skipped', async () => {
    const s = await booked();
    const f = fakeOrg(oppState(s.recordId));
    await runWritebacks(depsFor(db, f, { model: null }));
    expect(f.updates[0]!.fields).toMatchObject({ StageName: 'Appointment Set' });
    expect(f.updates[0]!.fields).not.toHaveProperty('Timeline__c');
    expect(changesText(f.updates[0]!.fields)).toContain('Fill-blanks skipped: the answer mapping was unavailable');
  });

  it('7: the record is gone (no row, or ENTITY_IS_DELETED on the PATCH): skipped', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'not_interested', researchStatus: 'Followup' });
    const f = fakeOrg({ ...oppState('none'), records: new Map() });
    expect((await runWritebacks(depsFor(db, f))).skipped).toBe(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'skipped', lastError: 'record gone or converted' });
    expect(f.updates).toEqual([]);

    const t = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'not_interested', researchStatus: 'Followup' });
    const g = fakeOrg(oppState(t.recordId, { StageName: 'Followup' }));
    g.onUpdate = () => refused('ENTITY_IS_DELETED', 'entity is deleted');
    expect((await runWritebacks(depsFor(db, g))).skipped).toBe(1);
    expect(await writebackById(db, t.writebackId)).toMatchObject({ status: 'skipped', lastError: 'ENTITY_IS_DELETED' });
  });

  it('8: the daily AI budget is spent: the row waits until the next UTC midnight and the attempt is given back', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'qualified_callback', researchStatus: 'Closed Lost', settings: { aiDailyBudgetUsd: 1 } });
    await db.insert(schema.aiUsageDays).values({ orgId: s.orgId, day: utcDay(RUN_AT), costMicros: 1_000_000 });
    const model = fakeModel();
    const f = fakeOrg(oppState(s.recordId));
    expect((await runWritebacks(depsFor(db, f, { model }))).retried).toBe(1);
    expect(model.calls).toBe(0);
    expect(f.creates).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: new Date('2026-10-07T00:00:00.000Z'), plan: null });
  });

  it('8b: a booked call never waits for the budget and still maps the seller\'s answers: the spend is recorded past the cap', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'appointment_set', researchStatus: 'Closed Lost', appointment: PHONE_BOOKING, settings: { aiDailyBudgetUsd: 1 } });
    await db.insert(schema.aiUsageDays).values({ orgId: s.orgId, day: utcDay(RUN_AT), costMicros: 1_000_000 });
    const model = fakeModel();
    const f = fakeOrg(oppState(s.recordId));
    expect((await runWritebacks(depsFor(db, f, { model }))).done).toBe(1);
    expect(model.calls).toBe(1);
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(f.updates[0]!.fields).toMatchObject({ StageName: 'Appointment Set', Timeline__c: '90 Days' });
    expect(changesText(f.updates[0]!.fields)).not.toContain('Fill-blanks skipped');
    const [spend] = await db.select().from(schema.aiUsageDays).where(eq(schema.aiUsageDays.orgId, s.orgId));
    expect(spend!.costMicros).toBeGreaterThan(1_000_000);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: 1_000, outputTokens: 200 });
  });

  it('a hang-up with nothing learned writes nothing at all: skipped', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'hung_up', researchStatus: 'Followup' });
    const f = fakeOrg(oppState(s.recordId, { StageName: 'Followup' }));
    expect((await runWritebacks(depsFor(db, f, { model: fakeModel({ disposition: 'unknown', values: {} }) }))).skipped).toBe(1);
    expect(f.updates).toEqual([]);
    expect(f.creates).toEqual([]);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'skipped', lastError: 'nothing to write' });
  });

  it('9: a test or practice call (one that booked, too) is skipped before any Salesforce request', async () => {
    const base = await seedAiCallCampaign(db, 'active');
    const admin = await seedUser(db, base.orgId);
    const aiCallId = await seedAiCall(db, base.orgId, admin, { isTest: true, practice: true, status: 'completed', outcome: 'appointment_set', appointment: PHONE_BOOKING });
    const [row] = await db
      .insert(schema.aiCallWritebacks)
      .values({ orgId: base.orgId, aiCallId, sfObject: 'Lead', sfRecordId: '00Q8X00000Prac1QAA', outcome: 'appointment_set', nextAttemptAt: RUN_AT })
      .returning({ id: schema.aiCallWritebacks.id });
    const f = fakeOrg(oppState('none'));
    let clientsAsked = 0;
    const deps = depsFor(db, f, {
      clients: async () => {
        clientsAsked += 1;
        return f.client;
      },
    });
    expect((await runWritebacks(deps)).skipped).toBe(1);
    expect(clientsAsked).toBe(0);
    expect(f.log).toEqual([]);
    expect(await writebackById(db, row!.id)).toMatchObject({ status: 'skipped', lastError: 'test call' });
  });

  it('10: do not call on an open Opportunity: Closed Lost, Skip on Dialer, and the primary contact\'s DoNotCall', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'do_not_call', researchStatus: 'Followup' });
    const f = fakeOrg(oppState(s.recordId, { StageName: 'Followup', Skip_on_Dialer__c: false }));
    await runWritebacks(depsFor(db, f));
    expect(f.soql).toContain(`SELECT ContactId FROM OpportunityContactRole WHERE OpportunityId = '${s.recordId}' AND IsPrimary = true LIMIT 1`);
    expect(f.updates.find((u) => u.sobject === 'Contact')).toEqual({ sobject: 'Contact', id: CONTACT, fields: { DoNotCall: true } });
    expect(f.updates.find((u) => u.sobject === 'Opportunity')!.fields).toMatchObject({ StageName: 'Closed Lost', Skip_on_Dialer__c: true, Loss_Reason__c: 'Hostile/Remove From List' });
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done' });
  });

  it('a refused contact do-not-call flag is recorded in its own section and the row is partial', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'do_not_call', researchStatus: 'Followup' });
    const f = fakeOrg(oppState(s.recordId, { StageName: 'Followup' }));
    f.onUpdate = (u) => (u.sobject === 'Contact' ? refused('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY', 'no') : undefined);
    await runWritebacks(depsFor(db, f));
    expect(changesText(f.updates.find((u) => u.sobject === 'Opportunity')!.fields)).toContain('Could not set do-not-call flag\n- Contact Do Not Call: Salesforce refused (INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY)');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'partial', lastError: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' });
  });

  it('M8: do not call on a Person Account\'s Opportunity: the Account\'s PersonDoNotCall, never the person contact\'s DoNotCall', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'do_not_call', researchStatus: 'Followup' });
    const f = fakeOrg({ ...oppState(s.recordId, { StageName: 'Followup' }), personAccount: true });
    expect((await runWritebacks(depsFor(db, f))).done).toBe(1);
    expect(f.soql).toContain(`SELECT AccountId, Account.IsPersonAccount FROM Opportunity WHERE Id = '${s.recordId}' LIMIT 1`);
    expect(f.updates.find((u) => u.sobject === 'Account')).toEqual({ sobject: 'Account', id: ACCOUNT, fields: { PersonDoNotCall: true } });
    expect(f.updates.some((u) => u.sobject === 'Contact')).toBe(false);
    expect(f.soql.some((q) => q.includes('OpportunityContactRole'))).toBe(false);
  });

  it('M8: a refused PersonDoNotCall is recorded in the do-not-call section with its field, and the row is partial', async () => {
    const s = await seedWriteback(db, { sfObject: 'Opportunity', outcome: 'do_not_call', researchStatus: 'Followup' });
    const f = fakeOrg({ ...oppState(s.recordId, { StageName: 'Followup' }), personAccount: true });
    f.onUpdate = (u) => (u.sobject === 'Account' ? refused('INSUFFICIENT_ACCESS_OR_READONLY', 'no', ['PersonDoNotCall']) : undefined);
    await runWritebacks(depsFor(db, f));
    expect(changesText(f.updates.find((u) => u.sobject === 'Opportunity')!.fields)).toContain('Could not set do-not-call flag\n- Account Do Not Call: Salesforce refused (INSUFFICIENT_ACCESS_OR_READONLY)');
    const row = await writebackById(db, s.writebackId);
    expect(row).toMatchObject({ status: 'partial', lastError: 'INSUFFICIENT_ACCESS_OR_READONLY' });
    expect((row.steps as { fields: { data: { notWritten: unknown[] } } }).fields.data.notWritten).toEqual([expect.objectContaining({ field: 'PersonDoNotCall', label: 'Account Do Not Call' })]);
  });

  it('a transient failure on the last attempt ends the row failed, never thrown out of the tick', async () => {
    const s = await booked();
    await db.update(schema.aiCallWritebacks).set({ attempts: 5 }).where(eq(schema.aiCallWritebacks.id, s.writebackId));
    const f = fakeOrg(oppState(s.recordId));
    f.queries.unshift([/ FROM Opportunity WHERE Id = /, new SalesforceApiError('SOQL failed (503)', 503, null)]);
    expect(await runWritebacks(depsFor(db, f))).toMatchObject({ failed: 1 });
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'failed', attempts: 6, completedAt: RUN_AT });
  });
});

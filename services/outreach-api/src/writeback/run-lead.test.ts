/** Real Postgres + fake Salesforce: the `ai_call.writeback` tick on Lead calls, conversion and its fallback (Task 26). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { convertRefused, refused } from '../test/fake-sf-writes.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { ACCOUNT, CONTACT, depsFor, fakeOrg, GRANT, NEW_OPP, PHONE_BOOKING, RUN_AT, seedWriteback, SETTER, transportError, writebackById, type OrgState } from '../test/writeback-harness.js';
import { runWritebacks } from './run.js';

const REP_OPP = '0068X00000RepOpQAA';
const leadRow = (id: string, over: Record<string, unknown> = {}) => ({
  Id: id,
  Name: 'Jane Seller',
  OwnerId: SETTER,
  IsConverted: false,
  ConvertedOpportunityId: null,
  ConvertedAccountId: null,
  ConvertedContactId: null,
  AI_Call_Consent__c: true,
  AI_Call_Consent_Date__c: '2026-09-30',
  AI_Call_Consent_Source__c: 'Web Form',
  Spanish_Speaker__c: false,
  Skip_on_Dialer__c: false,
  ...over,
});
const newOpp = (over: Record<string, unknown> = {}) => ({
  Name: 'Jane Seller',
  OwnerId: GRANT,
  StageName: 'New Opportunity',
  Rating__c: null,
  Timeline__c: null,
  AI_Call_Consent__c: false,
  AI_Call_Consent_Date__c: null,
  AI_Call_Consent_Source__c: null,
  LeadManager__c: null,
  ...over,
});

function leadState(leadId: string, over: Partial<OrgState> = {}): OrgState {
  return {
    records: new Map<string, Record<string, unknown>>([
      [leadId, { Name: 'Jane Seller', OwnerId: SETTER, Status: 'Long Term Follow-Up', Rating: null, IsConverted: false, LastModifiedDate: '2026-10-01T12:00:00.000+0000' }],
      [NEW_OPP, newOpp()],
      [REP_OPP, newOpp({ OwnerId: SETTER, LeadManager__c: SETTER })],
    ]),
    lead: leadRow(leadId),
    busy: [],
    convertedBy: { id: SETTER, at: '2026-01-01T00:00:00.000+0000' },
    ...over,
  };
}

describe.skipIf(!pgLane)('runWritebacks on Leads (real Postgres)', () => {
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

  const bookedLead = (settings?: Record<string, unknown>) =>
    seedWriteback(db, { sfObject: 'Lead', outcome: 'appointment_set', researchStatus: 'Long Term Follow-Up', appointment: PHONE_BOOKING, ...(settings ? { settings } : {}) });
  const converts = (f: ReturnType<typeof fakeOrg>) => f.soapBodies.filter((b) => b.includes('<urn:convertLead'));
  const changesOf = (fields: Record<string, unknown>) => String(fields.AI_Last_Call_Changes__c);

  it('3: a booked LTFU Lead: converted once (owner Grant, Qualified), carried before the Event, then written as its Opportunity; done', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    expect((await runWritebacks(depsFor(db, f))).done).toBe(1);

    expect(converts(f)).toHaveLength(1);
    expect(converts(f)[0]).toContain(`<urn:ownerId>${GRANT}</urn:ownerId>`);
    expect(converts(f)[0]).toContain('<urn:convertedStatus>Qualified</urn:convertedStatus>');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', convertedOpportunityId: NEW_OPP, convertedAccountId: ACCOUNT, convertedContactId: CONTACT, sfEventId: expect.any(String) });

    const [carry, main] = f.updates;
    expect(carry).toEqual({ sobject: 'Opportunity', id: NEW_OPP, fields: { AI_Call_Consent__c: true, AI_Call_Consent_Date__c: '2026-09-30', AI_Call_Consent_Source__c: 'Web Form', LeadManager__c: SETTER } });
    expect(f.log.indexOf('update Opportunity')).toBeLessThan(f.log.indexOf('create Event'));
    expect(f.creates.find((c) => c.sobject === 'Event')!.fields).toMatchObject({ WhatId: NEW_OPP, OwnerId: GRANT, Subject: 'Phone Consultation' });
    expect(main).toMatchObject({ sobject: 'Opportunity', id: NEW_OPP, fields: { StageName: 'Appointment Set', Rating__c: 'Hot', Timeline__c: '90 Days' } });
    expect(changesOf(main!.fields)).toContain('Converted Lead "Jane Seller" into this Opportunity (owner Grant Golden); new Account and Contact');
    expect(f.creates.find((c) => c.sobject === 'FeedItem')!.fields).toMatchObject({ ParentId: NEW_OPP });
    // Nothing is written to the Lead after the conversion.
    expect(f.updates.filter((u) => u.sobject === 'Lead')).toEqual([]);
    expect(f.creates.filter((c) => Object.values(c.fields).includes(s.recordId))).toEqual([]);
  });

  it('3b: the convertLead answer is lost after Salesforce converted: the retry adopts it (ours), never converts again; one Event, one post', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    const answer = f.onSoap!;
    f.onSoap = (body) => {
      const a = answer(body);
      return body.includes('<urn:convertLead') ? transportError() : a;
    };
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'pending', convertedOpportunityId: null });

    expect((await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 2 * 60_000) }))).done).toBe(1);
    expect(converts(f)).toHaveLength(1);
    expect(f.soapBodies.some((b) => b.includes('getUserInfo'))).toBe(true);
    expect(f.updates[0]!.fields).toMatchObject({ LeadManager__c: SETTER });
    expect(f.creates.filter((c) => c.sobject === 'Event')).toHaveLength(1);
    expect(f.creates.filter((c) => c.sobject === 'FeedItem')).toHaveLength(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', convertedOpportunityId: NEW_OPP });
  });

  it('final review: conversion switched off after our conversion was saved: the retry adopts it, never "Lead not converted"', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    let failCarry = true;
    f.onUpdate = (c) => {
      if (c.sobject === 'Opportunity' && failCarry) {
        failCarry = false;
        return transportError();
      }
      return undefined;
    };
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'pending', convertedOpportunityId: NEW_OPP });
    await db.execute(sql`update organizations set settings = jsonb_set(settings, '{aiCallBooking,convertLeads}', 'false'::jsonb) where id = ${s.orgId}::uuid`);
    expect((await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 2 * 60_000) }))).done).toBe(1);
    expect(converts(f)).toHaveLength(1);
    const main = f.updates.filter((u) => u.sobject === 'Opportunity' && 'AI_Last_Call_Changes__c' in u.fields).at(-1)!;
    expect(changesOf(main.fields)).not.toContain('Lead not converted');
    expect(changesOf(main.fields)).toContain('Converted Lead "Jane Seller" into this Opportunity');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', convertedOpportunityId: NEW_OPP });
  });

  it('M11: adopting our own lost-answer conversion, a Lead Manager set since then is kept (fill-blank rule)', async () => {
    const s = await bookedLead();
    const state = leadState(s.recordId);
    const f = fakeOrg(state);
    const answer = f.onSoap!;
    f.onSoap = (body) => {
      const a = answer(body);
      return body.includes('<urn:convertLead') ? transportError() : a;
    };
    expect((await runWritebacks(depsFor(db, f))).retried).toBe(1);
    state.records.set(NEW_OPP, newOpp({ LeadManager__c: GRANT }));
    expect((await runWritebacks(depsFor(db, f, { now: new Date(RUN_AT.getTime() + 2 * 60_000) }))).done).toBe(1);
    const carry = f.updates[0]!;
    expect(carry).toMatchObject({ sobject: 'Opportunity', id: NEW_OPP });
    expect(carry.fields).not.toHaveProperty('LeadManager__c');
    expect(carry.fields).toMatchObject({ AI_Call_Consent__c: true });
  });

  it('3c: Salesforce refuses the conversion (the Hunt rule): hold + Task to Grant with the reason, Working and Hot, post on the Lead; partial', async () => {
    const s = await bookedLead();
    const f = fakeOrg(leadState(s.recordId));
    f.onSoap = () => convertRefused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Hunt Leads are converted by the Hunt winner');
    expect((await runWritebacks(depsFor(db, f))).partial).toBe(1);
    const hold = f.creates.find((c) => c.sobject === 'Event')!;
    expect(String(hold.fields.Subject)).toMatch(/^Hold: AI-booked phone call/);
    expect(hold.fields).toMatchObject({ OwnerId: GRANT });
    expect(hold.fields).not.toHaveProperty('WhatId');
    expect(hold.fields).not.toHaveProperty('WhoId');
    const task = f.creates.find((c) => c.sobject === 'Task')!;
    expect(task.fields).toMatchObject({ OwnerId: GRANT, WhoId: s.recordId });
    expect(String(task.fields.Description)).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(f.updates).toEqual([expect.objectContaining({ sobject: 'Lead', id: s.recordId, fields: expect.objectContaining({ Status: 'Working', Rating: 'Hot' }) })]);
    expect(changesOf(f.updates[0]!.fields)).toContain('Lead not converted: FIELD_CUSTOM_VALIDATION_EXCEPTION');
    expect(f.creates.find((c) => c.sobject === 'FeedItem')!.fields).toMatchObject({ ParentId: s.recordId });
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'partial', lastError: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', convertedOpportunityId: null });
  });

  describe('final review I-1: the changes text and the post say only what the fallback made', () => {
    const postOf = (f: ReturnType<typeof fakeOrg>) => String(f.creates.find((c) => c.sobject === 'FeedItem')!.fields.Body);
    const refusing = (sobjects: string[], code: string) => (c: { sobject: string }) => (sobjects.includes(c.sobject) ? refused(code) : undefined);
    const refusedConversion = (f: ReturnType<typeof fakeOrg>) => {
      f.onSoap = () => convertRefused('INSUFFICIENT_ACCESS', 'no Convert Leads permission');
    };

    it('a refused hold: no hold is claimed; the Task is', async () => {
      const s = await bookedLead();
      const f = fakeOrg(leadState(s.recordId));
      refusedConversion(f);
      f.onCreate = refusing(['Event'], 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY');
      await runWritebacks(depsFor(db, f));
      const changes = changesOf(f.updates[0]!.fields);
      expect(changes).toContain('a "convert and book" Task was created, but no hold could be put on the calendar (INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY)');
      expect(changes).not.toContain('a hold and a "convert and book" Task were created');
      expect(changes).not.toContain('Hold on');
      const post = postOf(f);
      expect(post).toContain('not held: Salesforce refused the hold');
      expect(post).not.toContain("held on Grant Golden's calendar");
      expect(post).not.toContain('a hold and a "convert and book" Task were created');
    });

    it('a refused Task: the hold is claimed; the Task is said to be refused', async () => {
      const s = await bookedLead();
      const f = fakeOrg(leadState(s.recordId));
      refusedConversion(f);
      f.onCreate = refusing(['Task'], 'FIELD_CUSTOM_VALIDATION_EXCEPTION');
      await runWritebacks(depsFor(db, f));
      const changes = changesOf(f.updates[0]!.fields);
      expect(changes).toContain('a hold was put on the calendar, but Salesforce refused the "convert and book" Task (FIELD_CUSTOM_VALIDATION_EXCEPTION)');
      expect(changes).not.toContain('Task to Grant Golden: convert the Lead');
      const post = postOf(f);
      expect(post).toContain('the Task to Grant Golden was refused, FIELD_CUSTOM_VALIDATION_EXCEPTION');
      expect(post).not.toContain('(Task to Grant Golden)');
    });

    it('both refused (no ConvertLeads and no EditEvent): nothing is claimed made, and both texts say to book it by hand', async () => {
      const s = await bookedLead();
      const f = fakeOrg(leadState(s.recordId));
      refusedConversion(f);
      f.onCreate = refusing(['Event', 'Task'], 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY');
      await runWritebacks(depsFor(db, f));
      const changes = changesOf(f.updates[0]!.fields);
      expect(changes).toContain('Salesforce refused both the hold and the "convert and book" Task: nothing is on the calendar, book it by hand');
      expect(changes).not.toMatch(/were created|was created|was put on the calendar|\nCreated\n/);
      const post = postOf(f);
      expect(post).toContain('Salesforce refused both the hold and the "convert and book" Task');
      expect(post).not.toMatch(/were created|held on|\(Task to/);
      expect(await writebackById(db, s.writebackId)).toMatchObject({ sfEventId: null, sfTaskId: null });
    });
  });

  it('3d: conversion switched off: no SOAP at all, the fallback, and the row is done', async () => {
    const s = await bookedLead({ aiCallBooking: { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT], convertLeads: false } });
    const f = fakeOrg(leadState(s.recordId));
    expect((await runWritebacks(depsFor(db, f))).done).toBe(1);
    expect(f.soapBodies).toEqual([]);
    expect(String(f.creates.find((c) => c.sobject === 'Event')!.fields.Subject)).toMatch(/^Hold: AI-booked/);
    expect(f.creates.find((c) => c.sobject === 'Task')!.fields).toMatchObject({ OwnerId: GRANT });
    expect(f.updates[0]!.fields).toMatchObject({ Status: 'Working', Rating: 'Hot' });
  });

  it('3e: a rep converted the Lead first: no convertLead, no carry (owner and Lead Manager untouched), the Event on that Opportunity is Grant\'s', async () => {
    const s = await bookedLead();
    const state = leadState(s.recordId, { convertedBy: { id: SETTER, at: '2026-10-06T22:15:00.000+0000', name: 'Sam Setter' } });
    state.lead = leadRow(s.recordId, { IsConverted: true, ConvertedOpportunityId: REP_OPP, ConvertedAccountId: ACCOUNT, ConvertedContactId: CONTACT });
    const g = fakeOrg(state);
    await runWritebacks(depsFor(db, g));
    expect(converts(g)).toEqual([]);
    expect(g.updates.some((u) => 'LeadManager__c' in u.fields || 'OwnerId' in u.fields)).toBe(false);
    expect(g.updates).toHaveLength(1);
    expect(g.creates.find((c) => c.sobject === 'Event')!.fields).toMatchObject({ WhatId: REP_OPP, OwnerId: GRANT });
    expect(changesOf(g.updates[0]!.fields)).toContain('- Lead was already converted by Sam Setter; wrote to its Opportunity');
    const post = String(g.creates.find((c) => c.sobject === 'FeedItem')!.fields.Body);
    expect(post).toContain('\nLead was already converted by Sam Setter.\n');
    expect(post).not.toContain('by the AI');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'done', convertedOpportunityId: REP_OPP });
  });

  it('3f: converted without an Opportunity: a Task on the Account to Grant, nothing else; partial', async () => {
    const s = await bookedLead();
    const state = leadState(s.recordId);
    state.lead = leadRow(s.recordId, { IsConverted: true, ConvertedAccountId: ACCOUNT, ConvertedContactId: CONTACT });
    const f = fakeOrg(state);
    expect((await runWritebacks(depsFor(db, f))).partial).toBe(1);
    expect(f.creates.map((c) => c.sobject)).toEqual(['Task']);
    expect(f.creates[0]!.fields).toMatchObject({ WhatId: ACCOUNT, OwnerId: GRANT });
    expect(String(f.creates[0]!.fields.Subject)).toContain('already converted without an Opportunity');
    expect(f.updates).toEqual([]);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'partial', lastError: 'CONVERTED_WITHOUT_OPPORTUNITY', sfTaskId: expect.any(String) });
  });

  it('4: Salesforce refuses Status on the Lead PATCH: retried without it, listed as refused in the changes; partial', async () => {
    const s = await seedWriteback(db, { sfObject: 'Lead', outcome: 'qualified_callback', researchStatus: 'New' });
    const state = leadState(s.recordId);
    state.records.set(s.recordId, { Name: 'Jane Seller', OwnerId: SETTER, Status: 'New', Rating: null, IsConverted: false });
    const f = fakeOrg(state);
    f.onUpdate = (u) => ('Status' in u.fields ? refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Queue Leads keep their Status', ['status']) : undefined);
    expect((await runWritebacks(depsFor(db, f))).partial).toBe(1);
    expect(f.updates).toHaveLength(2);
    expect(f.updates[1]!.fields).not.toHaveProperty('Status');
    expect(f.updates[1]!.fields).toMatchObject({ Rating: 'Warm', Timeline__c: '90 Days' });
    const text = changesOf(f.updates[1]!.fields);
    expect(text).toContain('Not written\n- Status: Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)');
    expect(text).not.toContain('Status: New → Working');
    expect(f.soapBodies).toEqual([]);
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'partial', lastError: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });

  it('a whole-record refusal (no field list): one more PATCH with only the changes field, every change listed as not written', async () => {
    const s = await seedWriteback(db, { sfObject: 'Lead', outcome: 'qualified_callback', researchStatus: 'New' });
    const state = leadState(s.recordId);
    state.records.set(s.recordId, { Name: 'Jane Seller', OwnerId: SETTER, Status: 'New', Rating: null, IsConverted: false });
    const f = fakeOrg(state);
    f.onUpdate = (u) => (Object.keys(u.fields).length > 1 ? refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Spam lock') : undefined);
    await runWritebacks(depsFor(db, f));
    expect(Object.keys(f.updates[1]!.fields)).toEqual(['AI_Last_Call_Changes__c']);
    expect(changesOf(f.updates[1]!.fields)).toContain('- Status: Salesforce refused (FIELD_CUSTOM_VALIDATION_EXCEPTION)');
    expect(await writebackById(db, s.writebackId)).toMatchObject({ status: 'partial', lastError: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });

  it('a non-booking Lead a rep converted since the call is never written: skipped', async () => {
    const s = await seedWriteback(db, { sfObject: 'Lead', outcome: 'not_interested', researchStatus: 'New' });
    const state = leadState(s.recordId);
    state.records.set(s.recordId, { Name: 'Jane Seller', Status: 'Qualified', IsConverted: true });
    const f = fakeOrg(state);
    expect((await runWritebacks(depsFor(db, f))).skipped).toBe(1);
    expect(f.updates).toEqual([]);
    expect(f.soapBodies).toEqual([]);
  });
});

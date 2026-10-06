/** Task 23: the appointment Event at write time (re-checked, never doubled), and the fallback hold + Task. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { fakeSfWrites, ok, refused, type WriteQueryRoute } from '../test/fake-sf-writes.js';
import { bookOpportunity, createTaskOnce, holdForLead, leadHoldFields, opportunityEventFields, taskFields } from './appointment.js';

const OWNER = '0058X00000Fsx39QAB';
const OPP = '0068X00000Oppt1QAA';
const LEAD = '00Q8X00000AbCdEUAV';
const AI_CALL = '6f0c2a9e-1b2c-4d5e-8f90-123456789abc';
const PHONE: BookedAppointment = {
  slotId: 'p1',
  kind: 'phone',
  start: '2026-10-07T18:00:00.000Z',
  end: '2026-10-07T18:15:00.000Z',
  specialistSfUserId: OWNER,
  addressConfirmed: false,
  note: '',
  bookedAt: '2026-10-06T22:10:00.000Z',
};
const WALK: BookedAppointment = { ...PHONE, slotId: 'w1', kind: 'walkthrough', start: '2026-10-08T17:00:00.000Z', end: '2026-10-08T18:00:00.000Z', addressConfirmed: true, note: 'Gate code is on the side door' };
const ADDRESS = '12 Oak St, Fresno, CA 93701';

const EXISTING_EVENT = /^SELECT Id FROM Event WHERE WhatId = /;
const HOLD_LOOKUP = /^SELECT Id FROM Event WHERE WhatId = null /;
const BUSY = /^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate FROM Event /;
const TASK_LOOKUP = /^SELECT Id FROM Task /;

function org(routes: WriteQueryRoute[] = []) {
  return fakeSfWrites({ queries: [...routes, [EXISTING_EVENT, []], [HOLD_LOOKUP, []], [BUSY, []], [TASK_LOOKUP, []]] });
}
const book = (f: ReturnType<typeof org>, booked = PHONE, bufferMinutes = 30) =>
  bookOpportunity(f.client, { oppId: OPP, booked, location: ADDRESS, aiCallId: AI_CALL, sellerTimeZone: 'America/Chicago', bufferMinutes });

describe('bookOpportunity', () => {
  it('I-1: the booked time has passed: an Event an earlier attempt made is still found; otherwise expired, no calendar read, no create', async () => {
    const late = new Date('2026-10-07T19:00:00.000Z');
    const f = org([[EXISTING_EVENT, [{ Id: '00U8X00000Evnt1QAA' }]]]);
    expect(await bookOpportunity(f.client, { oppId: OPP, booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0, now: late })).toEqual({ kind: 'existing', eventId: '00U8X00000Evnt1QAA' });
    const g = org();
    expect(await bookOpportunity(g.client, { oppId: OPP, booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0, now: late })).toEqual({ kind: 'expired' });
    expect(g.soql.some((q) => BUSY.test(q))).toBe(false);
    expect(g.creates).toEqual([]);
  });

  it('1: no Event yet and a free calendar: creates it like reps do (body pinned)', async () => {
    const f = org();
    expect(await book(f)).toEqual({ kind: 'created', eventId: expect.stringMatching(/^00U/) });
    expect(f.soql[0]).toBe(
      `SELECT Id FROM Event WHERE WhatId = '${OPP}' AND OwnerId = '${OWNER}' AND StartDateTime = 2026-10-07T18:00:00Z AND CTI_Origin__c = 'AI Outreach' LIMIT 1`,
    );
    // The re-check covers exactly the slot: a phone call has no buffer.
    expect(f.soql[1]).toContain('StartDateTime < 2026-10-07T18:15:00Z AND EndDateTime > 2026-10-07T18:00:00Z');
    expect(f.creates).toEqual([
      {
        sobject: 'Event',
        fields: {
          Subject: 'Phone Consultation',
          WhatId: OPP,
          OwnerId: OWNER,
          StartDateTime: PHONE.start,
          EndDateTime: PHONE.end,
          IsAllDayEvent: false,
          ShowAs: 'Busy',
          Description: `Booked by the AI assistant on a call (AI call ${AI_CALL}). Seller's time zone: America/Chicago.`,
          CTI_Origin__c: 'AI Outreach',
        },
      },
    ]);
    expect(f.creates[0]!.fields).not.toHaveProperty('WhoId');
    expect(f.creates[0]!.fields).not.toHaveProperty('Location');
  });

  it('2: an Event we already made is found: existing, nothing created', async () => {
    const f = org([[EXISTING_EVENT, [{ Id: '00U8X00000Evnt1QAA' }]]]);
    expect(await book(f)).toEqual({ kind: 'existing', eventId: '00U8X00000Evnt1QAA' });
    expect(f.creates).toEqual([]);
  });

  it('3: a busy overlap at the slot: conflict, nothing created', async () => {
    const f = org([[BUSY, [{ StartDateTime: '2026-10-07T18:10:00.000+0000', EndDateTime: '2026-10-07T18:40:00.000+0000', IsAllDayEvent: false }]]]);
    expect(await book(f)).toEqual({ kind: 'conflict' });
    expect(f.creates).toEqual([]);
  });

  it('D-11: conflict is the slots rule, not "any item returned": touching time is free; the buffer counts for a walkthrough only', async () => {
    const touching = org([[BUSY, [{ StartDateTime: '2026-10-07T17:30:00.000+0000', EndDateTime: '2026-10-07T18:00:00.000+0000', IsAllDayEvent: false }]]]);
    expect((await book(touching)).kind).toBe('created');
    // 20 minutes before a walkthrough: inside its 30-minute buffer.
    const nearWalk = [{ StartDateTime: '2026-10-08T16:20:00.000+0000', EndDateTime: '2026-10-08T16:40:00.000+0000', IsAllDayEvent: false }];
    expect((await book(org([[BUSY, nearWalk]]), WALK)).kind).toBe('conflict');
    expect((await book(org([[BUSY, nearWalk]]), WALK, 0)).kind).toBe('created');
    // The same distance before a phone call: a phone call has no buffer whatever the setting.
    const nearPhone = [{ StartDateTime: '2026-10-07T17:20:00.000+0000', EndDateTime: '2026-10-07T17:40:00.000+0000', IsAllDayEvent: false }];
    expect((await book(org([[BUSY, nearPhone]]), PHONE, 30)).kind).toBe('created');
  });

  it('an all-day Event on the owner\'s day blocks the slot', async () => {
    const f = org([[BUSY, [{ StartDateTime: '2026-10-07T00:00:00.000+0000', EndDateTime: '2026-10-07T00:00:00.000+0000', IsAllDayEvent: true, ActivityDate: '2026-10-07' }]]]);
    expect(await book(f)).toEqual({ kind: 'conflict' });
  });

  it('4: INVALID_FIELD on CTI_Origin__c: one retry without it, created', async () => {
    const f = org();
    f.onCreate = (c) => ('CTI_Origin__c' in c.fields ? refused('INVALID_FIELD', 'No such column \'CTI_Origin__c\' on sobject of type Event') : undefined);
    expect((await book(f)).kind).toBe('created');
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]!.fields).not.toHaveProperty('CTI_Origin__c');
  });

  it('5: a validation rule refuses the Event: refused with its code', async () => {
    const f = org();
    f.onCreate = () => refused('FIELD_CUSTOM_VALIDATION_EXCEPTION', 'Owner must be active');
    expect(await book(f)).toEqual({ kind: 'refused', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
    expect(f.creates).toHaveLength(1);
  });

  it('6: a walkthrough is a Property Consultation at the address; a phone call has no Location', async () => {
    const f = org();
    await book(f, WALK);
    expect(f.creates[0]!.fields).toMatchObject({ Subject: 'Property Consultation', Location: ADDRESS });
    expect(f.creates[0]!.fields.Description).toBe(
      `Booked by the AI assistant on a call (AI call ${AI_CALL}). Seller's note: Gate code is on the side door. Seller's time zone: America/Chicago. Address confirmed with the seller.`,
    );
    expect(opportunityEventFields({ oppId: OPP, booked: PHONE, location: ADDRESS, aiCallId: AI_CALL, sellerTimeZone: null })).not.toHaveProperty('Location');
  });

  it('refuses a malformed id before any Salesforce call', async () => {
    const f = org();
    await expect(bookOpportunity(f.client, { oppId: "006'; x", booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0 })).rejects.toThrow(RangeError);
    expect(f.log).toEqual([]);
  });
});

describe('holdForLead (fallback only)', () => {
  const hold = (f: ReturnType<typeof org>) =>
    holdForLead(f.client, { leadId: LEAD, leadName: 'Jane Seller', booked: PHONE, aiCallId: AI_CALL, ownerName: 'Grant Golden', reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt Lead', today: '2026-10-06' });

  it('7: the hold Event is the appointment owner\'s, with no WhoId or WhatId', async () => {
    const f = org();
    const r = await hold(f);
    expect(r).toEqual({ kind: 'lead_hold', eventId: expect.stringMatching(/^00U/), taskId: expect.stringMatching(/^00T/) });
    expect(f.soql[0]).toBe(
      `SELECT Id FROM Event WHERE WhatId = null AND WhoId = null AND OwnerId = '${OWNER}' AND StartDateTime = 2026-10-07T18:00:00Z AND CTI_Origin__c = 'AI Outreach' AND Subject LIKE 'Hold: AI-booked%' LIMIT 1`,
    );
    const event = f.creates.find((c) => c.sobject === 'Event')!;
    expect(event.fields).toEqual(leadHoldFields({ booked: PHONE, leadName: 'Jane Seller', leadId: LEAD, aiCallId: AI_CALL }));
    expect(event.fields.Subject).toBe('Hold: AI-booked phone call – convert Jane Seller');
    expect(event.fields).toMatchObject({ OwnerId: OWNER, StartDateTime: PHONE.start, EndDateTime: PHONE.end, ShowAs: 'Busy', CTI_Origin__c: 'AI Outreach' });
    expect(event.fields).not.toHaveProperty('WhoId');
    expect(event.fields).not.toHaveProperty('WhatId');
  });

  it('8: the Task goes to the appointment owner (never the Lead owner), on the Lead, urgent, due today, with the reason', async () => {
    const f = org();
    await hold(f);
    const task = f.creates.find((c) => c.sobject === 'Task')!;
    expect(task.fields).toMatchObject({
      OwnerId: OWNER,
      WhoId: LEAD,
      Status: 'Open',
      Priority: 'High',
      ActivityDate: '2026-10-06',
      CTI_Origin__c: 'AI Outreach',
      Subject: 'AI booked a phone call for Wed Oct 7, 11:00 AM PT but could not convert this Lead — convert it and book it',
    });
    expect(task.fields).not.toHaveProperty('WhatId');
    expect(String(task.fields.Description)).toContain('FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt Lead');
    expect(String(task.fields.Description)).toContain(AI_CALL);
  });

  it('an existing hold is reused; a refused hold still makes the Task (eventId null)', async () => {
    const found = org([[HOLD_LOOKUP, [{ Id: '00U8X00000Hold1QAA' }]]]);
    expect(await hold(found)).toMatchObject({ eventId: '00U8X00000Hold1QAA' });
    expect(found.creates.map((c) => c.sobject)).toEqual(['Task']);

    const f = org();
    f.onCreate = (c) => (c.sobject === 'Event' ? refused('INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY') : undefined);
    expect(await hold(f)).toEqual({ kind: 'lead_hold', eventId: null, taskId: expect.stringMatching(/^00T/) });
  });
});

describe('createTaskOnce', () => {
  const fields = taskFields({ whatId: OPP, whoId: null, ownerId: OWNER, subject: "AI booked Wed Oct 7, 11:00 AM PT but the calendar was taken: call the seller's back", description: 'd', today: '2026-10-06' });

  it('9: finds the Task it already made: no create', async () => {
    const f = org([[TASK_LOOKUP, [{ Id: '00T8X00000Task1QAA' }]]]);
    expect(await createTaskOnce(f.client, fields)).toBe('00T8X00000Task1QAA');
    expect(f.creates).toEqual([]);
    expect(f.soql[0]).toBe(
      `SELECT Id FROM Task WHERE WhatId = '${OPP}' AND OwnerId = '${OWNER}' AND Subject = 'AI booked Wed Oct 7, 11:00 AM PT but the calendar was taken: call the seller\\'s back' AND CTI_Origin__c = 'AI Outreach' AND CreatedDate = LAST_N_DAYS:2 LIMIT 1`,
    );
  });

  it('otherwise creates it open, high priority, due today; INVALID_FIELD on the origin retries without it', async () => {
    const f = org();
    f.onCreate = (c) => ('CTI_Origin__c' in c.fields ? refused('INVALID_FIELD', 'No such column CTI_Origin__c') : ok('00T8X00000Task2QAA'));
    expect(await createTaskOnce(f.client, fields)).toBe('00T8X00000Task2QAA');
    expect(f.creates[0]!.fields).toMatchObject({ Status: 'Open', Priority: 'High', ActivityDate: '2026-10-06', WhatId: OPP, OwnerId: OWNER });
    expect(f.creates[1]!.fields).not.toHaveProperty('CTI_Origin__c');
  });

  it('a refusal throws WriteRefusedError with the code', async () => {
    const f = org();
    f.onCreate = () => refused('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    await expect(createTaskOnce(f.client, fields)).rejects.toMatchObject({ name: 'WriteRefusedError', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });

  it('a subject over 255 characters is cut', () => {
    expect(String(taskFields({ whatId: OPP, whoId: null, ownerId: OWNER, subject: 'x'.repeat(400), description: '', today: '2026-10-06' }).Subject).length).toBe(255);
  });
});

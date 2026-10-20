/** Task 23: the appointment Event at write time (re-checked, never doubled), and the fallback hold + Task. */
import { describe, expect, it } from 'vitest';
import type { BookedAppointment } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { straightLineMinutes } from '../appointments/drive.js';
import { MapsUnavailableError, type GeoPoint, type MapsClient } from '../appointments/maps.js';
import { fakeSfWrites, ok, refused, type WriteQueryRoute } from '../test/fake-sf-writes.js';
import {
  bookingPassed, bookOpportunity, createTaskOnce, holdForLead, leadHoldFields, opportunityEventFields, PRIORITY_SUBJECT, previousConsultationLine, taskFields,
} from './appointment.js';

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
const OFFICE = '18872 MacArthur Blvd #220, Irvine, CA 92612';
const quiet = { warn: () => {} };

const EXISTING_EVENT = /^SELECT Id FROM Event WHERE WhatId = /;
const HOLD_LOOKUP = /^SELECT Id FROM Event WHERE WhatId = null /;
const BUSY = /^SELECT StartDateTime, EndDateTime, IsAllDayEvent, ActivityDate, OwnerId, Location, Subject FROM Event /;
const TASK_LOOKUP = /^SELECT Id(?:, Description)? FROM Task /;

function org(routes: WriteQueryRoute[] = []) {
  return fakeSfWrites({ queries: [...routes, [EXISTING_EVENT, []], [HOLD_LOOKUP, []], [BUSY, []], [TASK_LOOKUP, []]] });
}
const book = (f: ReturnType<typeof org>, booked = PHONE, bufferMinutes = 30) =>
  bookOpportunity(f.client, { oppId: OPP, booked, location: ADDRESS, aiCallId: AI_CALL, sellerTimeZone: 'America/Chicago', bufferMinutes, maps: null, officeAddress: OFFICE, log: quiet });

describe('bookingPassed (sweep D-25 N4: passed once its START has come)', () => {
  it.each<[string, boolean]>([
    ['2026-10-07T17:59:59.000Z', false],
    ['2026-10-07T18:00:00.000Z', true],
    ['2026-10-07T18:05:00.000Z', true],
    ['2026-10-07T19:00:00.000Z', true],
  ])('at %s → %s', (now, passed) => {
    expect(bookingPassed(PHONE, new Date(now))).toBe(passed);
  });
  it('a call already under way is not put on the calendar', async () => {
    const f = org();
    expect(await bookOpportunity(f.client, { oppId: OPP, booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0, maps: null, officeAddress: OFFICE, log: quiet, now: new Date('2026-10-07T18:05:00.000Z') })).toEqual({ kind: 'expired' });
    expect(f.creates).toEqual([]);
  });
});

describe('bookOpportunity', () => {
  it('I-1: the booked time has passed: an Event an earlier attempt made is still found; otherwise expired, no calendar read, no create', async () => {
    const late = new Date('2026-10-07T19:00:00.000Z');
    const f = org([[EXISTING_EVENT, [{ Id: '00U8X00000Evnt1QAA' }]]]);
    expect(await bookOpportunity(f.client, { oppId: OPP, booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0, maps: null, officeAddress: OFFICE, log: quiet, now: late })).toEqual({ kind: 'existing', eventId: '00U8X00000Evnt1QAA' });
    const g = org();
    expect(await bookOpportunity(g.client, { oppId: OPP, booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0, maps: null, officeAddress: OFFICE, log: quiet, now: late })).toEqual({ kind: 'expired' });
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

  it('sweep D-23 M6: a whole-request 400 INVALID_FIELD naming CTI_Origin__c: one retry without it, created', async () => {
    const f = org();
    const body = [{ message: "No such column 'CTI_Origin__c' on sobject of type Event", errorCode: 'INVALID_FIELD' }];
    f.onCreate = (c) => ('CTI_Origin__c' in c.fields ? new SalesforceApiError(`Composite POST failed (400): ${JSON.stringify(body)}`, 400, body) : undefined);
    expect((await book(f)).kind).toBe('created');
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]!.fields).not.toHaveProperty('CTI_Origin__c');
  });

  it('sweep D-23 M6: any other whole-request 400 is thrown, not retried', async () => {
    const f = org();
    const body = [{ message: 'JSON_PARSER_ERROR', errorCode: 'JSON_PARSER_ERROR' }];
    f.onCreate = () => new SalesforceApiError(`Composite POST failed (400): ${JSON.stringify(body)}`, 400, body);
    await expect(book(f)).rejects.toBeInstanceOf(SalesforceApiError);
    expect(f.creates).toHaveLength(1);
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
    await expect(bookOpportunity(f.client, { oppId: "006'; x", booked: PHONE, location: null, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 0, maps: null, officeAddress: OFFICE, log: quiet })).rejects.toThrow(RangeError);
    expect(f.log).toEqual([]);
  });
});

const GRANT = OWNER;
const BLAKE = '0058X00000FA8tLQAT';
const WHAT_CHANGED = "seller says it didn't work out last time, now they really want to sell";
const PREVIOUS = { start: '2026-03-12T17:00:00.000Z', kind: 'in_person', ownerName: 'Blake Kossuth' } as const;
/** Sam's high-priority booking: Grant, in person, at the time the seller asked for. */
const PRIORITY: BookedAppointment = { ...WALK, slotId: 'h1', priority: true, note: '', whatChanged: WHAT_CHANGED, previousConsultation: PREVIOUS };
const eventFields = (booked: BookedAppointment) => opportunityEventFields({ oppId: OPP, booked, location: ADDRESS, aiCallId: AI_CALL, sellerTimeZone: null });

describe('opportunityEventFields: high priority and the earlier consultation', () => {
  it('a priority booking is a High Priority Property Consultation, Grant\'s, at the address', () => {
    expect(PRIORITY_SUBJECT).toBe('High Priority Property Consultation');
    expect(eventFields(PRIORITY)).toMatchObject({ Subject: 'High Priority Property Consultation', OwnerId: GRANT, Location: ADDRESS, WhatId: OPP });
  });

  it('the Description opens with the earlier consultation and what changed, then today\'s sentences unchanged', () => {
    expect(eventFields(PRIORITY).Description).toBe(
      `Previous consultation: Mar 12 with Blake Kossuth. What changed: seller says it didn't work out last time, now they really want to sell. Booked by the AI assistant on a call (AI call ${AI_CALL}). Address confirmed with the seller.`,
    );
  });

  it('the year is shown when it differs from the booking\'s, and the date is read in PT', () => {
    expect(previousConsultationLine({ ...PRIORITY, previousConsultation: { ...PREVIOUS, start: '2025-03-12T17:00:00.000Z' } })).toBe(
      `Previous consultation: Mar 12, 2025 with Blake Kossuth. What changed: ${WHAT_CHANGED}.`,
    );
    // 02:00 UTC on Mar 13 is still Mar 12 in Pacific time.
    expect(previousConsultationLine({ ...PRIORITY, previousConsultation: { ...PREVIOUS, start: '2026-03-13T02:00:00.000Z' } })).toMatch(/^Previous consultation: Mar 12 with /);
    // Dec 31 PT of the year before a January booking.
    const january = { ...PRIORITY, start: '2027-01-05T17:00:00.000Z', end: '2027-01-05T18:00:00.000Z' };
    expect(previousConsultationLine({ ...january, previousConsultation: { ...PREVIOUS, start: '2027-01-01T03:00:00.000Z' } })).toMatch(/^Previous consultation: Dec 31, 2026 with /);
  });

  it('an empty or missing whatChanged: "the seller didn\'t say"; a null owner name leaves out "with"', () => {
    expect(previousConsultationLine({ ...PRIORITY, whatChanged: '' })).toBe("Previous consultation: Mar 12 with Blake Kossuth. What changed: the seller didn't say.");
    expect(previousConsultationLine({ ...PRIORITY, whatChanged: '   ' })).toBe("Previous consultation: Mar 12 with Blake Kossuth. What changed: the seller didn't say.");
    const { whatChanged: _w, ...noWhat } = PRIORITY;
    expect(previousConsultationLine(noWhat)).toBe("Previous consultation: Mar 12 with Blake Kossuth. What changed: the seller didn't say.");
    expect(previousConsultationLine({ ...PRIORITY, previousConsultation: { ...PREVIOUS, ownerName: null } })).toBe(`Previous consultation: Mar 12. What changed: ${WHAT_CHANGED}.`);
    expect(previousConsultationLine({ ...PRIORITY, whatChanged: 'They lowered their price.' })).toBe('Previous consultation: Mar 12 with Blake Kossuth. What changed: They lowered their price.');
  });

  it('no earlier consultation: no line, even with whatChanged; Subject as today', () => {
    const { previousConsultation: _p, ...noPrevious } = PRIORITY;
    expect(previousConsultationLine(noPrevious)).toBeNull();
    expect(eventFields(noPrevious).Description).toBe(`Booked by the AI assistant on a call (AI call ${AI_CALL}). Address confirmed with the seller.`);
    expect(eventFields(WALK).Subject).toBe('Property Consultation');
    expect(eventFields(PHONE).Subject).toBe('Phone Consultation');
  });
});

/** A made-up house a rep was at before the booking. */
const EARLIER_PLACE = '200 Fake Elm St, Tustin, CA 92780';
/** A routed walkthrough with Blake, Wed Oct 21 09:00–10:00 PT. */
const ROUTED: BookedAppointment = { ...WALK, start: '2026-10-21T16:00:00.000Z', end: '2026-10-21T17:00:00.000Z', specialistSfUserId: BLAKE, region: 'LA' };
/** An earlier Event 08:00–08:45 PT at an address: inside the old 30-minute walkthrough buffer, clear of the slot itself. */
const EARLIER = { StartDateTime: '2026-10-21T15:00:00.000+0000', EndDateTime: '2026-10-21T15:45:00.000+0000', IsAllDayEvent: false, Location: EARLIER_PLACE, Subject: 'Property Consultation' };

/**
 * Google answering every route with `minutes`; or failing (routes and geocodes) with `fail`; or with only Routes failing
 * (`routesFail`) while Geocoding places addresses at `points`.
 */
function fakeMaps(o: { minutes?: number; fail?: Error; routesFail?: Error; points?: Readonly<Record<string, GeoPoint>> } = {}) {
  const calls: string[] = [];
  const maps: MapsClient = {
    async geocode(address) {
      calls.push('geocode');
      if (o.fail) throw o.fail;
      const point = o.points?.[address];
      return point ? { point, county: 'Orange', state: 'CA' } : null;
    },
    async routeMinutes(origins, destinations) {
      calls.push('route');
      if (o.fail ?? o.routesFail) throw o.fail ?? o.routesFail;
      return { minutes: origins.map(() => destinations.map(() => o.minutes ?? 15)), requestedElements: origins.length * destinations.length };
    },
  };
  return { maps, calls };
}
const recorder = () => {
  const warns: Array<[Record<string, unknown>, string]> = [];
  return { warns, log: { warn: (o: Record<string, unknown>, m: string) => void warns.push([o, m]) } };
};
const bookRouted = (f: ReturnType<typeof org>, booked: BookedAppointment, maps: MapsClient | null, log: { warn(o: Record<string, unknown>, m: string): void } = quiet) =>
  bookOpportunity(f.client, { oppId: OPP, booked, location: ADDRESS, aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 30, maps, officeAddress: OFFICE, log });
const busyReads = (f: ReturnType<typeof org>) => f.soql.filter((q) => BUSY.test(q));

describe('bookOpportunity: high priority', () => {
  it('books over a busy calendar: no busy read at all, owned by Grant', async () => {
    const f = org([[BUSY, [{ StartDateTime: '2026-10-08T16:30:00.000+0000', EndDateTime: '2026-10-08T18:30:00.000+0000', IsAllDayEvent: false }]]]);
    const g = fakeMaps({ minutes: 500 });
    expect(await bookRouted(f, { ...PRIORITY, region: 'LA' }, g.maps)).toEqual({ kind: 'created', eventId: expect.stringMatching(/^00U/) });
    expect(busyReads(f)).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(f.creates[0]!.fields).toMatchObject({ Subject: PRIORITY_SUBJECT, OwnerId: GRANT });
  });
});

describe('bookOpportunity: a routed booking (overlap with no buffer, then the drive)', () => {
  it('reads that PT day (00:00–24:00) once, for the booked rep', async () => {
    const f = org([[BUSY, [EARLIER]]]);
    await bookRouted(f, ROUTED, fakeMaps({ minutes: 25 }).maps);
    expect(busyReads(f)).toHaveLength(1);
    expect(busyReads(f)[0]).toContain(`OwnerId = '${BLAKE}'`);
    expect(busyReads(f)[0]).toContain('StartDateTime < 2026-10-22T07:00:00Z AND EndDateTime > 2026-10-21T07:00:00Z');
  });

  it('a 40-minute drive from the earlier Event no longer fits: conflict for the drive, nothing created', async () => {
    const f = org([[BUSY, [EARLIER]]]);
    expect(await bookRouted(f, ROUTED, fakeMaps({ minutes: 40 }).maps)).toEqual({ kind: 'conflict', reason: 'drive' });
    expect(f.creates).toEqual([]);
  });

  it('a 25-minute drive fits (15 minutes of slack): created', async () => {
    const f = org([[BUSY, [EARLIER]]]);
    expect(await bookRouted(f, ROUTED, fakeMaps({ minutes: 25 }).maps)).toEqual({ kind: 'created', eventId: expect.stringMatching(/^00U/) });
    expect(f.creates[0]!.fields).toMatchObject({ Subject: 'Property Consultation', OwnerId: BLAKE, Location: ADDRESS });
  });

  it('maps null: the overlap check only (no 30-minute buffer): created', async () => {
    const f = org([[BUSY, [EARLIER]]]);
    expect(await bookRouted(f, ROUTED, null)).toEqual({ kind: 'created', eventId: expect.stringMatching(/^00U/) });
  });

  it('no Location (a phone call, or no address): no drive check', async () => {
    const g = fakeMaps({ minutes: 500 });
    const phone = { ...ROUTED, kind: 'phone' as const, slotId: 'p1' };
    expect((await bookRouted(org([[BUSY, [EARLIER]]]), phone, g.maps)).kind).toBe('created');
    const f = org([[BUSY, [EARLIER]]]);
    expect((await bookOpportunity(f.client, { oppId: OPP, booked: ROUTED, location: '  ', aiCallId: AI_CALL, sellerTimeZone: null, bufferMinutes: 30, maps: g.maps, officeAddress: OFFICE, log: quiet })).kind).toBe('created');
    expect(g.calls).toEqual([]);
  });

  it('an overlap: conflict with no reason, and no drive asked', async () => {
    const g = fakeMaps({ minutes: 5 });
    const f = org([[BUSY, [{ ...EARLIER, EndDateTime: '2026-10-21T16:15:00.000+0000' }]]]);
    expect(await bookRouted(f, ROUTED, g.maps)).toEqual({ kind: 'conflict' });
    expect(g.calls).toEqual([]);
    expect(f.creates).toEqual([]);
  });

  it.each<[string, Error]>([
    ['Google down (MapsUnavailableError)', new MapsUnavailableError('timeout')],
    ['any other error', new TypeError('boom')],
  ])('the drive check fails (%s) and nothing overlaps: created, a warn with codes and ids only', async (_name, fail) => {
    const f = org([[BUSY, [EARLIER]]]);
    const r = recorder();
    expect(await bookRouted(f, ROUTED, fakeMaps({ fail }).maps, r.log)).toEqual({ kind: 'created', eventId: expect.stringMatching(/^00U/) });
    const said = JSON.stringify(r.warns);
    expect(said).toContain(AI_CALL);
    expect(said).not.toContain('Oak St');
    expect(said).not.toContain('Fake Elm');
    expect(said).not.toContain('MacArthur');
    expect(r.warns.some(([o]) => o.oppId === OPP && (o.code === 'timeout' || o.errName === 'TypeError'))).toBe(true);
  });

  describe('ruling: Routes down, Geocoding up: the straight-line estimate the offer used decides', () => {
    // Made-up points: the earlier visit, a house about 3 miles away, and one about 40 miles away.
    const EARLIER_AT: GeoPoint = { lat: 33.7458, lng: -117.8262 };
    const NEAR: GeoPoint = { lat: 33.7, lng: -117.8 };
    const FAR: GeoPoint = { lat: 34.2, lng: -118.2 };
    const down = (property: GeoPoint) => fakeMaps({ routesFail: new MapsUnavailableError('http_503'), points: { [EARLIER_PLACE]: EARLIER_AT, [ADDRESS]: property } });

    it('the estimate is over the slack (08:45 + more than 30 minutes): conflict for the drive', async () => {
      expect(straightLineMinutes(EARLIER_AT, FAR)).toBeGreaterThan(30);
      const g = down(FAR);
      const f = org([[BUSY, [EARLIER]]]);
      expect(await bookRouted(f, ROUTED, g.maps)).toEqual({ kind: 'conflict', reason: 'drive' });
      expect(g.calls).toEqual(['route', 'geocode', 'geocode']);
      expect(f.creates).toEqual([]);
    });

    it('the estimate fits: created', async () => {
      expect(straightLineMinutes(EARLIER_AT, NEAR)).toBeLessThanOrEqual(30);
      const f = org([[BUSY, [EARLIER]]]);
      expect(await bookRouted(f, ROUTED, down(NEAR).maps)).toEqual({ kind: 'created', eventId: expect.stringMatching(/^00U/) });
    });
  });

  it('a booking with no region keeps today\'s check, its walkthrough buffer included', async () => {
    const { region: _r, ...legacy } = ROUTED;
    const f = org([[BUSY, [EARLIER]]]);
    expect(await bookRouted(f, legacy, fakeMaps({ minutes: 5 }).maps)).toEqual({ kind: 'conflict' });
    expect(busyReads(f)[0]).toContain('StartDateTime < 2026-10-21T17:30:00Z AND EndDateTime > 2026-10-21T15:30:00Z');
  });
});

describe('holdForLead (fallback only)', () => {
  const hold = (f: ReturnType<typeof org>) =>
    holdForLead(f.client, { leadId: LEAD, leadName: 'Jane Seller', booked: PHONE, aiCallId: AI_CALL, ownerName: 'Grant Golden', reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Hunt Lead', today: '2026-10-06', since: CALL_ENDED });

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
      Subject: 'AI booked a phone consultation for Wed Oct 7, 11:00 AM PT but could not convert this Lead — convert it and book it',
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
    expect(await hold(f)).toEqual({ kind: 'lead_hold', eventId: null, taskId: expect.stringMatching(/^00T/), holdCode: 'INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY' });
  });

  it('final review I-1: a refused Task keeps its code on the result (taskId null)', async () => {
    const f = org();
    f.onCreate = (c) => (c.sobject === 'Task' ? refused('FIELD_CUSTOM_VALIDATION_EXCEPTION') : undefined);
    expect(await hold(f)).toEqual({ kind: 'lead_hold', eventId: expect.stringMatching(/^00U/), taskId: null, taskCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });
});

const CALL_ENDED = new Date('2026-09-30T17:45:12.345Z');

describe('createTaskOnce', () => {
  const fields = taskFields({ whatId: OPP, whoId: null, ownerId: OWNER, subject: "AI booked Wed Oct 7, 11:00 AM PT but the calendar was taken: call the seller's back", description: 'd', today: '2026-10-06' });

  it('9: finds the Task it already made: no create', async () => {
    const f = org([[TASK_LOOKUP, [{ Id: '00T8X00000Task1QAA' }]]]);
    expect(await createTaskOnce(f.client, fields, CALL_ENDED)).toBe('00T8X00000Task1QAA');
    expect(f.creates).toEqual([]);
    expect(f.soql[0]).toBe(
      `SELECT Id FROM Task WHERE WhatId = '${OPP}' AND OwnerId = '${OWNER}' AND Subject = 'AI booked Wed Oct 7, 11:00 AM PT but the calendar was taken: call the seller\\'s back' AND CTI_Origin__c = 'AI Outreach' AND CreatedDate >= 2026-09-30T17:44:12Z LIMIT 1`,
    );
  });

  it('final review: the lookup covers the row\'s whole life (since the call ended, a minute of skew), never only two days', async () => {
    const f = org([[TASK_LOOKUP, []]]);
    await createTaskOnce(f.client, fields, CALL_ENDED);
    expect(f.soql[0]).toContain('AND CreatedDate >= 2026-09-30T17:44:12Z LIMIT 1');
    expect(f.soql[0]).not.toContain('LAST_N_DAYS');
    const unknown = org([[TASK_LOOKUP, []]]);
    await createTaskOnce(unknown.client, fields, null);
    expect(unknown.soql[0]).not.toContain('CreatedDate');
  });

  it('otherwise creates it open, high priority, due today; INVALID_FIELD on the origin retries without it', async () => {
    const f = org();
    f.onCreate = (c) => ('CTI_Origin__c' in c.fields ? refused('INVALID_FIELD', 'No such column CTI_Origin__c') : ok('00T8X00000Task2QAA'));
    expect(await createTaskOnce(f.client, fields, CALL_ENDED)).toBe('00T8X00000Task2QAA');
    expect(f.creates[0]!.fields).toMatchObject({ Status: 'Open', Priority: 'High', ActivityDate: '2026-10-06', WhatId: OPP, OwnerId: OWNER });
    expect(f.creates[1]!.fields).not.toHaveProperty('CTI_Origin__c');
  });

  it('a refusal throws WriteRefusedError with the code', async () => {
    const f = org();
    f.onCreate = () => refused('FIELD_CUSTOM_VALIDATION_EXCEPTION');
    await expect(createTaskOnce(f.client, fields, CALL_ENDED)).rejects.toMatchObject({ name: 'WriteRefusedError', code: 'FIELD_CUSTOM_VALIDATION_EXCEPTION' });
  });

  it('a subject over 255 characters is cut', () => {
    expect(String(taskFields({ whatId: OPP, whoId: null, ownerId: OWNER, subject: 'x'.repeat(400), description: '', today: '2026-10-06' }).Subject).length).toBe(255);
  });

  describe('with an adoption test (look-alike Tasks are separate things: only the caller\'s own is adopted)', () => {
    const rows = [
      { Id: '00T8X00000Task1QAA', Description: 'first\r\n#event-a' },
      { Id: '00T8X00000Task2QAA', Description: 'second\r\n#event-b' },
      { Id: '00T8X00000Task3QAA', Description: null },
    ];
    const ours = (marker: string) => ({ excludeIds: [], isOurs: (c: { description: string | null }) => c.description?.includes(marker) === true });

    it('reads up to 10 candidates with their Description, oldest first, and adopts the first that is the caller\'s own', async () => {
      const f = org([[TASK_LOOKUP, rows]]);
      const asked: Array<{ id: string; description: string | null }> = [];
      const adoption = {
        excludeIds: [],
        isOurs: async (c: { id: string; description: string | null }) => {
          asked.push(c);
          return c.description?.includes('#event-b') === true;
        },
      };
      expect(await createTaskOnce(f.client, fields, CALL_ENDED, adoption)).toBe('00T8X00000Task2QAA');
      expect(f.creates).toEqual([]);
      expect(asked.map((c) => c.id)).toEqual(['00T8X00000Task1QAA', '00T8X00000Task2QAA']);
      expect(asked[1]).toEqual({ id: '00T8X00000Task2QAA', description: 'second\r\n#event-b' });
      expect(f.soql[0]).toMatch(/^SELECT Id, Description FROM Task WHERE /);
      expect(f.soql[0]).toMatch(/AND CreatedDate >= 2026-09-30T17:44:12Z ORDER BY CreatedDate LIMIT 10$/);
    });

    it('a candidate with no Description is read as null, and is no one\'s own', async () => {
      const f = org([[TASK_LOOKUP, [rows[2]!]]]);
      f.onCreate = () => ok('00T8X00000Task9QAA');
      const seen: Array<string | null> = [];
      const adoption = { excludeIds: [], isOurs: (c: { description: string | null }) => (seen.push(c.description), false) };
      expect(await createTaskOnce(f.client, fields, CALL_ENDED, adoption)).toBe('00T8X00000Task9QAA');
      expect(seen).toEqual([null]);
    });

    it('creates a new Task when none of the candidates is the caller\'s own', async () => {
      const f = org([[TASK_LOOKUP, rows]]);
      f.onCreate = () => ok('00T8X00000Task9QAA');
      expect(await createTaskOnce(f.client, fields, CALL_ENDED, ours('#event-zzz'))).toBe('00T8X00000Task9QAA');
      expect(f.creates).toHaveLength(1);
    });

    it('leaves the ids it is given out of the lookup, keeping only what is shaped like a Salesforce id', async () => {
      const f = org([[TASK_LOOKUP, []]]);
      f.onCreate = () => ok('00T8X00000Task9QAA');
      await createTaskOnce(f.client, fields, CALL_ENDED, { ...ours('x'), excludeIds: ['00T8X00000Task1QAA', "x' OR Id != '", '00T8X00000Task2QAA', '', '00T8X00000Task1QAA'] });
      expect(f.soql[0]).toContain(" AND Id NOT IN ('00T8X00000Task1QAA','00T8X00000Task2QAA') ORDER BY CreatedDate LIMIT 10");
      expect(f.soql[0]).not.toContain("x'");
    });

    it('no NOT IN clause when there is nothing to leave out', async () => {
      const f = org([[TASK_LOOKUP, []]]);
      f.onCreate = () => ok('00T8X00000Task9QAA');
      await createTaskOnce(f.client, fields, CALL_ENDED, { ...ours('x'), excludeIds: ["x' OR Id != '"] });
      expect(f.soql[0]).not.toContain('NOT IN');
    });

    it('reads the candidates again without the origin when the org lacks CTI_Origin__c', async () => {
      const f = org([[TASK_LOOKUP, (q) => (q.includes('CTI_Origin__c') ? new Error('INVALID_FIELD: No such column CTI_Origin__c') : rows)]]);
      expect(await createTaskOnce(f.client, fields, CALL_ENDED, ours('#event-b'))).toBe('00T8X00000Task2QAA');
      expect(f.soql[1]).not.toContain('CTI_Origin__c');
      expect(f.soql[1]).toMatch(/^SELECT Id, Description FROM Task /);
    });

    it('without an adoption test the lookup is exactly what it was: Id only, one row, no ordering', async () => {
      const f = org([[TASK_LOOKUP, rows]]);
      expect(await createTaskOnce(f.client, fields, CALL_ENDED)).toBe('00T8X00000Task1QAA');
      expect(f.soql[0]).toMatch(/^SELECT Id FROM Task WHERE /);
      expect(f.soql[0]).toMatch(/ LIMIT 1$/);
      expect(f.soql[0]).not.toContain('ORDER BY');
      expect(f.soql[0]).not.toContain('Description');
    });
  });
});

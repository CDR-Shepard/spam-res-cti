import { describe, expect, it, vi } from 'vitest';
import { AppointmentSlots, type AiCallBookingSettings, type AppointmentSlot, type Consultations } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { DEFAULT_AI_CALL_BOOKING, DEFAULT_BOOKING_ROUTING } from '../settings.js';
import {
  aiBooking, ANAHEIM, BLAKE, CHANCE, eventRow, fakeBookedDb, fakeMaps, GRANT, IMPERIAL_PROPERTY, OC_PROPERTY, offerSalesforce, PLACES,
  SD_CITY_ONLY, SD_PROPERTY, SETH, THOMAS, USERS, usersWithInactive,
} from '../test/fake-offer.js';
import { fakeSalesforce } from '../test/fake-sf-client.js';
import { BUSY_ROW_LIMIT } from './calendar.js';
import { MapsUnavailableError, type MapsClient } from './maps.js';
import { OFFER_CALENDAR_DAYS, priorityDefaultStart, readOfferCalendars, routedOffer } from './offer.js';

type Row = Record<string, unknown>;

const ORG = '00000000-0000-4000-8000-0000000000a1';
/** Mon 2026-10-19 09:00 PDT. */
const NOW = new Date('2026-10-19T16:00:00Z');
const TUE_9 = '2026-10-20T16:00:00.000Z';
const core = (id: string): string => id.slice(0, 15);
const booking = (over: Partial<AiCallBookingSettings> = {}): AiCallBookingSettings => ({
  ...structuredClone(DEFAULT_AI_CALL_BOOKING), enabled: true, specialists: [GRANT], routing: structuredClone(DEFAULT_BOOKING_ROUTING), ...over,
});
const upcoming: Consultations = { last: null, next: { start: '2026-10-22T17:00:00.000Z', kind: 'in_person', ownerName: 'Seth Person' } };

interface OfferCase {
  users?: Row[];
  events?: Row[];
  booked?: unknown[];
  maps?: MapsClient | null;
  consultations?: Consultations | null;
  booking?: AiCallBookingSettings;
}

/** Reads the calendars from fake Salesforce, then routes `address` through a fake Google and a fake AI-bookings read. */
async function offerFor(address: string | null, o: OfferCase = {}) {
  const sf = offerSalesforce({ users: o.users, events: o.events });
  const b = o.booking ?? booking();
  const cal = await readOfferCalendars(sf.client, { booking: b, now: NOW });
  const log = { info: vi.fn(), warn: vi.fn() };
  const google = fakeMaps();
  const maps = o.maps === undefined ? google.maps : o.maps;
  const booked = fakeBookedDb(o.booked ?? []);
  const offer = await routedOffer({ db: booked.db, maps, log }, cal, { orgId: ORG, booking: b, now: NOW, address, consultations: o.consultations ?? null });
  return { offer, log, sf, cal, geocoded: google.geocoded, bookedReads: booked.reads };
}

const inPerson = (slots: readonly AppointmentSlot[]) => slots.filter((s) => s.kind === 'walkthrough');
const phone = (slots: readonly AppointmentSlot[]) => slots.filter((s) => s.kind === 'phone');
const repAt = (slots: readonly AppointmentSlot[], start: string) => inPerson(slots).find((s) => s.start === start)?.specialistSfUserId;
/** Every log argument, to check no seller data reaches a log line. */
const logged = (log: { info: { mock: { calls: unknown[] } }; warn: { mock: { calls: unknown[] } } }) => JSON.stringify([log.info.mock.calls, log.warn.mock.calls]);
const none = (note: string, region: string | null = null) => ({ slots: [], priority: null, region, ownerSfUserId: null, note });

describe('routedOffer', () => {
  it('San Diego property → SD reps: in-person times first, then phone, every one routed through SD', async () => {
    // Seth is in a meeting Tuesday 9–10, so Thomas takes Tuesday 9:00.
    const events = [eventRow(SETH, '2026-10-20T16:00:00.000Z', '2026-10-20T17:00:00.000Z')];
    const { offer } = await offerFor(SD_PROPERTY, { events });
    expect(offer.note).toBeNull();
    expect(offer.region).toBe('SD');
    expect(offer.slots.map((s) => s.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'p1', 'p2', 'p3', 'p4']);
    expect(offer.slots.every((s) => s.region === 'SD' && [SETH, THOMAS].includes(s.specialistSfUserId))).toBe(true);
    expect(repAt(offer.slots, TUE_9)).toBe(THOMAS);
    expect(AppointmentSlots.safeParse(offer.slots).success).toBe(true);
    expect(offer.ownerSfUserId).toBe(offer.slots[0]!.specialistSfUserId);
  });

  it('Orange County → LA reps', async () => {
    const { offer } = await offerFor(OC_PROPERTY);
    expect(offer.region).toBe('LA');
    expect(inPerson(offer.slots).length).toBeGreaterThan(0);
    expect(phone(offer.slots).length).toBeGreaterThan(0);
    expect(offer.slots.every((s) => s.region === 'LA' && [CHANCE, BLAKE].includes(s.specialistSfUserId))).toBe(true);
    // LA starts at 9, 11, 13…: Tuesday's in-person morning is 9:00 and afternoon 13:00.
    expect(inPerson(offer.slots).slice(0, 2).map((s) => s.start)).toEqual([TUE_9, '2026-10-20T20:00:00.000Z']);
  });

  it('Imperial County → outside_regions, no slots, no priority', async () => {
    const { offer } = await offerFor(IMPERIAL_PROPERTY);
    expect(offer).toEqual(none('outside_regions'));
  });

  it('an upcoming consultation → already_booked, no slots, no priority (and Google is not asked)', async () => {
    const { offer, geocoded, bookedReads } = await offerFor(SD_PROPERTY, { consultations: upcoming });
    expect(offer).toEqual(none('already_booked'));
    expect(geocoded).toEqual([]);
    expect(bookedReads()).toBe(0);
  });

  it('a past consultation alone changes nothing', async () => {
    const { offer } = await offerFor(SD_PROPERTY, { consultations: { last: upcoming.next, next: null } });
    expect(offer.note).toBeNull();
    expect(offer.slots.length).toBeGreaterThan(0);
  });

  it('city only, no street → phone slots, no in-person, no priority', async () => {
    const { offer } = await offerFor(SD_CITY_ONLY);
    expect(offer.region).toBe('SD');
    expect(offer.slots.length).toBeGreaterThan(0);
    expect(offer.slots.every((s) => s.kind === 'phone')).toBe(true);
    expect(offer.priority).toBeNull();
    expect(offer.note).toBeNull();
  });

  it('no address → no_address', async () => {
    expect((await offerFor(null)).offer).toEqual(none('no_address'));
    expect((await offerFor('   ')).offer).toEqual(none('no_address'));
  });

  it('maps null → maps_unavailable', async () => {
    expect((await offerFor(SD_PROPERTY, { maps: null })).offer).toEqual(none('maps_unavailable'));
  });

  it('geocode throws → maps_unavailable, logged by its code only', async () => {
    const { maps } = fakeMaps({ [SD_PROPERTY]: new MapsUnavailableError('REQUEST_DENIED') });
    const { offer, log } = await offerFor(SD_PROPERTY, { maps });
    expect(offer).toEqual(none('maps_unavailable'));
    expect(log.warn).toHaveBeenCalledWith({ orgId: ORG, code: 'REQUEST_DENIED' }, expect.any(String));
    expect(logged(log)).not.toContain('Palm');
  });

  it('Google finds nothing → not_found', async () => {
    const { maps } = fakeMaps({});
    expect((await offerFor(SD_PROPERTY, { maps })).offer).toEqual(none('not_found'));
  });

  it('Routes down → in-person times from straight lines', async () => {
    // Every in-person time asks a route matrix (from the office, and from Chance's 7:00 consultation in Anaheim), and it fails.
    const events = [eventRow(CHANCE, '2026-10-20T14:00:00.000Z', '2026-10-20T15:00:00.000Z', { Location: ANAHEIM, Subject: 'Property Consultation' })];
    const { maps } = fakeMaps(PLACES, { routes: new MapsUnavailableError('timeout') });
    const { offer, log } = await offerFor(OC_PROPERTY, { events, maps });
    expect(offer.note).toBeNull();
    expect(inPerson(offer.slots).length).toBeGreaterThan(0);
    expect(inPerson(offer.slots)[0]!.start).toBe(TUE_9);
    expect(log.warn).toHaveBeenCalledWith({ code: 'timeout' }, 'Google Routes unavailable: using straight-line drive times');
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ routeElements: 0 }), expect.any(String));
    expect(logged(log)).not.toContain('Main St');
  });

  it('a drive lookup that Routes answers is counted on the info line', async () => {
    // Every in-person time asks Routes for its drives in (from the office, and from Chance's 7:00 in Anaheim), and Routes answers.
    const events = [eventRow(CHANCE, '2026-10-20T14:00:00.000Z', '2026-10-20T15:00:00.000Z', { Location: ANAHEIM, Subject: 'Property Consultation' })];
    const { offer, log } = await offerFor(OC_PROPERTY, { events });
    expect(inPerson(offer.slots)[0]!.start).toBe(TUE_9);
    const [line] = log.info.mock.calls[0] as [{ routeElements: number }, string];
    expect(line.routeElements).toBeGreaterThan(0);
  });

  it('drive times unavailable (Routes down and the office cannot be placed) → phone times only', async () => {
    const events = [eventRow(CHANCE, '2026-10-20T14:00:00.000Z', '2026-10-20T15:00:00.000Z', { Location: ANAHEIM })];
    const { maps } = fakeMaps({ [OC_PROPERTY]: PLACES[OC_PROPERTY]! }, { routes: new MapsUnavailableError('timeout') });
    const { offer, log } = await offerFor(OC_PROPERTY, { events, maps });
    expect(offer.note).toBeNull();
    expect(offer.slots.length).toBeGreaterThan(0);
    expect(offer.slots.every((s) => s.kind === 'phone')).toBe(true);
    expect(log.warn).toHaveBeenCalledWith({ orgId: ORG, code: 'ZERO_RESULTS' }, expect.any(String));
  });

  it('priority with Grant, in Pacific time whatever his Salesforce zone', async () => {
    const users = USERS.map((u) => (u.Id === GRANT ? { ...u, TimeZoneSidKey: 'America/New_York' } : u));
    const { offer } = await offerFor(OC_PROPERTY, { users, booking: booking({ specialists: [GRANT] }) });
    expect(offer.priority).toEqual({ specialistSfUserId: GRANT, specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles', defaultStart: '2026-10-20T16:00:00.000Z' });
    // The first slot's rep owns the offer, not Grant.
    expect([CHANCE, BLAKE]).toContain(offer.ownerSfUserId);
  });

  it('no priority when Grant is inactive or not on the list', async () => {
    expect((await offerFor(OC_PROPERTY, { users: usersWithInactive(GRANT) })).offer.priority).toBeNull();
    expect((await offerFor(OC_PROPERTY, { booking: booking({ specialists: [] }) })).offer.priority).toBeNull();
  });

  it('the reps fully booked: Grant\'s priority alone is offered and owns it; without Grant, no_free_time', async () => {
    const allTaken = (owner: string) => eventRow(owner, '2026-10-19T00:00:00.000Z', '2026-11-10T00:00:00.000Z');
    const events = [allTaken(CHANCE), allTaken(BLAKE)];
    const withGrant = (await offerFor(OC_PROPERTY, { events })).offer;
    expect(withGrant).toMatchObject({ slots: [], region: 'LA', ownerSfUserId: GRANT, note: null });
    expect(withGrant.priority?.specialistSfUserId).toBe(GRANT);
    expect((await offerFor(OC_PROPERTY, { events, users: usersWithInactive(GRANT) })).offer).toEqual(none('no_free_time', 'LA'));
  });

  it('an AI booking not on the calendar blocks that rep', async () => {
    // Chance had a consultation Monday morning (before now, still this week), so Blake has the lighter week and takes Tuesday 9:00.
    const events = [eventRow(CHANCE, '2026-10-19T14:00:00.000Z', '2026-10-19T15:00:00.000Z', { Subject: 'Property Consultation' })];
    expect(repAt((await offerFor(OC_PROPERTY, { events })).offer.slots, TUE_9)).toBe(BLAKE);
    // Blake has an AI booking Tuesday 9:00–10:00 that no Event shows yet, so Tuesday 9:00 goes to Chance.
    const booked = [aiBooking(BLAKE, TUE_9, '2026-10-20T17:00:00.000Z')];
    expect(repAt((await offerFor(OC_PROPERTY, { events, booked })).offer.slots, TUE_9)).toBe(CHANCE);
  });

  it('a calendar that could not be read carries its note through', async () => {
    const { offer, geocoded } = await offerFor(SD_PROPERTY, { booking: booking({ enabled: false }) });
    expect(offer).toEqual(none('booking_off'));
    expect(geocoded).toEqual([]);
  });

  it('logs one info line: ids and counts only, never the address', async () => {
    const { offer, log } = await offerFor(SD_PROPERTY);
    expect(log.info).toHaveBeenCalledTimes(1);
    // Six in-person times, each the first in its half-day: one office drive each (the reps start there at 8:00).
    expect(log.info).toHaveBeenCalledWith({ orgId: ORG, region: 'SD', slots: offer.slots.length, priority: true, routeElements: 6 }, 'appointments: routed offer');
    expect(logged(log)).not.toContain('Palm');
  });

  it('never throws: the AI-bookings read failing offers nothing', async () => {
    const sf = offerSalesforce();
    const cal = await readOfferCalendars(sf.client, { booking: booking(), now: NOW });
    const db = { select: () => { throw new Error('connection terminated'); } } as never;
    const log = { info: vi.fn(), warn: vi.fn() };
    const offer = await routedOffer({ db, maps: fakeMaps().maps, log }, cal, { orgId: ORG, booking: booking(), now: NOW, address: SD_PROPERTY, consultations: null });
    expect(offer).toEqual(none('salesforce_error'));
    expect(log.warn).toHaveBeenCalledWith({ orgId: ORG, errName: 'Error' }, expect.any(String));
  });
});

describe('readOfferCalendars', () => {
  it('reads every region rep and the specialists in one User query, and every active rep\'s calendar in one Event query', async () => {
    const sf = offerSalesforce();
    const cal = await readOfferCalendars(sf.client, { booking: booking(), now: NOW });
    expect(sf.soql).toHaveLength(2);
    expect(sf.soql[0]).toMatch(/FROM User WHERE Id IN \(/);
    for (const id of [CHANCE, BLAKE, SETH, THOMAS, GRANT]) expect(sf.soql[0]).toContain(id);
    expect(sf.soql[1]).toMatch(/OwnerId IN \(/);
    if (cal.kind !== 'read') throw new Error('expected a calendar read');
    expect([...cal.reps.keys()]).toEqual([CHANCE, BLAKE, SETH, THOMAS].map(core));
    expect(cal.priority?.sfUserId).toBe(GRANT);
    expect(cal.routing).toEqual(DEFAULT_BOOKING_ROUTING);
  });

  it('reads from 00:00 Monday of this week (Pacific) to now + 15 days', async () => {
    const sf = offerSalesforce();
    const cal = await readOfferCalendars(sf.client, { booking: booking(), now: new Date('2026-10-22T19:00:00Z') });
    if (cal.kind !== 'read') throw new Error('expected a calendar read');
    expect(cal.from.toISOString()).toBe('2026-10-19T07:00:00.000Z');
    expect(cal.until.toISOString()).toBe(new Date(Date.parse('2026-10-22T19:00:00Z') + OFFER_CALENDAR_DAYS * 86_400_000).toISOString());
    expect(sf.soql[1]).toContain('EndDateTime > 2026-10-19T07:00:00Z');
    expect(sf.soql[1]).toContain('StartDateTime < 2026-11-06T19:00:00Z');
  });

  it('never throws: a rejecting client.query gives salesforce_error', async () => {
    const failing = fakeSalesforce({ queries: [[/./, new SalesforceApiError('boom', 500, null)]] });
    const warn = vi.fn();
    expect(await readOfferCalendars(failing.client, { booking: booking(), now: NOW, log: { warn } })).toEqual({ kind: 'none', note: 'salesforce_error' });
    expect(warn).toHaveBeenCalledWith({ errName: 'SalesforceApiError' }, expect.any(String));
  });

  it('booking off reads nothing', async () => {
    const sf = offerSalesforce();
    expect(await readOfferCalendars(sf.client, { booking: booking({ enabled: false }), now: NOW })).toEqual({ kind: 'none', note: 'booking_off' });
    expect(sf.soql).toEqual([]);
  });

  it('an inactive rep is dropped, and its calendar is not read', async () => {
    const sf = offerSalesforce({ users: usersWithInactive(BLAKE) });
    const cal = await readOfferCalendars(sf.client, { booking: booking(), now: NOW });
    if (cal.kind !== 'read') throw new Error('expected a calendar read');
    expect([...cal.reps.keys()]).toEqual([CHANCE, SETH, THOMAS].map(core));
    expect(sf.soql[1]).not.toContain(BLAKE);
  });

  it('a region whose reps are all inactive: no_reps and no regular times, but Grant\'s priority (street address) owns it; the other region still offers', async () => {
    const users = usersWithInactive(SETH, THOMAS);
    const sd = (await offerFor(SD_PROPERTY, { users })).offer;
    expect(sd).toMatchObject({ slots: [], region: 'SD', ownerSfUserId: GRANT, note: 'no_reps' });
    expect(sd.priority?.specialistSfUserId).toBe(GRANT);
    expect((await offerFor(OC_PROPERTY, { users })).offer.slots.length).toBeGreaterThan(0);
  });

  it('a region whose reps are all inactive, no street address: no_reps and no priority', async () => {
    expect((await offerFor(SD_CITY_ONLY, { users: usersWithInactive(SETH, THOMAS) })).offer).toEqual(none('no_reps', 'SD'));
  });

  it('a region whose reps are all inactive, Grant inactive too: no_reps and nothing offered', async () => {
    expect((await offerFor(SD_PROPERTY, { users: usersWithInactive(SETH, THOMAS, GRANT) })).offer).toEqual(none('no_reps', 'SD'));
  });

  it('no active rep anywhere but Grant: a read with no reps and the priority rep, and no Event query', async () => {
    const sf = offerSalesforce({ users: usersWithInactive(CHANCE, BLAKE, SETH, THOMAS) });
    const cal = await readOfferCalendars(sf.client, { booking: booking(), now: NOW });
    if (cal.kind !== 'read') throw new Error('expected a calendar read');
    expect(cal.reps.size).toBe(0);
    expect(cal.priority?.sfUserId).toBe(GRANT);
    expect(sf.soql).toHaveLength(1);
    const offer = (await offerFor(OC_PROPERTY, { users: usersWithInactive(CHANCE, BLAKE, SETH, THOMAS) })).offer;
    expect(offer).toMatchObject({ slots: [], region: 'LA', ownerSfUserId: GRANT, note: 'no_reps' });
    expect(offer.priority?.timeZone).toBe('America/Los_Angeles');
  });

  it('no active rep anywhere and Grant inactive: none/no_reps, and no Event query', async () => {
    const sf = offerSalesforce({ users: usersWithInactive(CHANCE, BLAKE, SETH, THOMAS, GRANT) });
    expect(await readOfferCalendars(sf.client, { booking: booking(), now: NOW })).toEqual({ kind: 'none', note: 'no_reps' });
    expect(sf.soql).toHaveLength(1);
  });

  it('a busy read that hits its row cap is logged (counts only)', async () => {
    const row = eventRow(CHANCE, '2026-10-20T16:00:00.000Z', '2026-10-20T17:00:00.000Z');
    const sf = offerSalesforce({ events: Array.from({ length: BUSY_ROW_LIMIT }, () => row) });
    const warn = vi.fn();
    await readOfferCalendars(sf.client, { booking: booking(), now: NOW, log: { warn } });
    expect(warn).toHaveBeenCalledWith({ reps: 4, rows: BUSY_ROW_LIMIT }, expect.any(String));
  });
});

describe('priorityDefaultStart: the next booking day after today, 9:00 Pacific', () => {
  const weekdays = [1, 2, 3, 4, 5];
  it.each([
    ['Mon 16:00 PDT → Tue 9:00 PDT', '2026-10-19T23:00:00Z', weekdays, '2026-10-20T16:00:00.000Z'],
    ['Fri 9:00 PDT → Mon 9:00 PDT', '2026-10-23T16:00:00Z', weekdays, '2026-10-26T16:00:00.000Z'],
    ['Fri before daylight saving ends → Mon 9:00 PST', '2026-10-30T16:00:00Z', weekdays, '2026-11-02T17:00:00.000Z'],
    ['every day booked: Fri → Sat', '2026-10-23T16:00:00Z', [1, 2, 3, 4, 5, 6, 7], '2026-10-24T16:00:00.000Z'],
  ])('%s', (_label, now, days, expected) => {
    expect(priorityDefaultStart(days, new Date(now)).toISOString()).toBe(expected);
  });
});

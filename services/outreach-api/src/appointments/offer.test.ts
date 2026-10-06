import { describe, expect, it } from 'vitest';
import { AppointmentSlots, type AiCallBookingSettings } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { fakeSalesforce, type QueryRoute } from '../test/fake-sf-client.js';
import { rowsWhere } from '../test/fake-soql-where.js';
import { offerFrom, offerSlots, readOfferCalendar } from './offer.js';
import { zonedParts } from './zoned.js';

const GRANT = '0058X00000Fsx39QAB';
const X = '0058X00000Abcd1QAB';
/** Tuesday 2026-10-06 08:00 PDT. */
const NOW = new Date('2026-10-06T15:00:00.000Z');
const booking = (over: Partial<AiCallBookingSettings> = {}): AiCallBookingSettings => ({ ...structuredClone(DEFAULT_AI_CALL_BOOKING), specialists: [GRANT], ...over });
const grantRow = (over: Record<string, unknown> = {}) => ({ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true, TimeZoneSidKey: 'America/Los_Angeles', ...over });
const sfWith = (users: QueryRoute[1], events: QueryRoute[1] = []) => fakeSalesforce({ queries: [[/FROM User/, users], [/FROM Event/, events]] });

describe('offerSlots', () => {
  it('booking off gives booking_off and reads nothing', async () => {
    for (const b of [booking({ enabled: false }), booking({ specialists: [] })]) {
      const sf = sfWith([grantRow()]);
      expect(await offerSlots(sf.client, { booking: b, now: NOW })).toEqual({ slots: [], ownerSfUserId: null, note: 'booking_off' });
      expect(sf.soql).toEqual([]);
    }
  });

  it('the owner inactive gives no_owner and no Event query', async () => {
    const sf = sfWith([grantRow({ IsActive: false })]);
    expect(await offerSlots(sf.client, { booking: booking(), now: NOW })).toEqual({ slots: [], ownerSfUserId: null, note: 'no_owner' });
    expect(sf.soql).toHaveLength(1);
    expect(sf.soql[0]).toMatch(/FROM User/);
  });

  it('a list of ids Salesforce does not return gives no_owner', async () => {
    const sf = sfWith([]);
    expect((await offerSlots(sf.client, { booking: booking({ specialists: [X] }), now: NOW })).note).toBe('no_owner');
  });

  it('phone slots then walkthrough slots, every slot the owner\'s, the whole result parses', async () => {
    const sf = sfWith([grantRow()]);
    const offer = await offerSlots(sf.client, { booking: booking(), now: NOW });
    expect(offer.note).toBeNull();
    expect(offer.ownerSfUserId).toBe(GRANT);
    expect(offer.slots.map((s) => s.id)).toEqual(['p1', 'p2', 'p3', 'p4', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
    expect(offer.slots.every((s) => s.specialistSfUserId === GRANT && s.specialistFirstName === 'Grant' && s.timeZone === 'America/Los_Angeles')).toBe(true);
    expect(AppointmentSlots.safeParse(offer.slots).success).toBe(true);
    expect(offer.slots[0]).toMatchObject({ kind: 'phone', start: '2026-10-06T17:00:00.000Z', end: '2026-10-06T17:15:00.000Z' });
    expect(offer.slots[4]).toMatchObject({ kind: 'walkthrough', start: '2026-10-07T16:00:00.000Z', end: '2026-10-07T17:00:00.000Z' });
    // Part 4 Fix 1 (I-3): a walkthrough carries its 30-minute travel buffer as the time it blocks; a phone call has none.
    expect(offer.slots[4]).toMatchObject({ blockStart: '2026-10-07T15:30:00.000Z', blockEnd: '2026-10-07T17:30:00.000Z' });
    expect(offer.slots[0]).not.toHaveProperty('blockStart');
    // The busy read covers now to now + 15 days.
    expect(sf.soql[1]).toContain('StartDateTime < 2026-10-21T15:00:00Z');
    expect(sf.soql[1]).toContain(`OwnerId = '${GRANT}'`);
  });

  it('the second person on the list owns the slots when the first is inactive; the owner\'s zone is used', async () => {
    const sf = sfWith([grantRow({ IsActive: false }), grantRow({ Id: X, FirstName: 'Xavier', TimeZoneSidKey: 'America/New_York' })]);
    const offer = await offerSlots(sf.client, { booking: booking({ specialists: [GRANT, X] }), now: NOW });
    expect(offer.ownerSfUserId).toBe(X);
    expect(offer.slots.every((s) => s.specialistSfUserId === X && s.specialistFirstName === 'Xavier' && s.timeZone === 'America/New_York')).toBe(true);
    // Wednesday 9:00 New York (it would be 16:00Z in Los Angeles).
    expect(offer.slots.find((s) => s.id === 'w1')!.start).toBe('2026-10-07T13:00:00.000Z');
  });

  it('busy time is taken out', async () => {
    const events = [{ StartDateTime: '2026-10-07T16:00:00.000+0000', EndDateTime: '2026-10-07T17:00:00.000+0000', IsAllDayEvent: false, ActivityDate: '2026-10-07' }];
    const offer = await offerSlots(sfWith([grantRow()], events).client, { booking: booking(), now: NOW });
    // Wednesday 9:00 PDT is busy, so Wednesday's walkthrough morning is 11:00 (10:00's buffer still meets the Event).
    expect(offer.slots.find((s) => s.id === 'w1')?.start).toBe('2026-10-07T18:00:00.000Z');
  });

  it('a fully busy horizon gives no_free_time', async () => {
    const events = [{ StartDateTime: '2026-10-01T00:00:00.000+0000', EndDateTime: '2026-11-01T00:00:00.000+0000', IsAllDayEvent: false }];
    expect(await offerSlots(sfWith([grantRow()], events).client, { booking: booking(), now: NOW })).toEqual({ slots: [], ownerSfUserId: GRANT, note: 'no_free_time' });
  });

  it('both kinds off gives no_free_time; one kind off offers only the other', async () => {
    const off = booking({ phone: { ...DEFAULT_AI_CALL_BOOKING.phone, enabled: false }, walkthrough: { ...DEFAULT_AI_CALL_BOOKING.walkthrough, enabled: false } });
    expect((await offerSlots(sfWith([grantRow()]).client, { booking: off, now: NOW })).note).toBe('no_free_time');
    const walkOnly = booking({ phone: { ...DEFAULT_AI_CALL_BOOKING.phone, enabled: false } });
    expect((await offerSlots(sfWith([grantRow()]).client, { booking: walkOnly, now: NOW })).slots.map((s) => s.id)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
  });

  it('never offers time whose calendar it did not read (past now + 15 days)', async () => {
    const mondays = booking({ days: [1], walkthrough: { ...DEFAULT_AI_CALL_BOOKING.walkthrough, horizonBusinessDays: 10 }, phone: { ...DEFAULT_AI_CALL_BOOKING.phone, enabled: false } });
    const offer = await offerSlots(sfWith([grantRow()]).client, { booking: mondays, now: NOW });
    expect(offer.slots.length).toBeGreaterThan(0);
    expect(offer.slots.every((s) => Date.parse(s.end) <= NOW.getTime() + 15 * 86_400_000)).toBe(true);
  });

  it('maxOffered caps each kind', async () => {
    const b = booking({ phone: { ...DEFAULT_AI_CALL_BOOKING.phone, maxOffered: 1 }, walkthrough: { ...DEFAULT_AI_CALL_BOOKING.walkthrough, maxOffered: 3 } });
    expect((await offerSlots(sfWith([grantRow()]).client, { booking: b, now: NOW })).slots.map((s) => s.id)).toEqual(['p1', 'w1', 'w2', 'w3']);
  });

  it('a query throwing gives salesforce_error with no slots (never throws)', async () => {
    for (const sf of [sfWith(new SalesforceApiError('boom', 500, null)), sfWith([grantRow()], new Error('socket hang up'))]) {
      expect(await offerSlots(sf.client, { booking: booking(), now: NOW })).toEqual({ slots: [], ownerSfUserId: null, note: 'salesforce_error' });
    }
  });

  describe('Fix 1 (I-1a): today\'s all-day Event blocks today late in the local day (lead 0 h, until 22:00)', () => {
    const late = (zone: string) =>
      booking({
        phone: { ...DEFAULT_AI_CALL_BOOKING.phone, minLeadMinutes: 0, endHour: 22 },
        walkthrough: { ...DEFAULT_AI_CALL_BOOKING.walkthrough, enabled: false },
      });
    const table = [{ StartDateTime: '2026-10-06T00:00:00.000+0000', EndDateTime: '2026-10-06T00:00:00.000+0000', IsAllDayEvent: true, ActivityDate: '2026-10-06' }];
    it.each([
      ['Pacific/Honolulu', '2026-10-07T00:30:00.000Z'], // Tue 10/6 14:30 HST
      ['America/Los_Angeles', '2026-10-07T00:30:00.000Z'], // Tue 10/6 17:30 PDT
    ])('%s at %s: nothing today, the first time is tomorrow morning', async (zone, at) => {
      const now = new Date(at);
      const users: QueryRoute[1] = [grantRow({ TimeZoneSidKey: zone })];
      const sf = sfWith(users, (q: string) => rowsWhere(q, table));
      const offer = await offerSlots(sf.client, { booking: late(zone), now });
      // Without the all-day Event, today still has times (so the test can fail).
      const free = await offerSlots(sfWith(users, []).client, { booking: late(zone), now });
      expect(free.slots.some((s) => zonedParts(new Date(s.start), zone).day === 6)).toBe(true);
      expect(offer.slots.length).toBeGreaterThan(0);
      expect(offer.slots.every((s) => zonedParts(new Date(s.start), zone).day === 7)).toBe(true);
      expect(zonedParts(new Date(offer.slots[0]!.start), zone)).toMatchObject({ day: 7, hour: 10, minute: 0 });
    });
  });

  describe('Fix 1 (I-4, M-1): the calendar is read once, and booked times are taken out per touch', () => {
    it('readOfferCalendar reads Salesforce; offerFrom is pure and takes out booked times like busy ones', async () => {
      const sf = sfWith([grantRow()]);
      const cal = await readOfferCalendar(sf.client, { booking: booking(), now: NOW });
      expect(sf.soql).toHaveLength(2);
      const first = offerFrom(cal, { booking: booking(), now: NOW, booked: [] });
      const p1 = first.slots[0]!;
      const booked = [{ start: new Date(p1.start), end: new Date(p1.end), allDay: false }];
      const second = offerFrom(cal, { booking: booking(), now: NOW, booked });
      expect(second.slots.map((s) => s.start)).not.toContain(p1.start);
      expect(second.slots[0]!.start).toBe('2026-10-06T17:30:00.000Z');
      expect(sf.soql).toHaveLength(2);
      // The same calendar again, with nothing booked, gives the first offer again (the read is not changed).
      expect(offerFrom(cal, { booking: booking(), now: NOW, booked: [] })).toEqual(first);
    });

    it('a booked walkthrough keeps its buffer', async () => {
      const cal = await readOfferCalendar(sfWith([grantRow()]).client, { booking: booking(), now: NOW });
      // Booked Wed 9:00–10:00 PDT: 10:00 is inside the 30 min buffer, so Wednesday's morning walkthrough is 11:00.
      const booked = [{ start: new Date('2026-10-07T16:00:00.000Z'), end: new Date('2026-10-07T17:00:00.000Z'), allDay: false }];
      const offer = offerFrom(cal, { booking: booking(), now: NOW, booked });
      expect(offer.slots.find((s) => s.id === 'w1')?.start).toBe('2026-10-07T18:00:00.000Z');
    });

    it('a calendar that could not be read carries its note through', async () => {
      const off = await readOfferCalendar(sfWith([grantRow()]).client, { booking: booking({ enabled: false }), now: NOW });
      expect(offerFrom(off, { booking: booking({ enabled: false }), now: NOW, booked: [] })).toEqual({ slots: [], ownerSfUserId: null, note: 'booking_off' });
      const broken = await readOfferCalendar(sfWith(new Error('socket hang up')).client, { booking: booking(), now: NOW });
      expect(offerFrom(broken, { booking: booking(), now: NOW, booked: [] })).toEqual({ slots: [], ownerSfUserId: null, note: 'salesforce_error' });
    });
  });
});


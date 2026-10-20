import { describe, expect, it } from 'vitest';
import { AppointmentSlots, type AiCallBookingSettings, type BookingRegion } from '@cti/contracts';
import { DEFAULT_AI_CALL_BOOKING, DEFAULT_BOOKING_ROUTING } from '../settings.js';
import type { OwnerUser } from './calendar.js';
import type { DriveTimer } from './drive.js';
import { MapsUnavailableError, type Place } from './maps.js';
import { MAX_ROUTE_ELEMENTS_PER_OFFER, inPersonSlots, phoneSlots, repCanReach, type RepCalendar, type RoutingInput } from './routing.js';
import type { Busy } from './slots.js';
import { zonedInstant } from './zoned.js';

const PT = 'America/Los_Angeles';
const LA: BookingRegion = DEFAULT_BOOKING_ROUTING.regions[0]!;
const SD: BookingRegion = DEFAULT_BOOKING_ROUTING.regions[1]!;
const user = (sfUserId: string, firstName: string, name: string): OwnerUser => ({ sfUserId, firstName, name, isActive: true, timeZone: PT, zoneRefused: null });
const CHANCE = user('0055f000005qXn8AAE', 'Chance', 'Chance Lanier');
const BLAKE = user('0058X00000FA8tLQAT', 'Blake', 'Blake Kossuth');
const SETH = user('0055f000005qXVfAAM', 'Seth', 'Seth Boisvert');
const THOMAS = user('0055f000005qYO6AAM', 'Thomas', 'Thomas Wilkinson');

/** Mon 2026-10-19 09:00 PDT. */
const NOW = new Date('2026-10-19T16:00:00Z');
const TUE_9 = '2026-10-20T16:00:00.000Z';
const TUE_13 = '2026-10-20T20:00:00.000Z';

const OFFICE_ADDRESS = DEFAULT_BOOKING_ROUTING.officeAddress;
const OFFICE: Place = { address: OFFICE_ADDRESS };
const PROPERTY: Place = { point: { lat: 33.8, lng: -117.9 } };
// Made-up places.
const ANAHEIM = '100 Main St, Anaheim, CA';
const FULLERTON = '200 Fake Oak Ave, Fullerton, CA';

/** October 2026 wall clock in Pacific time. */
const pt = (day: number, hh: number, mm = 0): Date => zonedInstant(PT, 2026, 10, day, hh, mm);
const item = (start: Date, end: Date, extra: Partial<Busy> = {}): Busy => ({ start, end, allDay: false, ...extra });
const consultation = (day: number, hh: number): Busy => item(pt(day, hh), pt(day, hh + 1), { consultation: true, location: null });
const allDay = (day: number): Busy => ({
  start: new Date(Date.UTC(2026, 9, day)),
  end: new Date(Date.UTC(2026, 9, day + 1)),
  allDay: true,
  day: { year: 2026, month: 10, day },
});
const cal = (rep: OwnerUser, busy: Busy[] = []): RepCalendar => ({ rep, busy });

const BOOKING: AiCallBookingSettings = {
  ...DEFAULT_AI_CALL_BOOKING,
  days: [1, 2, 3, 4, 5],
  walkthrough: { ...DEFAULT_AI_CALL_BOOKING.walkthrough, enabled: true, minLeadMinutes: 1200, horizonBusinessDays: 2, maxOffered: 6 },
  phone: { ...DEFAULT_AI_CALL_BOOKING.phone, enabled: true, minLeadMinutes: 0, horizonBusinessDays: 2, maxOffered: 6 },
};
const withWalkthrough = (patch: Partial<AiCallBookingSettings['walkthrough']>): AiCallBookingSettings => ({
  ...BOOKING,
  walkthrough: { ...BOOKING.walkthrough, ...patch },
});

interface MatrixCall {
  origins: Place[];
  destinations: Place[];
  departure: Date;
}
const label = (p: Place): string => ('address' in p ? p.address : 'property');

/**
 * A DriveTimer answering from `table` ('from>to' → minutes, null = no route; any other pair is 15 minutes) that records every
 * matrix call. `spent()` counts the elements asked unless the test sets it.
 */
function fakeDrive(table: Record<string, number | null> = {}, spent?: (calls: readonly MatrixCall[]) => number) {
  const calls: MatrixCall[] = [];
  const drive: DriveTimer = {
    async matrix(origins, destinations, departure) {
      calls.push({ origins: [...origins], destinations: [...destinations], departure });
      return origins.map((o) => destinations.map((d) => {
        const key = `${label(o)}>${label(d)}`;
        return key in table ? (table[key] ?? null) : 15;
      }));
    },
    spent: () => spent?.(calls) ?? calls.reduce((n, c) => n + c.origins.length * c.destinations.length, 0),
  };
  return { drive, calls };
}

const inPerson = (reps: RepCalendar[], drive: DriveTimer, over: Partial<RoutingInput> = {}) =>
  inPersonSlots({ region: LA, reps, booking: BOOKING, now: NOW, property: PROPERTY, office: OFFICE, drive, ...over });
const repAt = (slots: ReadonlyArray<{ start: string; specialistSfUserId: string }>, start: string): string | undefined =>
  slots.find((s) => s.start === start)?.specialistSfUserId;

describe('inPersonSlots', () => {
  it('both reps free from the office: no route lookup; fewer consultations that week wins', async () => {
    const { drive, calls } = fakeDrive();
    const chance = cal(CHANCE, [consultation(19, 10), consultation(19, 12), consultation(19, 14)]);
    const slots = await inPerson([chance, cal(BLAKE, [consultation(19, 11)])], drive);
    const blake = { kind: 'walkthrough', specialistSfUserId: BLAKE.sfUserId, specialistFirstName: 'Blake', timeZone: PT, region: 'LA' };
    expect(slots).toEqual([
      { id: 'w1', start: TUE_9, end: '2026-10-20T17:00:00.000Z', ...blake },
      { id: 'w2', start: TUE_13, end: '2026-10-20T21:00:00.000Z', ...blake },
    ]);
    expect(AppointmentSlots.safeParse(slots).success).toBe(true);
    expect(calls).toEqual([]);
  });

  it('only consultations that start in the candidate\'s ISO week count', async () => {
    const { drive } = fakeDrive();
    // Chance's three were the week before (Fri Oct 16); Blake's one is this week, so Chance has fewer.
    const chance = cal(CHANCE, [consultation(16, 10), consultation(16, 12), consultation(16, 14)]);
    const slots = await inPerson([chance, cal(BLAKE, [consultation(19, 11)])], drive);
    expect(repAt(slots, TUE_9)).toBe(CHANCE.sfUserId);
  });

  it('the shorter drive in wins', async () => {
    const { drive, calls } = fakeDrive({ [`${ANAHEIM}>property`]: 20, [`${OFFICE_ADDRESS}>property`]: 45 });
    const chance = cal(CHANCE, [item(pt(20, 7), pt(20, 8, 30), { location: ANAHEIM })]);
    const slots = await inPerson([chance, cal(BLAKE)], drive);
    expect(slots[0]).toMatchObject({ id: 'w1', start: TUE_9, specialistSfUserId: CHANCE.sfUserId, specialistFirstName: 'Chance' });
    // Both reps' drives in, in one call, departing an hour before the start.
    expect(calls[0]).toEqual({ origins: [{ address: ANAHEIM }, OFFICE], destinations: [PROPERTY], departure: new Date('2026-10-20T15:00:00.000Z') });
  });

  it('a drive in that does not fit', async () => {
    const { drive } = fakeDrive({ [`${ANAHEIM}>property`]: 30, [`${OFFICE_ADDRESS}>property`]: 45 });
    const chance = cal(CHANCE, [item(pt(20, 7, 45), pt(20, 8, 45), { location: ANAHEIM })]);
    const slots = await inPerson([chance, cal(BLAKE)], drive);
    expect(slots[0]).toMatchObject({ id: 'w1', start: TUE_9, specialistSfUserId: BLAKE.sfUserId });
  });

  it('the drive to the next appointment must fit', async () => {
    const later = item(pt(20, 10, 15), pt(20, 11), { location: FULLERTON });
    const tooFar = fakeDrive({ [`property>${FULLERTON}`]: 30 });
    expect(repAt(await inPerson([cal(CHANCE, [later]), cal(BLAKE)], tooFar.drive), TUE_9)).toBe(BLAKE.sfUserId);
    // The drive out leaves at the end, 10:00 PDT; with no earlier items nothing is looked up for the drive in.
    expect(tooFar.calls[0]).toEqual({ origins: [PROPERTY], destinations: [{ address: FULLERTON }], departure: new Date('2026-10-20T17:00:00.000Z') });
    const closeEnough = fakeDrive({ [`property>${FULLERTON}`]: 15 });
    expect(repAt(await inPerson([cal(CHANCE, [later]), cal(BLAKE)], closeEnough.drive), TUE_9)).toBe(CHANCE.sfUserId);
  });

  it('an unusable Location starts from the office', async () => {
    const { drive, calls } = fakeDrive();
    const chance = cal(CHANCE, [item(pt(20, 7), pt(20, 8), { location: 'Zoom' })]);
    const slots = await inPerson([chance, cal(BLAKE)], drive);
    expect(calls[0]?.origins).toEqual([OFFICE]);
    // Both start from the office at 15 minutes: region order.
    expect(repAt(slots, TUE_9)).toBe(CHANCE.sfUserId);
  });

  it('each place is asked once', async () => {
    const { drive, calls } = fakeDrive();
    const at = (location: string): Busy[] => [item(pt(20, 7), pt(20, 8), { location })];
    await inPerson([cal(CHANCE, at(ANAHEIM)), cal(BLAKE, at(`  ${ANAHEIM.toUpperCase()} `))], drive);
    expect(calls[0]?.origins).toEqual([{ address: ANAHEIM }]);
  });

  it('a route Google cannot find uses the office drive', async () => {
    const { drive, calls } = fakeDrive({ [`${ANAHEIM}>property`]: null, [`${OFFICE_ADDRESS}>property`]: 25 });
    const chance = cal(CHANCE, [item(pt(20, 7, 30), pt(20, 8, 30), { location: ANAHEIM })]);
    // Blake is busy at 09:00, so only Chance can take it: 08:30 + 25 ≤ 09:00.
    const slots = await inPerson([chance, cal(BLAKE, [item(pt(20, 9), pt(20, 10))])], drive);
    expect(repAt(slots, TUE_9)).toBe(CHANCE.sfUserId);
    expect(calls.slice(0, 2).map((c) => c.origins)).toEqual([[{ address: ANAHEIM }], [OFFICE]]);
  });

  it('no route from the office either: the rep does not fit', async () => {
    const { drive } = fakeDrive({ [`${ANAHEIM}>property`]: null, [`${OFFICE_ADDRESS}>property`]: null });
    const chance = cal(CHANCE, [item(pt(20, 7, 30), pt(20, 8, 30), { location: ANAHEIM })]);
    const slots = await inPerson([chance, cal(BLAKE, [item(pt(20, 9), pt(20, 10))])], drive);
    expect(slots).toEqual([]);
  });

  it('overlap and all-day items make a rep not free', async () => {
    const { drive } = fakeDrive();
    const slots = await inPerson([cal(CHANCE, [item(pt(20, 9, 30), pt(20, 10, 30))]), cal(BLAKE, [allDay(20)])], drive);
    expect(repAt(slots, TUE_9)).toBeUndefined();
    // The next morning start goes to Chance, back from the 10:30 item in time.
    expect(slots.map((s) => [s.start, s.specialistSfUserId])).toEqual([
      ['2026-10-20T18:00:00.000Z', CHANCE.sfUserId],
      [TUE_13, CHANCE.sfUserId],
    ]);
  });

  it('stops at maxOffered and at the route budget', async () => {
    expect(MAX_ROUTE_ELEMENTS_PER_OFFER).toBe(60);
    const reps = (): RepCalendar[] => [cal(CHANCE, [item(pt(20, 7), pt(20, 8), { location: ANAHEIM })]), cal(BLAKE)];

    const one = await inPerson(reps(), fakeDrive().drive, { booking: withWalkthrough({ maxOffered: 1 }) });
    expect(one.map((s) => s.id)).toEqual(['w1']);

    const spentOut = fakeDrive({}, () => MAX_ROUTE_ELEMENTS_PER_OFFER);
    expect(await inPerson(reps(), spentOut.drive)).toEqual([]);
    expect(spentOut.calls).toEqual([]);

    // The budget runs out after the first candidate's lookup: checked before the next one.
    const midway = fakeDrive({}, (calls) => (calls.length > 0 ? MAX_ROUTE_ELEMENTS_PER_OFFER : 0));
    expect((await inPerson(reps(), midway.drive)).map((s) => s.start)).toEqual([TUE_9]);
    expect(midway.calls).toHaveLength(1);
  });

  it('daylight saving ends', async () => {
    const { drive } = fakeDrive();
    const slots = await inPerson([cal(CHANCE), cal(BLAKE)], drive, { now: new Date('2026-10-30T16:00:00Z') });
    expect(slots[0]?.start).toBe('2026-11-02T17:00:00.000Z');
    expect(slots[1]?.start).toBe('2026-11-02T21:00:00.000Z');
  });

  it('a disabled kind offers nothing and asks nothing', async () => {
    const { drive, calls } = fakeDrive();
    const reps = [cal(CHANCE, [item(pt(20, 7), pt(20, 8), { location: ANAHEIM })]), cal(BLAKE)];
    expect(await inPerson(reps, drive, { booking: withWalkthrough({ enabled: false }) })).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a matrix rejection reaches the caller', async () => {
    const drive: DriveTimer = { matrix: async () => Promise.reject(new MapsUnavailableError('ZERO_RESULTS')), spent: () => 0 };
    const reps = [cal(CHANCE, [item(pt(20, 7), pt(20, 8), { location: ANAHEIM })]), cal(BLAKE)];
    await expect(inPerson(reps, drive)).rejects.toBeInstanceOf(MapsUnavailableError);
  });
});

describe('phoneSlots', () => {
  const input = (over: Partial<RoutingInput> = {}): RoutingInput => ({ region: LA, reps: [cal(CHANCE), cal(BLAKE)], booking: BOOKING, now: NOW, ...over });

  it('SD region: first morning 09:00, first afternoon 12:00', () => {
    const slots = phoneSlots(input({ region: SD, reps: [cal(SETH), cal(THOMAS)] }));
    expect(slots.map((s) => [s.id, s.start, s.end])).toEqual([
      ['p1', '2026-10-19T16:00:00.000Z', '2026-10-19T17:00:00.000Z'],
      ['p2', '2026-10-19T19:00:00.000Z', '2026-10-19T20:00:00.000Z'],
      ['p3', '2026-10-20T16:00:00.000Z', '2026-10-20T17:00:00.000Z'],
      ['p4', '2026-10-20T19:00:00.000Z', '2026-10-20T20:00:00.000Z'],
    ]);
    expect(slots.every((s) => s.kind === 'phone' && s.region === 'SD' && s.specialistSfUserId === SETH.sfUserId)).toBe(true);
    expect(AppointmentSlots.safeParse(slots).success).toBe(true);
  });

  it('phone: no drive lookups; fewer consultations that day wins', () => {
    const { drive, calls } = fakeDrive();
    const reps = [cal(CHANCE, [consultation(20, 13), consultation(20, 15)]), cal(BLAKE)];
    const routed = { ...input({ reps }), property: PROPERTY, office: OFFICE, drive };
    const slots = phoneSlots(routed);
    expect(repAt(slots, TUE_9)).toBe(BLAKE.sfUserId);
    // Monday each has none that day: region order.
    expect(repAt(slots, '2026-10-19T16:00:00.000Z')).toBe(CHANCE.sfUserId);
    expect(calls).toEqual([]);
  });

  it('stops at maxOffered, and a disabled kind offers nothing', () => {
    const phone = (patch: Partial<AiCallBookingSettings['phone']>) => input({ booking: { ...BOOKING, phone: { ...BOOKING.phone, ...patch } } });
    expect(phoneSlots(phone({ maxOffered: 3 })).map((s) => s.id)).toEqual(['p1', 'p2', 'p3']);
    expect(phoneSlots(phone({ enabled: false }))).toEqual([]);
  });
});

describe('repCanReach', () => {
  const reach = (busy: Busy[], table: Record<string, number | null>) => {
    const { drive, calls } = fakeDrive(table);
    return { calls, ok: repCanReach({ busy, start: pt(20, 9), property: PROPERTY, office: OFFICE, drive, slackMinutes: 15 }) };
  };

  it('repCanReach allows the slack', async () => {
    const earlier = item(pt(20, 7, 45), pt(20, 8, 45), { location: ANAHEIM });
    expect(await reach([earlier], { [`${ANAHEIM}>property`]: 25 }).ok).toBe(true);
    expect(await reach([earlier], { [`${ANAHEIM}>property`]: 35 }).ok).toBe(false);
    const later = item(pt(20, 10, 20), pt(20, 11, 20), { location: FULLERTON });
    expect(await reach([later], { [`property>${FULLERTON}`]: 25 }).ok).toBe(true);
    expect(await reach([later], { [`property>${FULLERTON}`]: 40 }).ok).toBe(false);
  });

  it('nothing around the start: true with no lookup', async () => {
    const r = reach([item(pt(19, 9), pt(19, 10))], {});
    expect(await r.ok).toBe(true);
    expect(r.calls).toEqual([]);
  });
});

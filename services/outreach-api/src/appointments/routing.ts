/**
 * Rep routing (pure apart from the drive timer): for a property in a booking region, which of the region's reps takes each
 * candidate start, and which starts are offered. Start times are wall-clock times in ROUTING_ZONE and every consultation
 * lasts CONSULTATION_MINUTES. Per local day the first morning (hour < 12) and the first afternoon that someone can take are
 * offered.
 *
 * In person, a free rep fits when the drive in arrives by the start and the drive out arrives by its later item's start. The
 * drive in is from its earlier item's place that day (or the office, at that item's end); with nothing earlier that day the
 * rep starts at the office at REP_DAY_START_HOUR (8:00 AM Pacific). The shortest drive in wins, then fewer consultations
 * that ISO week, then region order. By phone there is no drive: fewer consultations that day, then region order.
 * Seller addresses and Event Locations are PII: nothing here logs.
 */
import { CONSULTATION_MINUTES, ROUTING_ZONE, type AiCallBookingSettings, type AppointmentKind, type AppointmentSlot, type BookingRegion } from '@cti/contracts';
import type { OwnerUser } from './calendar.js';
import type { DriveTimer } from './drive.js';
import { placeKey, type Place } from './maps.js';
import { usableAddress } from './places.js';
import { conflicts, horizonDays, type Busy, type KindRules, type Window } from './slots.js';
import { addLocalDays, zonedInstant, zonedParts, type LocalDay } from './zoned.js';

/** Route elements one offer may spend; checked before each in-person candidate. */
export const MAX_ROUTE_ELEMENTS_PER_OFFER = 60;
/**
 * Every rep starts the day at the office at this hour, in ROUTING_ZONE: the drive in to the day's first visit leaves the
 * office then, so it must fit between 8:00 AM and that visit's start (the offer and the write-back's re-check alike).
 */
export const REP_DAY_START_HOUR = 8;

export interface RepCalendar {
  rep: OwnerUser;
  busy: readonly Busy[];
}
export interface RoutingInput {
  region: BookingRegion;
  /** The region's ACTIVE reps in region order, each with its calendar (AI bookings not on it yet already added). */
  reps: readonly RepCalendar[];
  booking: AiCallBookingSettings;
  now: Date;
}
interface Drives {
  property: Place;
  office: Place;
  drive: DriveTimer;
}

const MIN = 60_000;
/** The drive in is timed as leaving this long before the start. */
const DRIVE_IN_LEAD_MINUTES = 60;

/**
 * Around a window: the rep's last item that day to end by its start (or, with none, the day's start at the office: see
 * dayStartAtOffice), and the first to start from its end.
 */
interface Around {
  earlier: Busy;
  later: Busy | null;
}
interface Pick {
  w: Window;
  rep: OwnerUser;
}
interface Ranked {
  rep: OwnerUser;
  order: number;
  driveIn: number;
  load: number;
}

const midnight = (d: LocalDay): Date => zonedInstant(ROUTING_ZONE, d.year, d.month, d.day, 0, 0);
/** From local midnight `from` days after `at`'s local day to local midnight `to` days after it. */
const localSpan = (at: Date, from: number, to: number): Window => ({
  start: midnight(addLocalDays(at, from, ROUTING_ZONE)),
  end: midnight(addLocalDays(at, to, ROUTING_ZONE)),
});
/** Monday 00:00 to the next Monday 00:00. */
const isoWeekOf = (at: Date): Window => {
  const weekday = zonedParts(at, ROUTING_ZONE).isoWeekday;
  return localSpan(at, 1 - weekday, 8 - weekday);
};
const windowAt = (start: Date): Window => ({ start, end: new Date(start.getTime() + CONSULTATION_MINUTES * MIN) });
const driveInDeparture = (w: Window): Date => new Date(w.start.getTime() - DRIVE_IN_LEAD_MINUTES * MIN);
const isFree = (busy: readonly Busy[], w: Window): boolean => !conflicts(w, busy, ROUTING_ZONE, 0);
const consultationsStarting = (busy: readonly Busy[], span: Window): number =>
  busy.filter((b) => b.consultation && b.start.getTime() >= span.start.getTime() && b.start.getTime() < span.end.getTime()).length;

const endsLater = (a: Busy | null, b: Busy): Busy => (a && a.end.getTime() >= b.end.getTime() ? a : b);
const startsSooner = (a: Busy | null, b: Busy): Busy => (a && a.start.getTime() <= b.start.getTime() ? a : b);

/** REP_DAY_START_HOUR:00 on `at`'s local day in ROUTING_ZONE (zonedInstant: right on both sides of daylight saving). */
export function repDayStart(at: Date): Date {
  const d = addLocalDays(at, 0, ROUTING_ZONE);
  return zonedInstant(ROUTING_ZONE, d.year, d.month, d.day, REP_DAY_START_HOUR, 0);
}

/** With nothing earlier that day the rep is at the office from REP_DAY_START_HOUR: an item with no Location that ends then. */
function dayStartAtOffice(w: Window): Busy {
  const at = repDayStart(w.start);
  return { start: at, end: at, allDay: false, location: null };
}

/** The rep's timed items on `w`'s local day. */
function dayItems(busy: readonly Busy[], w: Window): Busy[] {
  const span = localSpan(w.start, 0, 1);
  return busy.filter((b) => !b.allDay && b.start.getTime() < span.end.getTime() && b.end.getTime() > span.start.getTime());
}

/** Shared by the offer and the write-back's re-check: the rep's earlier and later item around `w` (see Around). */
function around(busy: readonly Busy[], w: Window): Around {
  const day = dayItems(busy, w);
  const earlier = day.filter((b) => b.end.getTime() <= w.start.getTime()).reduce<Busy | null>(endsLater, null);
  const later = day.filter((b) => b.start.getTime() >= w.end.getTime()).reduce<Busy | null>(startsSooner, null);
  return { earlier: earlier ?? dayStartAtOffice(w), later };
}

/** Where a rep is next to an item: its Location when that is a drivable address, else the office (and with no item). */
function placeOf(item: Busy | null, office: Place): Place {
  const address = item ? usableAddress(item.location) : null;
  return address ? { address } : office;
}

/**
 * Minutes between each distinct place and the property, keyed by placeKey: place → property ('in') or property → place
 * ('out'), departing `departure`. An address with no route is timed as the office instead; no route from or to the office
 * stays null.
 */
async function legMinutes(d: Drives, places: readonly Place[], leg: 'in' | 'out', departure: Date): Promise<Map<string, number | null>> {
  const ask = async (ps: readonly Place[]): Promise<(number | null)[]> => {
    if (leg === 'in') return (await d.drive.matrix(ps, [d.property], departure)).map((row) => row[0] ?? null);
    const row = (await d.drive.matrix([d.property], ps, departure))[0] ?? [];
    return ps.map((_, n) => row[n] ?? null);
  };
  const keys = places.map(placeKey);
  const distinct = places.filter((_, n) => keys.indexOf(keys[n]!) === n);
  const first = await ask(distinct);
  const minutes = new Map(distinct.map((p, n) => [placeKey(p), first[n] ?? null]));
  const officeKey = placeKey(d.office);
  if (![...minutes].some(([key, m]) => m === null && key !== officeKey)) return minutes;
  const office = minutes.has(officeKey) ? (minutes.get(officeKey) ?? null) : ((await ask([d.office]))[0] ?? null);
  return new Map([...minutes].map(([key, m]) => [key, m ?? office]));
}

/**
 * Both drives fit, each allowed `slackMs`: the drive in from the earlier item (or the office at REP_DAY_START_HOUR) arrives
 * by the start, and the drive out arrives by the later item's start. With no later item the drive out needs nothing
 * (undefined: not looked up); a drive with no route (null) never fits.
 */
function drivesFit(a: Around, w: Window, driveIn: number | null | undefined, driveOut: number | null | undefined, slackMs: number): boolean {
  if (driveIn === null || driveOut === null) return false;
  const inFits = driveIn !== undefined && a.earlier.end.getTime() + driveIn * MIN <= w.start.getTime() + slackMs;
  const outFits = a.later === null || (driveOut !== undefined && w.end.getTime() + driveOut * MIN <= a.later.start.getTime() + slackMs);
  return inFits && outFits;
}

/** Shortest drive in, then the lighter load, then region order. */
function best(ranked: readonly Ranked[]): OwnerUser | null {
  const [first] = [...ranked].sort((a, b) => a.driveIn - b.driveIn || a.load - b.load || a.order - b.order);
  return first?.rep ?? null;
}

/** The rep who takes `w` in person, or null when no free rep can make both drives. */
async function inPersonWinner(i: RoutingInput & Drives, w: Window): Promise<OwnerUser | null> {
  const free = i.reps.flatMap((r, order) => (isFree(r.busy, w) ? [{ ...r, order, ...around(r.busy, w) }] : []));
  if (free.length === 0) return null;
  const fromOf = (a: Around): Place => placeOf(a.earlier, i.office);
  const toOf = (a: Around): Place => placeOf(a.later, i.office);
  // Every free rep's drive in is timed, one element per distinct place: a rep with nothing earlier that day leaves the
  // office at REP_DAY_START_HOUR, and that drive must fit too.
  const withLater = free.filter((c) => c.later !== null);
  const [ins, outs] = await Promise.all([
    legMinutes(i, free.map(fromOf), 'in', driveInDeparture(w)),
    withLater.length > 0 ? legMinutes(i, withLater.map(toOf), 'out', w.end) : null,
  ]);
  const week = isoWeekOf(w.start);
  return best(
    free.flatMap((c) => {
      const driveIn = ins.get(placeKey(fromOf(c)));
      const driveOut = c.later ? outs?.get(placeKey(toOf(c))) : undefined;
      if (!drivesFit(c, w, driveIn, driveOut, 0)) return [];
      return [{ rep: c.rep, order: c.order, driveIn: driveIn ?? 0, load: consultationsStarting(c.busy, week) }];
    }),
  );
}

/** The free rep with the fewest consultations on `w`'s local day (then region order), or null. */
function phoneWinner(reps: readonly RepCalendar[], w: Window): OwnerUser | null {
  return best(
    reps.flatMap((r, order) =>
      isFree(r.busy, w) ? [{ rep: r.rep, order, driveIn: 0, load: dayItems(r.busy, w).filter((b) => b.consultation).length }] : [],
    ),
  );
}

/**
 * The candidate windows in time order, grouped by local day and then into mornings (hour < 12) and afternoons: at most one
 * window per group is offered. A start is a candidate on the first `horizonBusinessDays` booking days from today, when it
 * is at least the kind's lead time from now.
 */
function candidateGroups(i: RoutingInput, rules: KindRules): Window[][] {
  const earliest = i.now.getTime() + rules.minLeadMinutes * MIN;
  const times = i.region.startTimes.map((t) => ({ hour: Number(t.slice(0, 2)), minute: Number(t.slice(3, 5)) }));
  return horizonDays(rules.horizonBusinessDays, i.booking.days, i.now, ROUTING_ZONE).flatMap((day) => {
    const starts = times
      .map((t) => ({ morning: t.hour < 12, w: windowAt(zonedInstant(ROUTING_ZONE, day.year, day.month, day.day, t.hour, t.minute)) }))
      .filter((c) => c.w.start.getTime() >= earliest);
    return [true, false].map((morning) => starts.filter((c) => c.morning === morning).map((c) => c.w)).filter((group) => group.length > 0);
  });
}

function toRegionSlots(kind: AppointmentKind, picks: readonly Pick[], region: string): AppointmentSlot[] {
  const prefix = kind === 'phone' ? 'p' : 'w';
  return picks.map(({ w, rep }, n) => ({
    id: `${prefix}${n + 1}`,
    kind,
    start: w.start.toISOString(),
    end: w.end.toISOString(),
    specialistSfUserId: rep.sfUserId,
    specialistFirstName: rep.firstName,
    timeZone: rep.timeZone,
    region,
  }));
}

/** One candidate at a time: the route budget is checked before each, and a group stops at its first taken window. */
async function inPersonPicks(i: RoutingInput & Drives, rules: KindRules): Promise<Pick[]> {
  const picks: Pick[] = [];
  for (const group of candidateGroups(i, rules)) {
    for (const w of group) {
      if (picks.length >= rules.maxOffered || i.drive.spent() >= MAX_ROUTE_ELEMENTS_PER_OFFER) return picks;
      const rep = await inPersonWinner(i, w);
      if (rep) {
        picks.push({ w, rep });
        break;
      }
    }
  }
  return picks;
}

/** In-person times (w1…). Rejects when `drive.matrix` does (MapsUnavailableError): the caller handles it. */
export async function inPersonSlots(i: RoutingInput & Drives): Promise<AppointmentSlot[]> {
  const rules = i.booking.walkthrough;
  return rules.enabled ? toRegionSlots('walkthrough', await inPersonPicks(i, rules), i.region.key) : [];
}

/** Phone times (p1…): no drive. */
export function phoneSlots(i: RoutingInput): AppointmentSlot[] {
  const rules = i.booking.phone;
  if (!rules.enabled) return [];
  const picks = candidateGroups(i, rules).flatMap((group): Pick[] => {
    for (const w of group) {
      const rep = phoneWinner(i.reps, w);
      if (rep) return [{ w, rep }];
    }
    return [];
  });
  return toRegionSlots('phone', picks.slice(0, rules.maxOffered), i.region.key);
}

/**
 * The write-back's re-check of one booked rep (Task 8): both drives fit, each allowed `slackMinutes`, the day's first visit
 * from the office at REP_DAY_START_HOUR. Rejects when `drive.matrix` does (MapsUnavailableError): the caller handles it.
 */
export async function repCanReach(i: { busy: readonly Busy[]; start: Date; slackMinutes: number } & Drives): Promise<boolean> {
  const w = windowAt(i.start);
  const a = around(i.busy, w);
  const from = placeOf(a.earlier, i.office);
  const to = placeOf(a.later, i.office);
  const [ins, outs] = await Promise.all([
    legMinutes(i, [from], 'in', driveInDeparture(w)),
    a.later ? legMinutes(i, [to], 'out', w.end) : null,
  ]);
  return drivesFit(a, w, ins.get(placeKey(from)), outs?.get(placeKey(to)), i.slackMinutes * MIN);
}

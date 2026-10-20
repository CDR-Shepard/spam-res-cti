/**
 * The appointment offer an AI call carries, routed by region. Computed when the call is placed (calendars change after a plan
 * is approved), in two halves:
 *  - readOfferCalendars, the Salesforce half, read once per tenant per tick: the regions' active reps with their calendars,
 *    from 00:00 Monday of this week (so the week's earlier consultations count toward a rep's load) to OFFER_CALENDAR_DAYS
 *    ahead, and the high-priority rep (the first active user on `specialists`: Grant).
 *  - routedOffer, per record: the property's region by its county (Google Geocoding); that region's reps, each less the times
 *    other AI calls booked with them that no Event shows yet; in-person times by drive time and phone times; and the
 *    high-priority offer.
 * Neither throws: a failure offers fewer or no times, with a note, and the call still goes. Addresses, Event Locations and
 * names are seller data: log lines carry ids, counts, note codes and error codes only.
 */
import {
  AppointmentSlots, PRIORITY_RULES, ROUTING_ZONE,
  type AiCallBookingSettings, type AppointmentSlot, type BookingRegion, type BookingRouting, type Consultations, type PriorityOffer,
} from '@cti/contracts';
import type { Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { bookingActive, bookingRouting } from '../settings.js';
import { bookedNotOnCalendar } from './booked.js';
import { OFFER_CALENDAR_DAYS, readRepCalendars, readUsers, type OwnerUser } from './calendar.js';
import { driveTimer } from './drive.js';
import { MapsUnavailableError, type Geocoded, type MapsClient, type Place } from './maps.js';
import { appointmentOwner } from './owner.js';
import { regionFor, usableAddress } from './places.js';
import { inPersonSlots, phoneSlots, type RepCalendar, type RoutingInput } from './routing.js';
import { addLocalDays, zonedInstant, zonedParts, type LocalDay } from './zoned.js';

export { OFFER_CALENDAR_DAYS };

export type OfferNote = 'booking_off' | 'no_reps' | 'salesforce_error' | 'no_address' | 'maps_unavailable' | 'not_found'
  | 'outside_regions' | 'already_booked' | 'no_free_time' | 'invalid_slots';

export interface Offer {
  slots: AppointmentSlot[];
  priority: PriorityOffer | null;
  /** The booking region the property is in, once known. */
  region: string | null;
  ownerSfUserId: string | null;
  note: OfferNote | null;
}

/** The Salesforce half: the active reps' calendars keyed by 15-character id core, and the high-priority rep; or why there are none. */
export type OfferCalendars =
  | { kind: 'read'; routing: BookingRouting; reps: ReadonlyMap<string, RepCalendar>; priority: OwnerUser | null; from: Date; until: Date }
  | { kind: 'none'; note: 'booking_off' | 'no_reps' | 'salesforce_error' };

/** Ids, counts and error codes only. */
export interface OfferLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface OfferDeps {
  db: Db;
  maps: MapsClient | null;
  log: OfferLog & { info(o: Record<string, unknown>, m: string): void };
}

/** What routedOffer needs of one record besides the calendars. */
export interface OfferInput {
  orgId: string;
  booking: AiCallBookingSettings;
  now: Date;
  address: string | null;
  consultations: Consultations | null;
}
type ReadCalendars = Extract<OfferCalendars, { kind: 'read' }>;

const DAY_MS = 86_400_000;
const core = (id: string): string => id.slice(0, 15);
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** An offer with no times. */
export function noOffer(note: OfferNote, region: string | null = null): Offer {
  return { slots: [], priority: null, region, ownerSfUserId: null, note };
}

/** 00:00 Monday of `now`'s ISO week, in ROUTING_ZONE. */
function weekStart(now: Date): Date {
  const monday = addLocalDays(now, 1 - zonedParts(now, ROUTING_ZONE).isoWeekday, ROUTING_ZONE);
  return zonedInstant(ROUTING_ZONE, monday.year, monday.month, monday.day, 0, 0);
}

/** The routing's reps that Salesforce has as ACTIVE users, once each. */
function activeReps(routing: BookingRouting, users: ReadonlyMap<string, OwnerUser>): OwnerUser[] {
  const byCore = new Map([...users.values()].map((u) => [core(u.sfUserId), u]));
  const ids = new Set(routing.regions.flatMap((region) => region.reps.map(core)));
  return [...ids].flatMap((id) => {
    const user = byCore.get(id);
    return user?.isActive ? [user] : [];
  });
}

/** Reads Salesforce only; never throws. from = 00:00 Monday of this week (ROUTING_ZONE), until = now + 15 days. Only active reps are kept. */
export async function readOfferCalendars(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date; log?: OfferLog }): Promise<OfferCalendars> {
  const { booking, now } = i;
  if (!bookingActive(booking)) return { kind: 'none', note: 'booking_off' };
  const routing = bookingRouting(booking);
  try {
    // One User query: every region rep, and the specialists list that names the high-priority rep.
    const users = await readUsers(client, [...routing.regions.flatMap((region) => region.reps), ...booking.specialists]);
    const reps = activeReps(routing, users);
    if (reps.length === 0) return { kind: 'none', note: 'no_reps' };
    const from = weekStart(now);
    const until = new Date(now.getTime() + OFFER_CALENDAR_DAYS * DAY_MS);
    const capped = (rows: number) => i.log?.warn({ reps: reps.length, rows }, 'appointments: the reps\' busy read hit its row cap; later busy time may be missing');
    const busy = await readRepCalendars(client, reps.map((rep) => rep.sfUserId), from, until, ROUTING_ZONE, capped);
    const calendars = new Map(reps.map((rep) => [core(rep.sfUserId), { rep, busy: busy.get(core(rep.sfUserId)) ?? [] }]));
    return { kind: 'read', routing, reps: calendars, priority: appointmentOwner(booking, users), from, until };
  } catch (err) {
    i.log?.warn({ errName: errName(err) }, 'appointments: could not read the reps\' calendars; no times offered');
    return { kind: 'none', note: 'salesforce_error' };
  }
}

/** The next local day after today (ROUTING_ZONE) whose ISO weekday is in `days`, at PRIORITY_RULES.defaultStartHour:00. */
export function priorityDefaultStart(days: readonly number[], now: Date): Date {
  const weekday = (d: LocalDay): number => new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() || 7;
  const week = [1, 2, 3, 4, 5, 6, 7].map((n) => addLocalDays(now, n, ROUTING_ZONE));
  const day = week.find((d) => days.includes(weekday(d))) ?? week[0]!;
  return zonedInstant(ROUTING_ZONE, day.year, day.month, day.day, PRIORITY_RULES.defaultStartHour, 0);
}

/** The property's place in Google, or why there is none. A failure is logged by its code only (never the address). */
async function locate(maps: MapsClient, orgId: string, address: string, log: OfferLog): Promise<Geocoded | 'maps_unavailable' | 'not_found'> {
  try {
    return (await maps.geocode(address)) ?? 'not_found';
  } catch (err) {
    log.warn({ orgId, code: err instanceof MapsUnavailableError ? err.code : errName(err) }, 'appointments: could not look the property up; no times offered');
    return 'maps_unavailable';
  }
}

/** The region's reps the calendars have (active), in region order, each with the AI bookings no Event shows yet added to its busy. */
async function regionReps(db: Db, cal: ReadCalendars, region: BookingRegion, i: OfferInput): Promise<RepCalendar[]> {
  const present = [...new Set(region.reps.map(core))].flatMap((id) => cal.reps.get(id) ?? []);
  if (present.length === 0) return [];
  const booked = await bookedNotOnCalendar(db, { orgId: i.orgId, repSfUserIds: present.map((r) => r.rep.sfUserId), now: i.now, until: cal.until });
  return present.map((r) => ({ rep: r.rep, busy: [...r.busy, ...(booked.get(core(r.rep.sfUserId)) ?? [])] }));
}

/** In-person times, or none when drive times cannot be had at all (the office cannot be placed either): phone times still go. */
async function inPersonOrNone(input: Parameters<typeof inPersonSlots>[0], orgId: string, log: OfferLog): Promise<AppointmentSlot[]> {
  try {
    return await inPersonSlots(input);
  } catch (err) {
    if (!(err instanceof MapsUnavailableError)) throw err;
    log.warn({ orgId, code: err.code }, 'appointments: drive times unavailable; offering phone times only');
    return [];
  }
}

function priorityOffer(rep: OwnerUser, i: OfferInput): PriorityOffer {
  return { specialistSfUserId: rep.sfUserId, specialistFirstName: rep.firstName, timeZone: rep.timeZone, defaultStart: priorityDefaultStart(i.booking.days, i.now).toISOString() };
}

/**
 * What goes into the signed trigger must parse there: slots that do not are a bug here, and are dropped with their own note
 * (the priority offer does not depend on them). The offer's owner is the first slot's rep, else the priority rep.
 */
function settle(slots: AppointmentSlot[], priority: PriorityOffer | null, region: string): Offer {
  const valid = AppointmentSlots.safeParse(slots).success;
  const offered = valid ? slots : [];
  if (valid && offered.length === 0 && priority === null) return noOffer('no_free_time', region);
  const ownerSfUserId = offered[0]?.specialistSfUserId ?? priority?.specialistSfUserId ?? null;
  return { slots: offered, priority, region, ownerSfUserId, note: valid ? null : 'invalid_slots' };
}

/** Within the region: its reps, in-person times (a street address only) then phone times, and the high-priority offer (a street address only). */
async function regionOffer(deps: OfferDeps & { maps: MapsClient }, cal: ReadCalendars, i: OfferInput, p: { region: BookingRegion; geo: Geocoded; address: string }): Promise<Offer> {
  const reps = await regionReps(deps.db, cal, p.region, i);
  if (reps.length === 0) return noOffer('no_reps', p.region.key);
  const routing: RoutingInput = { region: p.region, reps, booking: i.booking, now: i.now };
  const street = usableAddress(p.address) !== null;
  const office: Place = { address: cal.routing.officeAddress };
  // One timer per offer: it counts this offer's route elements and stays on straight lines once Routes has failed.
  const drive = street ? driveTimer(deps.maps, office, deps.log) : null;
  const inPerson = drive ? await inPersonOrNone({ ...routing, property: { point: p.geo.point }, office, drive }, i.orgId, deps.log) : [];
  const priority = street && cal.priority ? priorityOffer(cal.priority, i) : null;
  const offer = settle([...inPerson, ...phoneSlots(routing)], priority, p.region.key);
  deps.log.info({ orgId: i.orgId, region: p.region.key, slots: offer.slots.length, priority: offer.priority !== null, routeElements: drive?.spent() ?? 0 }, 'appointments: routed offer');
  return offer;
}

async function compose(deps: OfferDeps, cal: OfferCalendars, i: OfferInput): Promise<Offer> {
  if (cal.kind === 'none') return noOffer(cal.note);
  if (i.consultations?.next) return noOffer('already_booked');
  const address = i.address?.trim() ? i.address : null;
  if (address === null) return noOffer('no_address');
  if (deps.maps === null) return noOffer('maps_unavailable');
  const geo = await locate(deps.maps, i.orgId, address, deps.log);
  if (typeof geo === 'string') return noOffer(geo);
  // Owner decision 2: high priority stays inside the regions too, so outside them there is no priority offer either.
  const region = regionFor(geo, cal.routing);
  if (region === null) return noOffer('outside_regions');
  return regionOffer({ ...deps, maps: deps.maps }, cal, i, { region, geo, address });
}

/** Never throws. */
export async function routedOffer(deps: OfferDeps, cal: OfferCalendars, i: OfferInput): Promise<Offer> {
  try {
    return await compose(deps, cal, i);
  } catch (err) {
    // Anything left (the AI-bookings read, a bug): no times rather than times that could double-book. Never the error text.
    deps.log.warn({ orgId: i.orgId, errName: errName(err) }, 'appointments: the offer failed; no times offered');
    return noOffer('salesforce_error');
  }
}

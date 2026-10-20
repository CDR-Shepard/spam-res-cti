/**
 * LEGACY single-owner offer, kept only so pace-context.ts and practice.ts (and the record tests through practice.ts) keep
 * building until Task 7 moves them to the routed offer (offer.ts, offer-for-record.ts) and deletes this file and its tests.
 *
 * The appointment owner's free time, phone first, then walkthrough. readOfferCalendar is the Salesforce part (the owner and
 * their busy calendar), read once per tenant per tick; offerFrom is pure and also takes out the times other AI calls have
 * booked with the owner that are not on the calendar yet (offerWithAiBookings, through booked.ts). Nothing here throws on a
 * Salesforce failure: it offers nothing, and the call still goes ahead.
 */
import { AppointmentSlots, type AiCallBookingSettings, type AppointmentSlot } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { bookingActive } from '../settings.js';
import { bookedNotOnCalendar } from './booked.js';
import { OFFER_CALENDAR_DAYS, readBusy, readUsers, type OwnerUser } from './calendar.js';
import type { OfferLog } from './offer.js';
import { appointmentOwner } from './owner.js';
import { freeWindows, pickOffered, toSlots, type Busy, type KindRules } from './slots.js';

export type LegacyOfferNote = 'booking_off' | 'no_owner' | 'no_free_time' | 'salesforce_error' | 'invalid_slots';

export interface LegacyOffer {
  slots: AppointmentSlot[];
  ownerSfUserId: string | null;
  note: LegacyOfferNote | null;
}

/** The Salesforce half of a legacy offer: the owner and their busy time from now until `until`, or why there is none. */
export type LegacyOfferCalendar =
  | { kind: 'read'; owner: OwnerUser; busy: readonly Busy[]; until: Date }
  | { kind: 'none'; note: 'booking_off' | 'no_owner' | 'salesforce_error' };

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const core = (id: string): string => id.slice(0, 15);

function kindSlots(kind: 'phone' | 'walkthrough', rules: KindRules, booking: AiCallBookingSettings, busy: readonly Busy[], now: Date, until: Date, owner: OwnerUser): AppointmentSlot[] {
  const read = freeWindows(rules, booking.days, busy, now, owner.timeZone).filter((w) => w.end.getTime() <= until.getTime());
  return toSlots(kind, pickOffered(read, rules.maxOffered, owner.timeZone), owner, rules.bufferMinutes * MIN_MS);
}

/** Reads Salesforce only; never throws. */
export async function readOfferCalendar(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date; log?: OfferLog }): Promise<LegacyOfferCalendar> {
  const { booking, now } = i;
  if (!bookingActive(booking)) return { kind: 'none', note: 'booking_off' };
  try {
    const owner = appointmentOwner(booking, await readUsers(client, booking.specialists));
    if (!owner) return { kind: 'none', note: 'no_owner' };
    const until = new Date(now.getTime() + OFFER_CALENDAR_DAYS * DAY_MS);
    const capped = (rows: number) => i.log?.warn({ ownerSfUserId: owner.sfUserId, rows }, 'appointments: the busy read hit its row cap; later busy time may be missing');
    return { kind: 'read', owner, busy: await readBusy(client, owner.sfUserId, now, until, owner.timeZone, capped), until };
  } catch {
    return { kind: 'none', note: 'salesforce_error' };
  }
}

/** Pure: the offer from a calendar read, less `booked` (times already booked with the owner, not on the calendar yet). */
export function offerFrom(cal: LegacyOfferCalendar, i: { booking: AiCallBookingSettings; now: Date; booked: readonly Busy[] }): LegacyOffer {
  if (cal.kind === 'none') return { slots: [], ownerSfUserId: null, note: cal.note };
  const { owner, until } = cal;
  const busy = [...cal.busy, ...i.booked];
  const slots = [
    ...kindSlots('phone', i.booking.phone, i.booking, busy, i.now, until, owner),
    ...kindSlots('walkthrough', i.booking.walkthrough, i.booking, busy, i.now, until, owner),
  ];
  if (slots.length === 0) return { slots: [], ownerSfUserId: owner.sfUserId, note: 'no_free_time' };
  // Defensive: what goes into the signed trigger must parse there. A failure is a bug here, not Salesforce's (M-6).
  if (!AppointmentSlots.safeParse(slots).success) return { slots: [], ownerSfUserId: owner.sfUserId, note: 'invalid_slots' };
  return { slots, ownerSfUserId: owner.sfUserId, note: null };
}

/** Both halves at once (one touch, nothing booked to take out unless given). */
export async function offerSlots(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date; booked?: readonly Busy[] }): Promise<LegacyOffer> {
  return offerFrom(await readOfferCalendar(client, i), { ...i, booked: i.booked ?? [] });
}

/** The offer from a calendar already read, less the times other AI calls booked with its owner that no Event shows yet (I-4). */
export async function offerWithAiBookings(db: Db, cal: LegacyOfferCalendar, i: { orgId: string; booking: AiCallBookingSettings; now: Date }): Promise<LegacyOffer> {
  if (cal.kind === 'none') return offerFrom(cal, { booking: i.booking, now: i.now, booked: [] });
  const owner = cal.owner.sfUserId;
  const booked = await bookedNotOnCalendar(db, { orgId: i.orgId, repSfUserIds: [owner], now: i.now, until: cal.until });
  return offerFrom(cal, { booking: i.booking, now: i.now, booked: booked.get(core(owner)) ?? [] });
}

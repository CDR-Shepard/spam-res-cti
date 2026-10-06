/**
 * The appointment times an AI call offers: the appointment owner's free time, phone first, then walkthrough. Computed at
 * trigger time (calendars change after a plan is approved). The offer does not depend on the record: the same owner and
 * calendar for every Lead and Opportunity. It only reads Salesforce, and it never throws: any failure offers nothing, and
 * the call still goes ahead. The caller logs the note, never record content.
 *
 * Two halves (Fix 1, M-1 and I-4): readOfferCalendar is the Salesforce part (the owner and their busy calendar), read once
 * per tenant per tick; offerFrom is pure and also takes out the times other AI calls have booked with the owner that are not
 * on the calendar yet (appointments/booked.ts), read per touch.
 */
import { AppointmentSlots, type AiCallBookingSettings, type AppointmentSlot } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { bookingActive } from '../settings.js';
import { readBusy, readUsers, type OwnerUser } from './calendar.js';
import { appointmentOwner } from './owner.js';
import { freeWindows, pickOffered, toSlots, type Busy, type KindRules } from './slots.js';

export type OfferNote = 'booking_off' | 'no_owner' | 'no_free_time' | 'salesforce_error' | 'invalid_slots';

export interface Offer {
  slots: AppointmentSlot[];
  ownerSfUserId: string | null;
  note: OfferNote | null;
}

/** The Salesforce half of an offer: the owner and their busy time from now until `until`, or why there is none. */
export type OfferCalendar =
  | { kind: 'read'; owner: OwnerUser; busy: readonly Busy[]; until: Date }
  | { kind: 'none'; note: 'booking_off' | 'no_owner' | 'salesforce_error' };

/** How far ahead the owner's calendar is read. Nothing later than this is ever offered. */
export const OFFER_CALENDAR_DAYS = 15;
const DAY_MS = 86_400_000;

function kindSlots(kind: 'phone' | 'walkthrough', rules: KindRules, booking: AiCallBookingSettings, busy: readonly Busy[], now: Date, until: Date, owner: OwnerUser): AppointmentSlot[] {
  const read = freeWindows(rules, booking.days, busy, now, owner.timeZone).filter((w) => w.end.getTime() <= until.getTime());
  return toSlots(kind, pickOffered(read, rules.maxOffered, owner.timeZone), owner);
}

/** Reads Salesforce only; never throws. */
export async function readOfferCalendar(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date }): Promise<OfferCalendar> {
  const { booking, now } = i;
  if (!bookingActive(booking)) return { kind: 'none', note: 'booking_off' };
  try {
    const owner = appointmentOwner(booking, await readUsers(client, booking.specialists));
    if (!owner) return { kind: 'none', note: 'no_owner' };
    const until = new Date(now.getTime() + OFFER_CALENDAR_DAYS * DAY_MS);
    return { kind: 'read', owner, busy: await readBusy(client, owner.sfUserId, now, until, owner.timeZone), until };
  } catch {
    return { kind: 'none', note: 'salesforce_error' };
  }
}

/** Pure: the offer from a calendar read, less `booked` (times already booked with the owner, not on the calendar yet). */
export function offerFrom(cal: OfferCalendar, i: { booking: AiCallBookingSettings; now: Date; booked: readonly Busy[] }): Offer {
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
export async function offerSlots(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date; booked?: readonly Busy[] }): Promise<Offer> {
  return offerFrom(await readOfferCalendar(client, i), { ...i, booked: i.booked ?? [] });
}

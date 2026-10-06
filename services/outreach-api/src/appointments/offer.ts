/**
 * The appointment times an AI call offers: the appointment owner's free time, phone first, then walkthrough. Computed at
 * trigger time (calendars change after a plan is approved). The offer does not depend on the record: the same owner and
 * calendar for every Lead and Opportunity. It only reads Salesforce, and it never throws: any failure offers nothing, and
 * the call still goes ahead. The caller logs the note, never record content.
 */
import { AppointmentSlots, type AiCallBookingSettings, type AppointmentSlot } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { bookingActive } from '../settings.js';
import { readBusy, readUsers, type OwnerUser } from './calendar.js';
import { appointmentOwner } from './owner.js';
import { freeWindows, pickOffered, toSlots, type Busy, type KindRules } from './slots.js';

export interface Offer {
  slots: AppointmentSlot[];
  ownerSfUserId: string | null;
  note: 'booking_off' | 'no_owner' | 'no_free_time' | 'salesforce_error' | null;
}

/** How far ahead the owner's calendar is read. Nothing later than this is ever offered. */
export const OFFER_CALENDAR_DAYS = 15;
const DAY_MS = 86_400_000;

function kindSlots(kind: 'phone' | 'walkthrough', rules: KindRules, booking: AiCallBookingSettings, busy: Busy[], now: Date, until: Date, owner: OwnerUser): AppointmentSlot[] {
  const read = freeWindows(rules, booking.days, busy, now, owner.timeZone).filter((w) => w.end.getTime() <= until.getTime());
  return toSlots(kind, pickOffered(read, rules.maxOffered, owner.timeZone), owner);
}

export async function offerSlots(client: SalesforceClient, i: { booking: AiCallBookingSettings; now: Date }): Promise<Offer> {
  const { booking, now } = i;
  if (!bookingActive(booking)) return { slots: [], ownerSfUserId: null, note: 'booking_off' };
  try {
    const owner = appointmentOwner(booking, await readUsers(client, booking.specialists));
    if (!owner) return { slots: [], ownerSfUserId: null, note: 'no_owner' };
    const until = new Date(now.getTime() + OFFER_CALENDAR_DAYS * DAY_MS);
    const busy = await readBusy(client, owner.sfUserId, now, until);
    const slots = [
      ...kindSlots('phone', booking.phone, booking, busy, now, until, owner),
      ...kindSlots('walkthrough', booking.walkthrough, booking, busy, now, until, owner),
    ];
    if (slots.length === 0) return { slots: [], ownerSfUserId: owner.sfUserId, note: 'no_free_time' };
    // Defensive: what goes into the signed trigger must parse there.
    if (!AppointmentSlots.safeParse(slots).success) return { slots: [], ownerSfUserId: null, note: 'salesforce_error' };
    return { slots, ownerSfUserId: owner.sfUserId, note: null };
  } catch {
    return { slots: [], ownerSfUserId: null, note: 'salesforce_error' };
  }
}

/**
 * Who owns what a Lead conversion creates (final review I3): the appointment owner, the first ACTIVE user on the booking
 * settings' `specialists` list (Grant Golden), who distributes appointments, as before rep routing. So: the conversion owner
 * (the new Opportunity, Account and Contact), the Lead Manager fallback, and the "convert it and book it" and "no Opportunity"
 * Tasks. The booked rep keeps the Event, the Lead hold and the conflict, drive and passed-time Tasks.
 *
 * With no active appointment owner, or when the User read fails, the booked rep owns these too: the write-back goes on. Logs
 * carry ids and errName only.
 */
import type { AiCallBookingSettings, BookedAppointment } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { readUsers } from '../appointments/calendar.js';
import { appointmentOwner } from '../appointments/owner.js';

export interface ConversionOwner {
  sfUserId: string;
  /** The appointment owner's Salesforce name; null when it is not known. */
  name: string | null;
  /** The booked rep was taken (no active appointment owner, or the read failed): their name is the rep's. */
  bookedRep: boolean;
}

export interface ConversionOwnerLog {
  warn(obj: unknown, msg?: string): void;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

export async function conversionOwner(
  client: SalesforceClient,
  i: { booking: AiCallBookingSettings; booked: BookedAppointment; log: ConversionOwnerLog; ids: Readonly<Record<string, string>> },
): Promise<ConversionOwner> {
  try {
    const owner = appointmentOwner(i.booking, await readUsers(client, i.booking.specialists));
    if (owner) return { sfUserId: owner.sfUserId, name: owner.name, bookedRep: false };
    i.log.warn({ ...i.ids }, 'ai_call.writeback: no active appointment owner; what the conversion creates goes to the booked rep');
  } catch (err) {
    i.log.warn({ ...i.ids, errName: errName(err) }, 'ai_call.writeback: the appointment owner read failed; what the conversion creates goes to the booked rep');
  }
  return { sfUserId: i.booked.specialistSfUserId, name: null, bookedRep: true };
}

/**
 * Who owns an AI-booked appointment. Decision 1: every AI-booked appointment goes to ONE person, the first ACTIVE user on the
 * ordered list (Grant Golden by default), who distributes them. No rotation, and no record-owner rule.
 */
import type { AiCallBookingSettings } from '@cti/contracts';
import type { OwnerUser } from './calendar.js';

/** Salesforce compares ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);

/** Decision 1: every AI-booked appointment goes to ONE person. The first ACTIVE user on the ordered list; no rotation, no record-owner rule. */
export function appointmentOwner(booking: AiCallBookingSettings, users: ReadonlyMap<string, OwnerUser>): OwnerUser | null {
  const all = [...users.values()];
  for (const id of booking.specialists) {
    const u = all.find((x) => core(x.sfUserId) === core(id));
    if (u?.isActive) return u;
  }
  return null;
}

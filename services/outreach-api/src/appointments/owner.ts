/**
 * The appointment owner: the first ACTIVE user on the ordered `specialists` list (Grant Golden by default). Since rep routing
 * they take every high-priority booking and own what a Lead conversion creates (they distribute appointments); every other
 * booking goes to its region's reps. No rotation, and no record-owner rule.
 */
import type { AiCallBookingSettings } from '@cti/contracts';
import type { OwnerUser } from './calendar.js';

/** Salesforce compares ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);

/** The first ACTIVE user on the ordered list, or null; no rotation, no record-owner rule. */
export function appointmentOwner(booking: AiCallBookingSettings, users: ReadonlyMap<string, OwnerUser>): OwnerUser | null {
  const all = [...users.values()];
  for (const id of booking.specialists) {
    const u = all.find((x) => core(x.sfUserId) === core(id));
    if (u?.isActive) return u;
  }
  return null;
}

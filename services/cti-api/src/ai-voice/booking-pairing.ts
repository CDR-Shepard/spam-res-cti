/**
 * The high-priority pairing BookedAppointment leaves to cti-api (routing step 1): slot h1 is always `priority: true`, and
 * nothing else is. Both stores check it before they write, so only a high-priority booking can skip the D-10 conflict
 * check (store-booking.ts, and the fake in testing.ts). Pure: no database.
 */
import { PRIORITY_SLOT_ID, type BookedAppointment } from '@cti/contracts';

export function checkPriorityPairing(a: BookedAppointment): void {
  if ((a.priority === true) !== (a.slotId === PRIORITY_SLOT_ID)) throw new RangeError('a high-priority booking is slot h1, and only it');
}

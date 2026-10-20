/**
 * Task 8: the write-time re-check of an Opportunity booking's calendar (D-11), by how the booking was made.
 * - High priority: none. Grant takes it whatever his calendar says, so nothing is read.
 * - Routed (it has a region): nothing on the rep's Pacific day overlaps it (no buffer: the drive check replaces it); then,
 *   for a visit with an address while Google is configured, both drives must still fit, with DRIVE_SLACK_MINUTES each. A
 *   drive check that fails (Google down, an office it cannot place, anything else) leaves the overlap check's answer.
 * - Booked before routing (no region): today's check, the walkthrough buffer included.
 * Addresses and Event Locations are seller data: only ids and error codes are logged.
 */
import { ROUTING_ZONE, type BookedAppointment } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { DEFAULT_OWNER_TIME_ZONE, readBusy } from '../appointments/calendar.js';
import { driveTimer } from '../appointments/drive.js';
import { MapsUnavailableError, type MapsClient, type Place } from '../appointments/maps.js';
import { repCanReach } from '../appointments/routing.js';
import { conflicts, type Busy, type Window } from '../appointments/slots.js';
import { addLocalDays, zonedInstant } from '../appointments/zoned.js';

/** The calendar no longer takes the booking; `drive`: nothing overlaps, but the rep can no longer drive there in time. */
export interface CalendarConflict {
  kind: 'conflict';
  reason?: 'drive';
}
export interface RecheckLog {
  warn(o: Record<string, unknown>, m: string): void;
}
export interface RecheckInput {
  /** For the logs only. */
  oppId: string;
  aiCallId: string;
  /** The booked rep's Salesforce id, already checked. */
  owner: string;
  booked: BookedAppointment;
  /** The Event's Location (the property's address), or null when it has none. */
  location: string | null;
  /** The walkthrough buffer of a booking made before routing. */
  bufferMinutes: number;
  ownerTimeZone?: string;
  maps: MapsClient | null;
  officeAddress: string;
  log: RecheckLog;
}

/** Each drive may run this much past the time it must arrive by (plan decision 7). */
export const DRIVE_SLACK_MINUTES = 15;
const MIN_MS = 60_000;

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Local midnight `days` after `at`'s Pacific day. */
function ptMidnight(at: Date, days: number): Date {
  const d = addLocalDays(at, days, ROUTING_ZONE);
  return zonedInstant(ROUTING_ZONE, d.year, d.month, d.day, 0, 0);
}

/** Booked before routing: the owner's calendar around the slot, a walkthrough's buffer included (D-11). */
async function bufferedCheck(client: SalesforceClient, i: RecheckInput, w: Window): Promise<CalendarConflict | null> {
  const bufferMs = i.booked.kind === 'walkthrough' ? i.bufferMinutes * MIN_MS : 0;
  const zone = i.ownerTimeZone ?? DEFAULT_OWNER_TIME_ZONE;
  const busy = await readBusy(client, i.owner, new Date(w.start.getTime() - bufferMs), new Date(w.end.getTime() + bufferMs), zone);
  return conflicts(w, busy, zone, bufferMs) ? { kind: 'conflict' } : null;
}

/**
 * The drive conflict: the rep can no longer make both drives; null when they can, or when the check itself fails (logged).
 * A fresh timer per booking: one whose Routes failed stays on straight lines for its life.
 */
async function driveConflict(i: RecheckInput & { maps: MapsClient; location: string }, busy: readonly Busy[], start: Date): Promise<CalendarConflict | null> {
  const office: Place = { address: i.officeAddress };
  try {
    const reaches = await repCanReach({ busy, start, slackMinutes: DRIVE_SLACK_MINUTES, property: { address: i.location }, office, drive: driveTimer(i.maps, office, i.log) });
    return reaches ? null : { kind: 'conflict', reason: 'drive' };
  } catch (err) {
    const code = err instanceof MapsUnavailableError ? { code: err.code } : {};
    i.log.warn({ aiCallId: i.aiCallId, oppId: i.oppId, errName: errName(err), ...code }, 'ai_call.writeback: the drive re-check failed; the overlap check stands');
    return null;
  }
}

/** A routed booking: one read of the rep's Pacific day, for the overlap check and then the drive check. */
async function routedCheck(client: SalesforceClient, i: RecheckInput, w: Window): Promise<CalendarConflict | null> {
  // To the end of the day, or of the booking should it run past midnight.
  const to = new Date(Math.max(ptMidnight(w.start, 1).getTime(), w.end.getTime()));
  const busy = await readBusy(client, i.owner, ptMidnight(w.start, 0), to, ROUTING_ZONE);
  if (conflicts(w, busy, ROUTING_ZONE, 0)) return { kind: 'conflict' };
  const { maps, location } = i;
  if (maps === null || location === null) return null;
  return driveConflict({ ...i, maps, location }, busy, w.start);
}

/** Null when the booking still stands; else why it does not. */
export async function recheckCalendar(client: SalesforceClient, i: RecheckInput): Promise<CalendarConflict | null> {
  if (i.booked.priority === true) return null;
  const w: Window = { start: new Date(i.booked.start), end: new Date(i.booked.end) };
  return i.booked.region === undefined ? bufferedCheck(client, i, w) : routedCheck(client, i, w);
}

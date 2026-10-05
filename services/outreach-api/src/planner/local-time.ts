/**
 * Recipient-local wall-clock helpers for the touch planner.
 *
 * Calls and texts use `nextWindowOpening` from `@cti/firewall` (it knows the
 * state overlays). These helpers cover what that function does not: the start
 * of the recipient's local day (for "one touch per person per day") and the
 * email schedule for a person with no phone number at all, where there is no
 * number to resolve a timezone from.
 */
import { timezoneForNumber, type LocalWindow } from '@cti/firewall';

/** Central US: the dialer's own approximation for a recipient with no resolvable zone. */
export const FALLBACK_TIMEZONE = 'America/Chicago';
const MINUTE_MS = 60_000;
const STEP_MS = 15 * MINUTE_MS;
const MAX_LOOKAHEAD_MS = 8 * 24 * 60 * MINUTE_MS;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function localParts(at: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const hour = get('hour');
  // Some ICU builds render midnight as "24".
  return { year: get('year'), month: get('month'), day: get('day'), hour: hour === 24 ? 0 : hour, minute: get('minute') };
}

/** Minutes `timezone` is ahead of UTC at `at` (negative west of Greenwich). */
function offsetMinutes(at: Date, timezone: string): number {
  const p = localParts(at, timezone);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  const atMinute = Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
  return Math.round((wallAsUtc - atMinute) / MINUTE_MS);
}

/** The UTC instant of local midnight that starts calendar day (year, month, day) in `timezone`. */
function zonedMidnight(year: number, month: number, day: number, timezone: string): Date {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetMinutes(new Date(wall), timezone) * MINUTE_MS;
  // Second pass corrects a guess that landed on the other side of a DST change.
  return new Date(wall - offsetMinutes(new Date(first), timezone) * MINUTE_MS);
}

/** The recipient's timezone from the number's area code, or Chicago. */
export function recipientTimezone(e164: string | null): string {
  const resolved = e164 ? timezoneForNumber(e164) : null;
  return resolved?.timezone ?? FALLBACK_TIMEZONE;
}

/** Local midnight that starts the day containing `at`. */
export function localDayStart(at: Date, timezone: string): Date {
  const p = localParts(at, timezone);
  return zonedMidnight(p.year, p.month, p.day, timezone);
}

/** Local midnight that starts the day after the one containing `at`. */
export function nextLocalDayStart(at: Date, timezone: string): Date {
  const p = localParts(at, timezone);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone);
}

export function withinLocalWindow(at: Date, timezone: string, window: LocalWindow): boolean {
  const p = localParts(at, timezone);
  const hhmm = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  return hhmm >= window.start && hhmm < window.endExclusive;
}

/**
 * First instant at or after `start` inside `window` in `timezone`, searched in
 * 15-minute steps for up to 8 days (the same contract as the firewall's
 * `nextWindowOpening`, without a state overlay — used only for email to a
 * person with no phone number).
 */
export function nextLocalOpening(start: Date, timezone: string, window: LocalWindow): Date {
  const steps = MAX_LOOKAHEAD_MS / STEP_MS;
  for (let i = 0; i <= steps; i += 1) {
    const candidate = new Date(start.getTime() + i * STEP_MS);
    if (withinLocalWindow(candidate, timezone, window)) return candidate;
  }
  return new Date(start.getTime() + MAX_LOOKAHEAD_MS);
}

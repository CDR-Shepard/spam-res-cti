/**
 * The person's own clock on an AI call. The agent is told their local date and time ("Monday, October 5, 2026,
 * 11:00 AM") so it can name a day and turn it into an exact time; schedule_callback's `at` comes back as their local
 * "YYYY-MM-DDTHH:MM", read here in the same zone. The zone is the area code's, as the dialer's calling hours derive it.
 */
import { timezoneForNumber } from '@cti/firewall';

/** For a number with no mapped area code (or a browser test client). */
export const FALLBACK_TIME_ZONE = 'America/Chicago';
/** How far ahead a callback may be: "check back next year" fits, a mistyped year does not. */
export const CALLBACK_MAX_AHEAD_MS = 2 * 366 * 24 * 60 * 60 * 1000;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** One formatter per (zone, kind), reused: a formatter is immutable once built. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(kind: 'day' | 'time' | 'wall', timeZone: string): Intl.DateTimeFormat {
  const key = `${kind}:${timeZone}`;
  const hit = formatters.get(key);
  if (hit) return hit;
  const options: Intl.DateTimeFormatOptions =
    kind === 'day'
      ? { timeZone, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
      : kind === 'time'
        ? { timeZone, hour: 'numeric', minute: '2-digit' }
        : { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const made = new Intl.DateTimeFormat(kind === 'wall' ? 'en-CA' : 'en-US', options);
  formatters.set(key, made);
  return made;
}

export function recipientTimeZone(e164: string): string {
  return timezoneForNumber(e164)?.timezone ?? FALLBACK_TIME_ZONE;
}

/** "Monday, October 5, 2026, 11:00 AM" in the recipient's zone. */
export function localTimeFor(e164: string, now: Date): string {
  const timeZone = recipientTimeZone(e164);
  return `${formatter('day', timeZone).format(now)}, ${formatter('time', timeZone).format(now)}`;
}

/** `d`'s wall clock in `timeZone`, as if that wall clock were UTC (ms). */
function wallMs(d: Date, timeZone: string): number {
  const parts = Object.fromEntries(formatter('wall', timeZone).formatToParts(d).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

/**
 * A local "YYYY-MM-DDTHH:MM" in `timeZone` as an instant, using that day's offset (DST-proof without a library); null
 * when it is not that shape, not a real date and time, or a time the clocks skip.
 */
export function wallTimeToDate(local: string, timeZone: string): Date | null {
  const m = LOCAL_DATE_TIME.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(asUtc);
  if (h > 23 || mi > 59 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  // Two passes: the offset at the first guess can differ from the offset at the answer near a DST change.
  let at = asUtc - (wallMs(check, timeZone) - asUtc);
  at = asUtc - (wallMs(new Date(at), timeZone) - at);
  return wallMs(new Date(at), timeZone) === asUtc ? new Date(at) : null;
}

/**
 * The agreed callback time, or null when it is unusable: not a local date and time, a day before their today (a
 * guessed year lands here), or further ahead than CALLBACK_MAX_AHEAD_MS.
 */
export function callbackAtFromLocal(local: string, timeZone: string, now: Date): Date | null {
  const at = wallTimeToDate(local, timeZone);
  if (!at) return null;
  const today = new Date(wallMs(now, timeZone)).toISOString().slice(0, 10);
  if (local.slice(0, 10) < today || at.getTime() - now.getTime() > CALLBACK_MAX_AHEAD_MS) return null;
  return at;
}

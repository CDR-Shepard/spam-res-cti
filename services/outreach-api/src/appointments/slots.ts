/**
 * Busy time and the shared calendar rules (pure). Busy items are a rep's Salesforce Events (and the AI bookings no Event shows
 * yet). `conflicts` is the one overlap rule: a window's buffered interval meets no timed busy item (intervals that only touch
 * do not overlap), and no all-day item falls on a local day the window touches. The routing engine and the write-time
 * re-check of a booking both use it. `horizonDays` gives the booking days a kind's horizon counts.
 */
import type { AiCallBookingSettings } from '@cti/contracts';
import { addLocalDays, zonedParts, type LocalDay } from './zoned.js';

export interface Busy {
  start: Date;
  end: Date;
  /** all-day: blocks the whole local `day` (y-m-d) */
  allDay: boolean;
  day?: LocalDay;
  /** The Event's Location as Salesforce has it. Seller data: never logged. */
  location?: string | null;
  /** Its Subject contains "consultation" (case-insensitive). The Subject itself is not kept. */
  consultation?: boolean;
}
export type KindRules = AiCallBookingSettings['phone'];
export interface Window {
  start: Date;
  end: Date;
}

/** Enough to find 10 business days with a single weekday configured, and never loop forever. */
const MAX_DAYS_SCANNED = 80;

const dayKey = (d: LocalDay): string => `${d.year}-${d.month}-${d.day}`;

/** The first `count` local days, from today, whose ISO weekday is in `days`. */
export function horizonDays(count: number, days: readonly number[], now: Date, timeZone: string): LocalDay[] {
  const out: LocalDay[] = [];
  for (let i = 0; i < MAX_DAYS_SCANNED && out.length < count; i += 1) {
    const d = addLocalDays(now, i, timeZone);
    const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() || 7;
    if (days.includes(weekday)) out.push(d);
  }
  return out;
}

const overlaps = (aStart: number, aEnd: number, b: Busy): boolean => b.start.getTime() < aEnd && b.end.getTime() > aStart;

/** The local days (keys) a window touches, from its start's day to the day of its last instant. */
function windowDays(w: Window, timeZone: string): Set<string> {
  const lastKey = dayKey(zonedParts(new Date(Math.max(w.start.getTime(), w.end.getTime() - 1)), timeZone));
  const out = new Set<string>();
  for (let i = 0; i < MAX_DAYS_SCANNED; i += 1) {
    const key = dayKey(addLocalDays(w.start, i, timeZone));
    out.add(key);
    if (key === lastKey) break;
  }
  return out;
}

/**
 * Whether a window meets busy time: a timed item overlaps the window widened by `bufferMs` on both sides (touching is
 * free), or an all-day item's local day is one the window touches (all-day items are never widened by the buffer).
 */
export function conflicts(w: Window, busy: readonly Busy[], timeZone: string, bufferMs: number): boolean {
  const from = w.start.getTime() - bufferMs;
  const to = w.end.getTime() + bufferMs;
  let days: Set<string> | null = null;
  return busy.some((b) => {
    if (!(b.allDay && b.day)) return overlaps(from, to, b);
    days ??= windowDays(w, timeZone);
    return days.has(dayKey(b.day));
  });
}

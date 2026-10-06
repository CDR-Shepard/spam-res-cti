/**
 * Free appointment times (pure). Business hours are wall-clock times in the specialist's zone; busy time is the appointment
 * owner's Salesforce Events. A candidate start is kept when it is far enough ahead (lead time) and `conflicts` finds nothing:
 * its buffered interval meets no timed busy item (intervals that only touch do not overlap), and no all-day item falls on a
 * local day the window touches. `conflicts` is the one rule: the write-time re-check of a booking uses it too.
 */
import type { AiCallBookingSettings, AppointmentKind, AppointmentSlot } from '@cti/contracts';
import { addLocalDays, zonedInstant, zonedParts, type LocalDay } from './zoned.js';

export interface Busy {
  start: Date;
  end: Date;
  /** all-day: blocks the whole local `day` (y-m-d) */
  allDay: boolean;
  day?: LocalDay;
}
export type KindRules = AiCallBookingSettings['phone'];
export interface Window {
  start: Date;
  end: Date;
}

const MIN = 60_000;
/** Contract ids are p1..p9 / w1..w9. */
const MAX_IDS_PER_KIND = 9;
/** Enough to find 10 business days with a single weekday configured, and never loop forever. */
const MAX_DAYS_SCANNED = 80;

const dayKey = (d: LocalDay): string => `${d.year}-${d.month}-${d.day}`;

/** The first `count` local days, from today, whose ISO weekday is in `days`. */
function horizonDays(count: number, days: readonly number[], now: Date, timeZone: string): LocalDay[] {
  const out: LocalDay[] = [];
  for (let i = 0; i < MAX_DAYS_SCANNED && out.length < count; i += 1) {
    const d = addLocalDays(now, i, timeZone);
    const weekday = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() || 7;
    if (days.includes(weekday)) out.push(d);
  }
  return out;
}

/** Candidate starts on one day: startHour:00, then every stepMinutes, while start + duration ≤ endHour:00. */
function candidates(rules: KindRules, day: LocalDay, timeZone: string): Window[] {
  const out: Window[] = [];
  for (let m = rules.startHour * 60; m + rules.durationMinutes <= rules.endHour * 60; m += rules.stepMinutes) {
    const start = zonedInstant(timeZone, day.year, day.month, day.day, Math.floor(m / 60), m % 60);
    out.push({ start, end: new Date(start.getTime() + rules.durationMinutes * MIN) });
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

/** Every free start for one kind, ascending. */
export function freeWindows(rules: KindRules, days: readonly number[], busy: readonly Busy[], now: Date, timeZone: string): Window[] {
  if (!rules.enabled) return [];
  const earliest = now.getTime() + rules.minLeadMinutes * MIN;
  const buffer = rules.bufferMinutes * MIN;
  return horizonDays(rules.horizonBusinessDays, days, now, timeZone)
    .flatMap((day) => candidates(rules, day, timeZone))
    .filter((w) => w.start.getTime() >= earliest)
    .filter((w) => !conflicts(w, busy, timeZone, buffer));
}

/** At most `max`, at most 2 per local day: per day the first morning (< 12:00) and the first afternoon window, else the first two. */
export function pickOffered(windows: readonly Window[], max: number, timeZone: string): Window[] {
  const byDay = new Map<string, Array<{ w: Window; morning: boolean }>>();
  for (const w of [...windows].sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const p = zonedParts(w.start, timeZone);
    const key = dayKey(p);
    byDay.set(key, [...(byDay.get(key) ?? []), { w, morning: p.hour < 12 }]);
  }
  const perDay = [...byDay.values()].flatMap((day) => {
    const morning = day.find((x) => x.morning);
    const afternoon = day.find((x) => !x.morning);
    return morning && afternoon ? [morning.w, afternoon.w] : day.slice(0, 2).map((x) => x.w);
  });
  return perDay.slice(0, Math.max(0, max));
}

/**
 * The slots for picked windows. `bufferMs` is the kind's own buffer, the one `conflicts` widened the window by (Part 4
 * Fix 1, I-3): when it is set, each slot carries the time it blocks, [start − buffer, end + buffer), so cti-api's booking
 * check and the next offer keep the travel time around a booked walkthrough free. A kind with no buffer (the phone call by
 * default) carries no block.
 */
export function toSlots(
  kind: AppointmentKind,
  picked: readonly Window[],
  specialist: { sfUserId: string; firstName: string | null; timeZone: string },
  bufferMs = 0,
): AppointmentSlot[] {
  const prefix = kind === 'phone' ? 'p' : 'w';
  return picked.slice(0, MAX_IDS_PER_KIND).map((w, i) => ({
    id: `${prefix}${i + 1}`,
    kind,
    start: w.start.toISOString(),
    end: w.end.toISOString(),
    specialistSfUserId: specialist.sfUserId,
    specialistFirstName: specialist.firstName,
    timeZone: specialist.timeZone,
    ...(bufferMs > 0
      ? { blockStart: new Date(w.start.getTime() - bufferMs).toISOString(), blockEnd: new Date(w.end.getTime() + bufferMs).toISOString() }
      : {}),
  }));
}

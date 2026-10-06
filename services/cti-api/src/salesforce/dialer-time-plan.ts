/**
 * Which (rep, Pacific day) "Power Dialer Time" Tasks need a Salesforce write
 * this tick. PURE. The number is exactly the admin Talk time report's "On
 * dialer": dialerSecondsByUserDay — the line open AND something happened in the
 * last 15 minutes (a dial, or a conversation), legs merged per rep (overlaps
 * once), split at Pacific midnight, an open leg counted up to `now`.
 */
import type { DialerTimeTask } from '@cti/db';
import { orgTodayIso } from '../dialer/org-day.js';
import { addDays, dialerSecondsByUserDay, type ActivitySpan, type LegSpan } from '../reports/talk-time.js';

/** Today and the thirteen days before — two weeks: the idle-cutoff deploy
 *  rewrites every day since the feature began, and a write that keeps failing
 *  (a rep must reconnect Salesforce) keeps converging for two weeks. A leg
 *  crossing midnight, closing late or reconciled up to 48 h later also still
 *  lands on the right day's Task. */
export const DIALER_TIME_WINDOW_DAYS = 14;

const MIN = 60_000;
export const BACKOFF_MS = [5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN] as const;

export interface WindowLeg extends LegSpan {
  orgId: string;
}

export type SyncedRow = Pick<DialerTimeTask, 'id' | 'orgId' | 'userId' | 'day' | 'salesforceTaskId' | 'syncedSeconds' | 'attempts' | 'nextAttemptAt'>;

export interface PlannedWrite {
  orgId: string;
  userId: string;
  day: string;
  seconds: number;
  row: SyncedRow | null;
}

export function windowDays(now: Date): string[] {
  const today = orgTodayIso(now);
  return Array.from({ length: DIALER_TIME_WINDOW_DAYS }, (_, i) => addDays(today, i - (DIALER_TIME_WINDOW_DAYS - 1)));
}

/** Never gives up: past the list, every retry waits the last step. */
export function backoffMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]!;
}

/** Due, or no row to be due yet (a fresh create is always due). */
function isDue(row: SyncedRow | null, now: Date): boolean {
  return !row || row.nextAttemptAt.getTime() <= now.getTime();
}

/** A day that was synced with real seconds must converge back to 0 when the
 *  computed number drops to 0 (final review I2 — the reconciler's 48 h
 *  fallback can do this; so does the idle cutoff, for a day synced under the
 *  old line-open number). Never a CREATE for 0: only a row that already has a
 *  Task is corrected. Uses the row's own orgId, not the legs-derived map,
 *  because a rep with no counted time left in the window at all has no entry
 *  there. */
function zeroCorrection(row: SyncedRow, now: Date): PlannedWrite | null {
  if (!row.salesforceTaskId) return null;
  if ((row.syncedSeconds ?? 0) <= 0) return null;
  if (!isDue(row, now)) return null;
  return { orgId: row.orgId, userId: row.userId, day: row.day, seconds: 0, row };
}

export function planDialerTimeWrites(input: {
  legs: readonly WindowLeg[];
  activity: readonly ActivitySpan[];
  days: readonly string[];
  now: Date;
  rows: readonly SyncedRow[];
}): PlannedWrite[] {
  const { legs, activity, days, now, rows } = input;
  const orgOf = new Map(legs.map((l) => [l.userId, l.orgId]));
  const rowOf = new Map(rows.map((r) => [`${r.userId}|${r.day}`, r]));
  const seconds = dialerSecondsByUserDay(legs, activity, days, now);
  const planned: PlannedWrite[] = [];
  // Every (userId, day) visited by the main loop below, so the no-time-left
  // sweep after it never double-plans a pair dialerSecondsByUserDay did see.
  const seen = new Set<string>();

  for (const [userId, byDay] of Object.entries(seconds)) {
    for (const day of days) {
      const key = `${userId}|${day}`;
      seen.add(key);
      const s = byDay[day] ?? 0;
      const row = rowOf.get(key) ?? null;
      if (s <= 0) {
        const correction = row && zeroCorrection(row, now);
        if (correction) planned.push(correction);
        continue;
      }
      if (row && row.syncedSeconds === s) continue;
      if (!isDue(row, now)) continue;
      planned.push({ orgId: orgOf.get(userId)!, userId, day, seconds: s, row });
    }
  }

  // Reps with NO counted time left anywhere in the window — no legs, or legs
  // with nothing active in them — are absent from `seconds` entirely
  // (dialerSecondsByUserDay drops users with no day > 0), so a rep whose
  // dialing was entirely reconciled away or idle still needs their synced rows
  // walked and corrected to 0 — iterate the rows themselves, not just the
  // reps the legs mention.
  for (const row of rows) {
    if (seen.has(`${row.userId}|${row.day}`)) continue;
    const correction = zeroCorrection(row, now);
    if (correction) planned.push(correction);
  }

  return planned;
}

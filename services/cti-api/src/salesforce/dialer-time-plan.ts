/**
 * Which (rep, Pacific day) "Power Dialer Time" Tasks need a Salesforce write
 * this tick. PURE. The number is exactly the admin Talk time report's "On
 * dialer": dialerSecondsByUserDay — legs merged per rep (overlaps once), split
 * at Pacific midnight, an open leg counted up to `now`.
 */
import type { DialerTimeTask } from '@cti/db';
import { orgTodayIso } from '../dialer/org-day.js';
import { addDays, dialerSecondsByUserDay, type LegSpan } from '../reports/talk-time.js';

/** Today and the two days before: a leg crossing midnight, closing late or
 *  reconciled up to 48 h later still lands on the right day's Task. */
export const DIALER_TIME_WINDOW_DAYS = 3;

const MIN = 60_000;
export const BACKOFF_MS = [5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN] as const;

export interface WindowLeg extends LegSpan {
  orgId: string;
}

export type SyncedRow = Pick<DialerTimeTask, 'id' | 'userId' | 'day' | 'salesforceTaskId' | 'syncedSeconds' | 'attempts' | 'nextAttemptAt'>;

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

export function planDialerTimeWrites(input: {
  legs: readonly WindowLeg[];
  days: readonly string[];
  now: Date;
  rows: readonly SyncedRow[];
}): PlannedWrite[] {
  const { legs, days, now, rows } = input;
  const orgOf = new Map(legs.map((l) => [l.userId, l.orgId]));
  const rowOf = new Map(rows.map((r) => [`${r.userId}|${r.day}`, r]));
  const seconds = dialerSecondsByUserDay(legs, days, now);
  const planned: PlannedWrite[] = [];
  for (const [userId, byDay] of Object.entries(seconds)) {
    for (const day of days) {
      const s = byDay[day] ?? 0;
      if (s <= 0) continue;
      const row = rowOf.get(`${userId}|${day}`) ?? null;
      if (row && row.syncedSeconds === s) continue;
      if (row && row.nextAttemptAt.getTime() > now.getTime()) continue;
      planned.push({ orgId: orgOf.get(userId)!, userId, day, seconds: s, row });
    }
  }
  return planned;
}

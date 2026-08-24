import { schema } from '../db/index.js';

export type DialerItem = typeof schema.dialerQueueItems.$inferSelect;

export function sessionCounts(items: Array<Pick<DialerItem, 'status'>>): {
  total: number; done: number; connected: number; noConnect: number;
  skipped: number; unreachable: number; pending: number;
} {
  const c = { total: items.length, done: 0, connected: 0, noConnect: 0, skipped: 0, unreachable: 0, pending: 0 };
  for (const it of items) {
    if (it.status === 'done') c.done++;
    else if (it.status === 'connected') c.connected++;
    else if (it.status === 'no_connect') c.noConnect++;
    else if (it.status === 'skipped') c.skipped++;
    else if (it.status === 'unreachable') c.unreachable++;
    else if (it.status === 'pending') c.pending++;
  }
  return c;
}

/** Per-outcome tally of skipped rows only — what a rep inherited when the run
 *  started (already worked today, flagged skip, out of hours, etc). Non-skipped
 *  rows are ignored; a null/unrecognized outcome on a skipped row counts as
 *  'other' so the total always matches `sessionCounts(items).skipped`. */
export function skipBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const it of items) {
    if (it.status !== 'skipped') continue;
    const key = it.outcome ?? 'other';
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

/** Run-summary counts from a session's rollover jobs. The rollover worker
 *  stamps `nextDay` (the plain next business day) when it creates the copy,
 *  so "moved" (landed there) vs "pushed" (the daily cap sent it later) is a
 *  pure string compare here — no Salesforce call on the softphone's poll. */
export function rolloverSummary(
  jobs: Array<{ status: string; targetDate: string | null; nextDay: string | null }>,
): { moved: number; pushed: number; failed: number; pending: number } {
  const s = { moved: 0, pushed: 0, failed: 0, pending: 0 };
  for (const j of jobs) {
    if (j.status === 'failed') s.failed++;
    else if (j.status === 'pending' || j.status === 'in_flight') s.pending++;
    else if (j.status === 'succeeded' && j.targetDate) {
      if (j.targetDate === j.nextDay) s.moved++; else s.pushed++;
    }
  }
  return s;
}

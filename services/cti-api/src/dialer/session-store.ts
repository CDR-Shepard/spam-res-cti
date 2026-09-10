import { schema } from '@cti/db';

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

/** Per-outcome tally of the rows in one status. A null/unrecognized outcome
 *  counts as 'other' so the tally's total always matches that status's count
 *  in `sessionCounts(items)`. */
function tallyOutcomes(
  items: Array<Pick<DialerItem, 'status' | 'outcome'>>,
  status: DialerItem['status'],
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const it of items) {
    if (it.status !== status) continue;
    const key = it.outcome ?? 'other';
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}

/** Per-outcome tally of skipped rows only — what a rep inherited when the run
 *  started (already worked today, flagged skip, consent-blocked, etc). */
export function skipBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number> {
  return tallyOutcomes(items, 'skipped');
}

/** Per-reason tally of no_connect rows — what the run's misses actually were
 *  (voicemail, no_answer, busy, failed, …; see dialer/outcome.ts). Attempt-2
 *  retries that miss again count as their own row, like every other miss. */
export function missBreakdown(items: Array<Pick<DialerItem, 'status' | 'outcome'>>): Record<string, number> {
  return tallyOutcomes(items, 'no_connect');
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

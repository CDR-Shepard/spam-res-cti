import type { DialerItem } from './session-store.js';

export function inFlightItem(items: DialerItem[]): DialerItem | null {
  return items.find((i) => i.status === 'dialing' || i.status === 'connected') ?? null;
}

export function nextPendingItem(items: DialerItem[]): DialerItem | null {
  const pending = items.filter((i) => i.status === 'pending');
  if (pending.length === 0) return null;
  return pending.reduce((a, b) => (a.ordinal <= b.ordinal ? a : b));
}

export function outcomeToStatus(outcome: 'connected' | 'no_connect'): 'connected' | 'no_connect' {
  return outcome;
}

export function allTerminal(items: DialerItem[]): boolean {
  return !items.some((i) => i.status === 'pending' || i.status === 'dialing' || i.status === 'connected');
}

/** Attempt-2 rows are not dialable until this long after attempt 1 ended. Keeps a
 *  2-record list from ringing the same person twice in 30 seconds. */
export const RETRY_FLOOR_MS = 5 * 60_000;

function floorPassed(i: DialerItem, now: Date): boolean {
  return i.retryNotBefore == null || i.retryNotBefore.getTime() <= now.getTime();
}

/** Lowest-ordinal pending row that is past its retry floor (or has none). */
export function nextEligiblePendingItem(items: DialerItem[], now: Date): DialerItem | null {
  const eligible = items.filter((i) => i.status === 'pending' && floorPassed(i, now));
  if (eligible.length === 0) return null;
  return eligible.reduce((a, b) => (a.ordinal <= b.ordinal ? a : b));
}

/** Soonest future retry floor among pending rows — when the run can advance again. */
export function earliestRetryAt(items: DialerItem[], now: Date): Date | null {
  let best: Date | null = null;
  for (const i of items) {
    if (i.status !== 'pending' || i.retryNotBefore == null) continue;
    if (i.retryNotBefore.getTime() <= now.getTime()) continue;
    if (!best || i.retryNotBefore.getTime() < best.getTime()) best = i.retryNotBefore;
  }
  return best;
}

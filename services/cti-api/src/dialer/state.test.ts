import { describe, expect, it } from 'vitest';
import { earliestRetryAt, inFlightItem, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
import type { DialerItem } from './session-store.js';

const now = new Date('2026-08-22T17:00:00Z');
const row = (o: Partial<DialerItem>): DialerItem =>
  ({ id: 'x', ordinal: 0, status: 'pending', retryNotBefore: null, attempt: 1, ...o }) as DialerItem;

describe('inFlightItem', () => {
  // Load-bearing well beyond advanceSession now: the abandoned-run reaper
  // (salesforce/followup-worker.ts expireAbandonedSessions) uses it to decide
  // whether a stale-looking run is actually a rep mid-conversation.
  it('is the dialing row when one is ringing', () => {
    const r = inFlightItem([row({ id: 'a', status: 'no_connect' }), row({ id: 'b', status: 'dialing' })]);
    expect(r?.id).toBe('b');
  });
  it('is the connected row when the rep is on the call', () => {
    expect(inFlightItem([row({ id: 'c', status: 'connected' })])?.id).toBe('c');
  });
  it('is null when every row is pending or terminal', () => {
    expect(inFlightItem([row({ status: 'pending' }), row({ status: 'done' }), row({ status: 'skipped' })])).toBeNull();
    expect(inFlightItem([])).toBeNull();
  });
});

describe('nextEligiblePendingItem', () => {
  it('is the lowest-ordinal pending row when nothing is floor-gated', () => {
    const r = nextEligiblePendingItem([row({ id: 'b', ordinal: 2 }), row({ id: 'a', ordinal: 1 })], now);
    expect(r?.id).toBe('a');
  });
  it('skips an attempt-2 row still inside its 5-minute floor, even if it has the lowest ordinal', () => {
    const gated = row({ id: 'retry', ordinal: 0, attempt: 2, retryNotBefore: new Date(now.getTime() + 60_000) });
    const r = nextEligiblePendingItem([gated, row({ id: 'fresh', ordinal: 5 })], now);
    expect(r?.id).toBe('fresh');
  });
  it('dials the retry once its floor has passed', () => {
    const due = row({ id: 'retry', ordinal: 9, attempt: 2, retryNotBefore: new Date(now.getTime() - 1) });
    expect(nextEligiblePendingItem([due], now)?.id).toBe('retry');
  });
  it('returns null when only floor-gated retries remain', () => {
    const gated = row({ id: 'retry', attempt: 2, retryNotBefore: new Date(now.getTime() + RETRY_FLOOR_MS) });
    expect(nextEligiblePendingItem([gated], now)).toBeNull();
  });
});

describe('earliestRetryAt', () => {
  it('is the soonest future floor among pending rows, else null', () => {
    const a = row({ id: 'a', attempt: 2, retryNotBefore: new Date(now.getTime() + 120_000) });
    const b = row({ id: 'b', attempt: 2, retryNotBefore: new Date(now.getTime() + 30_000) });
    expect(earliestRetryAt([a, b], now)?.toISOString()).toBe(new Date(now.getTime() + 30_000).toISOString());
    expect(earliestRetryAt([row({ id: 'c' })], now)).toBeNull();
  });
  it('ignores rows that are no longer pending', () => {
    const done = row({ id: 'd', status: 'no_connect', attempt: 2, retryNotBefore: new Date(now.getTime() + 30_000) });
    expect(earliestRetryAt([done], now)).toBeNull();
  });
});

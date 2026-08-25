import { describe, expect, it } from 'vitest';
import { aggregate, velocityGateCheck } from './index.js';

/**
 * Gate 7b — the per-DID 10-calls-per-minute anti-burst — had ZERO automated
 * coverage: no test in the repo called `evaluate()`, and prod has never seen a
 * DID exceed 3/min, so nothing has ever proved the BLOCK half fires
 * (spam-defense audit §6). Its sibling gate inside the very same UPDATE — the
 * daily warmup cap — once shipped to prod silently broken for exactly that
 * reason. This pins the boundary.
 */
const NOW = new Date('2026-08-24T18:00:00Z');
const row = (count: number, windowStart: Date | null = new Date(NOW.getTime() - 10_000)) => ({
  e164: '+16195550100',
  lastMinuteDialCount: count,
  lastMinuteWindowStart: windowStart,
});

describe('velocityGateCheck — the 10/min boundary', () => {
  it('blocks at 10 in a fresh window (the autodialer fingerprint)', () => {
    const check = velocityGateCheck(row(10), NOW);
    expect(check).toMatchObject({
      name: 'velocity',
      passed: false,
      severity: 'block',
      reasonCode: 'CALL_VELOCITY_BURST_DETECTED',
    });
    expect(check.detail).toContain('10 calls/min from +16195550100');
    // Severity alone is not the outcome — the aggregate has to turn it into a
    // BLOCK, which is what routes/calls.ts refuses on with a 403.
    const agg = aggregate([check], null);
    expect(agg.decision).toBe('BLOCK');
    expect(agg.blockReason).toContain('autodialer fingerprint');
  });

  it('passes at 9 in a fresh window (a rep working fast is not a burst)', () => {
    const check = velocityGateCheck(row(9), NOW);
    expect(check).toMatchObject({ passed: true, severity: 'info', reasonCode: 'CALL_VELOCITY_OK' });
    expect(check.detail).toBe('9/10 per min');
    expect(aggregate([check], null).decision).toBe('ALLOW');
  });

  it('blocks above the cap too, reporting the real count', () => {
    expect(velocityGateCheck(row(14), NOW)).toMatchObject({ passed: false, severity: 'block' });
    expect(velocityGateCheck(row(14), NOW).detail).toContain('14 calls/min');
  });

  it('a window older than a minute is spent — the count reads 0, not a stale block', () => {
    // The SQL cap does the same reset (`now() - window_start > interval
    // '1 minute' then 0`); a pre-call read that kept blocking on last minute's
    // burst would strand the DID for as long as nobody dialed it.
    const stale = new Date(NOW.getTime() - 60_001);
    const check = velocityGateCheck({ ...row(10), lastMinuteWindowStart: stale }, NOW);
    expect(check).toMatchObject({ passed: true, reasonCode: 'CALL_VELOCITY_OK' });
    expect(check.detail).toBe('0/10 per min');
  });

  it('the window boundary itself is still inside the minute (59.999s → still counted)', () => {
    const edge = new Date(NOW.getTime() - 59_999);
    expect(velocityGateCheck({ ...row(10), lastMinuteWindowStart: edge }, NOW)).toMatchObject({ passed: false });
  });

  it('a never-dialed number (null window) reads 0', () => {
    const check = velocityGateCheck(row(10, null), NOW);
    expect(check).toMatchObject({ passed: true });
    expect(check.detail).toBe('0/10 per min');
  });
});

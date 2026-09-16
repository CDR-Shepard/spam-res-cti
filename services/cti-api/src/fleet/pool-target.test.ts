import { describe, expect, it } from 'vitest';
import { POOL_TARGET, poolBuyCount, poolBuyTarget, readPoolTarget } from './plan.js';

describe('POOL_TARGET', () => {
  // Sized for twenty reps: 20 x 300 records x 1.8 dials = 10,800/day, and a
  // mature DID is capped at 80/day, so 135 flat out plus headroom for flagged.
  it('is sized for the twenty-rep team, not the five-pilot one', () => {
    expect(POOL_TARGET).toBeGreaterThanOrEqual(135);
  });
});

describe('poolBuyCount', () => {
  it('is the shortfall toward the target', () => {
    expect(poolBuyCount(36, 160)).toBe(124);
    expect(poolBuyCount(160, 160)).toBe(0);
  });
  it('never goes negative when the pool is over target', () => {
    expect(poolBuyCount(200, 160)).toBe(0);
  });
});

describe('poolBuyTarget — asked is a TARGET, never an increment', () => {
  it('buys the smaller of what was asked and the shortfall', () => {
    expect(poolBuyTarget(123, 36, 0, 160)).toBe(123);
    expect(poolBuyTarget(500, 36, 0, 160)).toBe(124);
  });
  it('subtracts what a previous run already bought but has not registered', () => {
    expect(poolBuyTarget(123, 36, 123, 160)).toBe(0);
    expect(poolBuyTarget(123, 36, 23, 160)).toBe(100);
  });
  // The property that stops a re-run double-spending.
  it('never re-buys once the pool has reached the target', () => {
    expect(poolBuyTarget(123, 160, 0, 160)).toBe(0);
  });
});

describe('readPoolTarget', () => {
  it('takes a sane override', () => {
    expect(readPoolTarget('200')).toBe(200);
    expect(readPoolTarget('0')).toBe(0);
  });

  // NaN would sail straight through every Math.max(0, …) clamp downstream and
  // end up as the count asked of Twilio.
  it('falls back rather than yielding NaN on junk', () => {
    for (const junk of ['', '  ', 'fifty', '12.5', '-5', '1e9', undefined]) {
      expect(readPoolTarget(junk as string | undefined)).toBe(160);
    }
  });

  it('refuses an absurd value instead of buying it', () => {
    expect(readPoolTarget('100000')).toBe(160);
  });
});

import { describe, expect, it } from 'vitest';
import { warmupCapForAge } from './warmup.js';

/**
 * Locks the warmup curve to the documented thresholds (SPAM_RESISTANCE_2026.md):
 *   wk1 (day 0-6)  → 20/day
 *   wk2 (day 7-13) → 40/day
 *   wk3 (day 14-20)→ 70/day
 *   wk4+ (day 21+) → 80/day
 * If these caps drift the whole warmup defense silently weakens.
 */
describe('warmupCapForAge', () => {
  it('treats a never-used DID (null) as day 1, cap 20', () => {
    expect(warmupCapForAge(null)).toMatchObject({ cap: 20, tier: 1 });
  });

  it.each([
    [0, 20, 1],
    [6, 20, 1],
    [7, 40, 2],
    [13, 40, 2],
    [14, 70, 3],
    [20, 70, 3],
    [21, 80, 4],
    [100, 80, 4],
  ])('day %i → cap %i, tier %i', (days, cap, tier) => {
    const r = warmupCapForAge(days);
    expect(r.cap).toBe(cap);
    expect(r.tier).toBe(tier);
  });

  it('is monotonically non-decreasing across the boundaries', () => {
    let prev = 0;
    for (let d = 0; d <= 40; d++) {
      const cap = warmupCapForAge(d).cap;
      expect(cap).toBeGreaterThanOrEqual(prev);
      prev = cap;
    }
  });
});

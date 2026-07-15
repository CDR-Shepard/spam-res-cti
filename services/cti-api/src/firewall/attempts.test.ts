import { describe, expect, it } from 'vitest';
import { attemptGateChecks, tallyAttempts } from './index.js';

describe('tallyAttempts', () => {
  it('sums the total across all numbers and maps per-number, excluding null from_number from the map', () => {
    const { attemptsByNumber, customerAttemptsTotal } = tallyAttempts([
      { from: '+1A', n: 3 },
      { from: '+1B', n: 2 },
      { from: null, n: 4 }, // inbound/legacy — counts toward the ceiling only
    ]);
    expect(customerAttemptsTotal).toBe(9);
    expect(attemptsByNumber.get('+1A')).toBe(3);
    expect(attemptsByNumber.get('+1B')).toBe(2);
    expect([...attemptsByNumber.keys()]).toEqual(['+1A', '+1B']);
  });

  it('is empty for no rows', () => {
    const { attemptsByNumber, customerAttemptsTotal } = tallyAttempts([]);
    expect(customerAttemptsTotal).toBe(0);
    expect(attemptsByNumber.size).toBe(0);
  });
});

const base = { windowDays: 14, maxAttempts: 5, perCustomerMaxAttempts: 15 };

describe('attemptGateChecks — per-customer ceiling (harassment backstop)', () => {
  it('BLOCKS at the ceiling — the 16th contact when the ceiling is 15', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map(),
      customerAttemptsTotal: 15,
      effectiveFrom: null,
    }).find((x) => x.name === 'customer_limit')!;
    expect(c.passed).toBe(false);
    expect(c.severity).toBe('block');
    expect(c.reasonCode).toBe('CUSTOMER_LIMIT_EXCEEDED');
  });

  it('passes below the ceiling', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map(),
      customerAttemptsTotal: 14,
      effectiveFrom: null,
    }).find((x) => x.name === 'customer_limit')!;
    expect(c.passed).toBe(true);
    expect(c.severity).toBe('info');
  });
});

describe('attemptGateChecks — per-number budget', () => {
  it('BLOCKS when the chosen number is at its per-number budget for the customer', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map([['+1A', 5]]),
      customerAttemptsTotal: 5,
      effectiveFrom: '+1A',
    }).find((x) => x.name === 'attempt_limit')!;
    expect(c.passed).toBe(false);
    expect(c.severity).toBe('block');
    expect(c.reasonCode).toBe('ATTEMPT_LIMIT_EXCEEDED');
  });

  it('passes when the chosen number is under its per-number budget', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map([['+1A', 4]]),
      customerAttemptsTotal: 4,
      effectiveFrom: '+1A',
    }).find((x) => x.name === 'attempt_limit')!;
    expect(c.passed).toBe(true);
  });

  it('emits no per-number check when no DID was chosen, but the ceiling still applies', () => {
    const checks = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map(),
      customerAttemptsTotal: 0,
      effectiveFrom: null,
    });
    expect(checks.some((x) => x.name === 'attempt_limit')).toBe(false);
    expect(checks.some((x) => x.name === 'customer_limit')).toBe(true);
  });

  it('lets each number keep its own budget while the customer total climbs (bounded by the ceiling)', () => {
    // 3 numbers × 4 each = 12 total (< ceiling 15), each under 5/number → all pass.
    const map = new Map([['+1A', 4], ['+1B', 4], ['+1C', 4]]);
    const checks = attemptGateChecks({ ...base, attemptsByNumber: map, customerAttemptsTotal: 12, effectiveFrom: '+1C' });
    expect(checks.find((x) => x.name === 'attempt_limit')!.passed).toBe(true);
    expect(checks.find((x) => x.name === 'customer_limit')!.passed).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DIALER_RUN_DEFAULTS,
  DIALER_PASSES,
  MAX_RUN_RECORDS,
  ROLLOVER_BUSINESS_DAYS,
  toDialerPasses,
  toDialerRunDefaults,
  toMaxRecords,
  toRolloverBusinessDays,
} from './index.js';

describe('Power Dial run settings (spec 2026-09-28)', () => {
  it("the choices, and defaults that are exactly today's run", () => {
    expect(DIALER_PASSES).toEqual([1, 2]);
    expect(ROLLOVER_BUSINESS_DAYS).toEqual([1, 2]);
    expect(DEFAULT_DIALER_RUN_DEFAULTS).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(MAX_RUN_RECORDS).toBe(500);
  });

  it('toDialerPasses: only 1 is Once; anything else is Twice', () => {
    expect(toDialerPasses(1)).toBe(1);
    for (const v of [2, 0, 3, '1', null, undefined, 1.5]) expect(toDialerPasses(v)).toBe(2);
  });

  it('toRolloverBusinessDays: only 2 is two days; anything else is the next business day', () => {
    expect(toRolloverBusinessDays(2)).toBe(2);
    for (const v of [1, 0, 3, '2', null, undefined]) expect(toRolloverBusinessDays(v)).toBe(1);
  });

  // Controller ruling S2: "How many" is remembered too — a nullable positive
  // integer, null = All. Anything that is not a positive integer (including 0,
  // a negative, a fraction, a string, or nothing at all) reads as All, never
  // an arbitrary number a bad row could otherwise smuggle through.
  it('toMaxRecords: a positive integer round-trips; anything else is All (null)', () => {
    expect(toMaxRecords(100)).toBe(100);
    expect(toMaxRecords(1)).toBe(1);
    expect(toMaxRecords(500)).toBe(500);
    for (const v of [0, -1, 1.5, '100', null, undefined, NaN, Infinity]) expect(toMaxRecords(v)).toBeNull();
  });

  it("toDialerRunDefaults reads a row; a missing one is today's run", () => {
    expect(toDialerRunDefaults({ passes: 1, maxRecords: 50, rolloverBusinessDays: 2 })).toEqual({ passes: 1, maxRecords: 50, rolloverBusinessDays: 2 });
    expect(toDialerRunDefaults(undefined)).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(toDialerRunDefaults(null)).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
    expect(toDialerRunDefaults({ passes: 'once', maxRecords: '100', rolloverBusinessDays: 7 })).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
  });

  // Controller ruling S2: null round-trips — a rep who saved "All" reads it
  // back as null, never a stray number.
  it('null round-trips through toDialerRunDefaults', () => {
    expect(toDialerRunDefaults({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 })).toEqual({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 });
  });
});

import { describe, expect, it } from 'vitest';
import { addDays, dayOfWeek, nextBusinessDay } from './next-business-day.js';

const MON_FRI = new Set([1, 2, 3, 4, 5]);

describe('addDays / dayOfWeek', () => {
  it('adds days across month boundaries and reports weekday', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(dayOfWeek('2026-07-13')).toBe(1); // Monday
    expect(dayOfWeek('2026-07-18')).toBe(6); // Saturday
  });
});

describe('nextBusinessDay', () => {
  it('advances one weekday', () => {
    expect(nextBusinessDay('2026-07-13', MON_FRI, new Set())).toBe('2026-07-14'); // Mon→Tue
  });
  it('rolls Friday to Monday', () => {
    expect(nextBusinessDay('2026-07-17', MON_FRI, new Set())).toBe('2026-07-20'); // Fri→Mon
  });
  it('skips a holiday and the weekend', () => {
    // Thu 7/2 → Fri 7/3 (holiday) → Sat/Sun → Mon 7/6
    expect(nextBusinessDay('2026-07-02', MON_FRI, new Set(['2026-07-03']))).toBe('2026-07-06');
  });
  it('throws on an empty working-week', () => {
    expect(() => nextBusinessDay('2026-07-13', new Set(), new Set())).toThrow(/workingWeekdays/);
  });
});

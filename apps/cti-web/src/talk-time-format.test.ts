import { describe, expect, it } from 'vitest';
import { addDays, formatDay, formatHms, orgToday, rangeFor } from './talk-time-format';

describe('formatHms', () => {
  it('h:mm:ss, hours uncapped', () => {
    expect(formatHms(0)).toBe('0:00:00');
    expect(formatHms(59)).toBe('0:00:59');
    expect(formatHms(3725)).toBe('1:02:05');
    expect(formatHms(90_000)).toBe('25:00:00');
  });
});

describe("the org's (Pacific) calendar", () => {
  it('today is the Pacific day, not the UTC one', () => {
    expect(orgToday(new Date('2026-10-02T01:00:00Z'))).toBe('2026-10-01'); // 18:00 PDT
  });

  it('addDays crosses month ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
  });

  it('Today / This week (Monday–today) / Last 7 days', () => {
    const thu = new Date('2026-10-01T18:00:00Z'); // Thu Oct 1, 11:00 PDT
    expect(rangeFor('today', thu)).toEqual({ from: '2026-10-01', to: '2026-10-01' });
    expect(rangeFor('week', thu)).toEqual({ from: '2026-09-28', to: '2026-10-01' });
    expect(rangeFor('last7', thu)).toEqual({ from: '2026-09-25', to: '2026-10-01' });
    expect(rangeFor('week', new Date('2026-09-28T18:00:00Z'))).toEqual({ from: '2026-09-28', to: '2026-09-28' }); // a Monday
    expect(rangeFor('week', new Date('2026-10-04T18:00:00Z'))).toEqual({ from: '2026-09-28', to: '2026-10-04' }); // a Sunday
  });

  it('a day label reads like "Thu 10/1"', () => {
    expect(formatDay('2026-10-01')).toBe('Thu 10/1');
  });
});

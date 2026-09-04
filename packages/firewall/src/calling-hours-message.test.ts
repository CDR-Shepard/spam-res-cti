import { describe, expect, it } from 'vitest';
import {
  callingHoursBlockDetail,
  callingHoursVerdict,
  formatAllowedDays,
  isWithinCallingHours,
} from './index.js';

/**
 * 2026-08-30 live incident: a rep was blocked from dialing on a Sunday at
 * 10:20 AM PT and read the detail as "outside 08:00-20:00" — which sounded
 * like the dialer was broken, since 10:20 AM plainly sits inside 08:00-20:00.
 * The real gate was the Mon-Fri day restriction, not the clock. These tests
 * pin the fix: when the DAY is the reason, the message says so; when the
 * clock is the reason, the existing hours message is unchanged.
 */
const TZ = 'America/Los_Angeles';
const WINDOW = { start: '08:00', end: '20:00' };
const WEEKDAYS = [1, 2, 3, 4, 5];

/** A Pacific-local wall-clock time on a known 2026-07 weekday (all PDT, UTC-7). */
function pacificAt(isoDate: string, hour: number, minute = 0): Date {
  const utcHour = hour + 7;
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const day = d + Math.floor(utcHour / 24);
  const h = utcHour % 24;
  const date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(`${date}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}

const SUNDAY = '2026-07-12';
const TUESDAY = '2026-07-14';
const SATURDAY = '2026-07-18';

describe('callingHoursVerdict + callingHoursBlockDetail — day vs. hours reason', () => {
  it('Sunday 10:00 with Mon-Fri days: blocked, detail names the day, not the hours', () => {
    const now = pacificAt(SUNDAY, 10, 0);
    const verdict = callingHoursVerdict(now, TZ, WINDOW.start, WINDOW.end, WEEKDAYS);
    expect(verdict.within).toBe(false);
    expect(verdict.dayAllowed).toBe(false);
    expect(verdict.weekdayName).toBe('Sunday');

    const detail = callingHoursBlockDetail(verdict, WINDOW, TZ, WEEKDAYS);
    expect(detail).toContain('Mon-Fri');
    expect(detail).toContain('Sunday');
    expect(detail).not.toContain('08:00-20:00');
  });

  it('Tuesday 21:30 with Mon-Fri days: blocked, detail is the existing hours message', () => {
    const now = pacificAt(TUESDAY, 21, 30);
    const verdict = callingHoursVerdict(now, TZ, WINDOW.start, WINDOW.end, WEEKDAYS);
    expect(verdict.within).toBe(false);
    expect(verdict.dayAllowed).toBe(true);

    const detail = callingHoursBlockDetail(verdict, WINDOW, TZ, WEEKDAYS);
    expect(detail).toContain('08:00-20:00');
    expect(detail).not.toContain('Mon-Fri');
    expect(detail).not.toContain('Tuesday');
  });

  it('Saturday inside hours with Mon-Sat days: allowed', () => {
    const now = pacificAt(SATURDAY, 10, 0);
    const allowedDays = [1, 2, 3, 4, 5, 6];
    const verdict = callingHoursVerdict(now, TZ, WINDOW.start, WINDOW.end, allowedDays);
    expect(verdict.within).toBe(true);
    expect(verdict.dayAllowed).toBe(true);
    expect(isWithinCallingHours(now, TZ, WINDOW.start, WINDOW.end, allowedDays)).toBe(true);
  });
});

describe('formatAllowedDays — compact rendering of allowed ISO weekdays', () => {
  it.each([
    [[1, 2, 3, 4, 5], 'Mon-Fri'],
    [[1, 2, 3, 4, 5, 6], 'Mon-Sat'],
    [[1, 3, 5], 'Mon, Wed, Fri'],
    [[1, 2, 3, 4, 5, 6, 7], 'Mon-Sun'],
  ])('%j -> %s', (days, expected) => {
    expect(formatAllowedDays(days)).toBe(expected);
  });
});

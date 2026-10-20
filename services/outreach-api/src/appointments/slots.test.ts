import { describe, expect, it } from 'vitest';
import { conflicts, horizonDays, type Busy, type Window } from './slots.js';
import { zonedInstant, type LocalDay } from './zoned.js';

const LA = 'America/Los_Angeles';
const WEEKDAYS = [1, 2, 3, 4, 5] as const;
/** Tuesday 2026-10-06 08:00 PDT. */
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MIN = 60_000;

/** A local wall-clock instant in LA. */
const la = (m: number, d: number, hh: number, mm = 0, y = 2026): Date => zonedInstant(LA, y, m, d, hh, mm);
const timed = (start: Date, end: Date): Busy => ({ start, end, allDay: false });
const allDay = (y: number, m: number, d: number): Busy => ({ start: new Date(Date.UTC(y, m - 1, d)), end: new Date(Date.UTC(y, m - 1, d + 1)), allDay: true, day: { year: y, month: m, day: d } });
/** "m/d" for each local day. */
const dates = (days: readonly LocalDay[]): string[] => days.map((d) => `${d.month}/${d.day}`);

describe('horizonDays (the routing engine\'s candidate days)', () => {
  it('counts today when it is a booking day, then the next booking days', () => {
    expect(dates(horizonDays(3, WEEKDAYS, NOW, LA))).toEqual(['10/6', '10/7', '10/8']);
  });

  it('from a Saturday the horizon starts on Monday', () => {
    expect(dates(horizonDays(2, WEEKDAYS, la(10, 10, 9), LA))).toEqual(['10/12', '10/13']);
  });

  it('counts only the configured days', () => {
    expect(dates(horizonDays(3, [1, 3, 5], NOW, LA))).toEqual(['10/7', '10/9', '10/12']);
    expect(dates(horizonDays(1, [6], NOW, LA))).toEqual(['10/10']);
  });

  it('days are local to the zone given: 23:30 PDT Tuesday is already Wednesday in New York', () => {
    const late = la(10, 6, 23, 30);
    expect(dates(horizonDays(1, WEEKDAYS, late, LA))).toEqual(['10/6']);
    expect(dates(horizonDays(1, WEEKDAYS, late, 'America/New_York'))).toEqual(['10/7']);
  });

  it('across the fall DST change (now Fri 2026-10-30) the weekend is skipped', () => {
    expect(dates(horizonDays(3, WEEKDAYS, la(10, 30, 8), LA))).toEqual(['10/30', '11/2', '11/3']);
  });

  it('no configured day gives nothing (the scan is bounded)', () => {
    expect(horizonDays(5, [], NOW, LA)).toEqual([]);
  });
});

describe('conflicts (the one overlap rule: the routing engine and the write-back\'s re-check both use it)', () => {
  const w = (start: Date, minutes: number): Window => ({ start, end: new Date(start.getTime() + minutes * MIN) });
  const BUF = 30 * MIN;

  it.each<[string, Window, Busy[], number, boolean]>([
    ['touching on the left is free', w(la(10, 7, 10), 15), [timed(la(10, 7, 9, 45), la(10, 7, 10))], 0, false],
    ['touching on the right is free', w(la(10, 7, 10), 15), [timed(la(10, 7, 10, 15), la(10, 7, 10, 30))], 0, false],
    ['a one-minute overlap conflicts', w(la(10, 7, 10), 15), [timed(la(10, 7, 10, 14), la(10, 7, 10, 30))], 0, true],
    ['busy inside the window conflicts', w(la(10, 7, 9), 60), [timed(la(10, 7, 9, 20), la(10, 7, 9, 40))], 0, true],
    ['the buffer turns a near miss into a conflict', w(la(10, 7, 10), 60), [timed(la(10, 7, 11, 15), la(10, 7, 12))], BUF, true],
    ['touching the buffered edge is free', w(la(10, 7, 10), 60), [timed(la(10, 7, 11, 30), la(10, 7, 12))], BUF, false],
    ['an all-day Event conflicts on its local date', w(la(10, 7, 23), 30), [allDay(2026, 10, 7)], 0, true],
    ['an all-day Event is never widened by the buffer', w(la(10, 8, 0, 30), 30), [allDay(2026, 10, 7)], 120 * MIN, false],
    ['a window across midnight touches both local dates', w(la(10, 6, 23, 30), 60), [allDay(2026, 10, 7)], 0, true],
    ['an all-day item without a day is judged by its instants', w(la(10, 7, 10), 60), [{ start: la(10, 7, 10, 30), end: la(10, 7, 11), allDay: true }], 0, true],
  ])('%s', (_label, window, busy, buffer, expected) => {
    expect(conflicts(window, busy, LA, buffer)).toBe(expected);
  });
});

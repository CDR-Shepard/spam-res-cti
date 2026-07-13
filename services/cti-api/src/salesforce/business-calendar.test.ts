import { describe, expect, it } from 'vitest';
import { parseBusinessCalendar } from './business-calendar.js';

describe('parseBusinessCalendar', () => {
  it('maps non-null <Day>StartTime to working weekdays and collects holidays', () => {
    const bh = {
      SundayStartTime: null, MondayStartTime: '08:00:00.000Z', TuesdayStartTime: '08:00:00.000Z',
      WednesdayStartTime: '08:00:00.000Z', ThursdayStartTime: '08:00:00.000Z',
      FridayStartTime: '08:00:00.000Z', SaturdayStartTime: null,
    };
    const cal = parseBusinessCalendar(bh, [{ ActivityDate: '2026-12-25' }, { ActivityDate: null }]);
    expect([...cal.workingWeekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(cal.holidays.has('2026-12-25')).toBe(true);
    expect(cal.holidays.size).toBe(1);
  });
  it('falls back to Mon-Fri when Business Hours is missing/empty', () => {
    const cal = parseBusinessCalendar(null, []);
    expect([...cal.workingWeekdays].sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

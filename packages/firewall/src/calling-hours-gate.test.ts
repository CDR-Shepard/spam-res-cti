import { describe, expect, it } from 'vitest';
import { callingHoursGateCheck } from './index.js';

/**
 * Gate 6, post weekend-calling ruling (2026-08-31, Evren): "call on weekends
 * globally, except where a state restricts it." These pin the state overlay's
 * effect on the firewall's per-call calling-hours gate — `callingHoursGateCheck`
 * is the pure boundary `evaluate()`'s gate 6 delegates to, so these scenarios
 * are testable without standing up the whole `evaluate()` pipeline (DB, SF
 * client, etc.) — same pattern as `velocityGateCheck`/`attemptGateChecks`.
 *
 * ALL 7 days is the post-migration campaign default (0033_weekend_calling.sql).
 */
const ALL_7_DAYS = [1, 2, 3, 4, 5, 6, 7];
const SYSTEM_WINDOW = { start: '08:00', end: '21:00' }; // callingWindowFor() default clamp

/** A Pacific-local wall-clock time on a known 2026-07 date (all PDT, UTC-7). */
function pacificAt(isoDate: string, hour: number, minute = 0): Date {
  return atOffset(isoDate, hour, minute, 7);
}
/** A Central-local wall-clock time on a known 2026-07 date (all CDT, UTC-5). */
function centralAt(isoDate: string, hour: number, minute = 0): Date {
  return atOffset(isoDate, hour, minute, 5);
}
/** An Eastern-local wall-clock time on a known 2026-07 date (all EDT, UTC-4). */
function easternAt(isoDate: string, hour: number, minute = 0): Date {
  return atOffset(isoDate, hour, minute, 4);
}
function atOffset(isoDate: string, hour: number, minute: number, utcOffsetHours: number): Date {
  const utcHour = hour + utcOffsetHours;
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const day = d + Math.floor(utcHour / 24);
  const h = ((utcHour % 24) + 24) % 24;
  const date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return new Date(`${date}T${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
}

const SUNDAY = '2026-07-12';
const TUESDAY = '2026-07-14';

describe('callingHoursGateCheck — weekend calling with the per-state overlay', () => {
  it('CA lead Sunday 10:00 PT → ALLOWED (CA has no table row; federal baseline covers Sunday)', () => {
    const result = callingHoursGateCheck({
      now: pacificAt(SUNDAY, 10, 0),
      tz: 'America/Los_Angeles',
      state: 'CA',
      window: SYSTEM_WINDOW,
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(true);
    expect(result.reasonCode).toBe('CALLING_HOURS_OK');
  });

  it('AL lead Sunday → BLOCK, detail names AL and Sunday (AL bans Sunday)', () => {
    const result = callingHoursGateCheck({
      now: centralAt(SUNDAY, 10, 0),
      tz: 'America/Chicago',
      state: 'AL',
      window: SYSTEM_WINDOW,
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('OUTSIDE_CALLING_HOURS');
    expect(result.detail).toContain('AL');
    expect(result.detail).toContain('Sunday');
  });

  it('TX lead Sunday 11:00 CT → BLOCK (before the noon start)', () => {
    const result = callingHoursGateCheck({
      now: centralAt(SUNDAY, 11, 0),
      tz: 'America/Chicago',
      state: 'TX',
      window: SYSTEM_WINDOW,
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('OUTSIDE_CALLING_HOURS');
    // The EFFECTIVE window (TX Sunday: noon-9pm), not the raw campaign window.
    expect(result.detail).toContain('12:00-21:00');
  });

  it('TX lead Sunday 13:00 CT → ALLOW (past the noon start)', () => {
    const result = callingHoursGateCheck({
      now: centralAt(SUNDAY, 13, 0),
      tz: 'America/Chicago',
      state: 'TX',
      window: SYSTEM_WINDOW,
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(true);
    expect(result.reasonCode).toBe('CALLING_HOURS_OK');
    expect(result.detail).toContain('TX rule');
  });

  it('FL lead 20:30 ET any day → BLOCK, detail shows the 08:00-20:00 effective window', () => {
    for (const date of [TUESDAY, SUNDAY]) {
      const result = callingHoursGateCheck({
        now: easternAt(date, 20, 30),
        tz: 'America/New_York',
        state: 'FL',
        window: SYSTEM_WINDOW,
        allowedDays: ALL_7_DAYS,
      });
      expect(result.passed).toBe(false);
      expect(result.reasonCode).toBe('OUTSIDE_CALLING_HOURS');
      expect(result.detail).toContain('08:00-20:00');
    }
  });

  it('unknown-state Sunday → BLOCK with the unresolved-state detail', () => {
    const result = callingHoursGateCheck({
      now: pacificAt(SUNDAY, 10, 0),
      tz: 'America/Los_Angeles',
      state: null,
      window: SYSTEM_WINDOW,
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('OUTSIDE_CALLING_HOURS');
    expect(result.detail).toContain('Sunday calling requires a known state (recipient state unresolved)');
  });

  it('unknown-state Tuesday → ALLOW (unknown-state rule permits Mon-Sat)', () => {
    const result = callingHoursGateCheck({
      now: pacificAt(TUESDAY, 10, 0),
      tz: 'America/Los_Angeles',
      state: null,
      window: SYSTEM_WINDOW,
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(true);
    expect(result.reasonCode).toBe('CALLING_HOURS_OK');
  });

  it('the ALLOW detail names the effective window, tz, and state rule', () => {
    const result = callingHoursGateCheck({
      now: centralAt(TUESDAY, 12, 0),
      tz: 'America/Chicago',
      state: 'TX',
      window: { start: '08:00', end: '20:00' }, // this org's narrower campaign window
      allowedDays: ALL_7_DAYS,
      tzSource: 'area code 214',
    });
    expect(result.passed).toBe(true);
    expect(result.detail).toBe('09:00-20:00 America/Chicago · TX rule · area code 214');
  });

  it('FIX-2: an EMPTY INTERSECTION (day allowed, but the state window does not overlap the campaign window) does NOT claim a day ban', () => {
    // Reviewer repro: a campaign that only opens 20:00-21:00 intersected with
    // FL's 08:00-20:00 window on a day FL clearly allows (Wednesday) — the
    // OLD code treated any null effectiveWindow as a day-ban and printed
    // "Calling FL is Mon-Sun only (today is Wednesday...)", which is
    // self-contradictory (FL allows every day). The real constraint is the
    // clock, not the day, so the message must say so and name FL's actual
    // window for that day.
    const WEDNESDAY = '2026-07-15';
    const result = callingHoursGateCheck({
      now: easternAt(WEDNESDAY, 20, 30), // inside the campaign's 20:00-21:00 window
      tz: 'America/New_York',
      state: 'FL',
      window: { start: '20:00', end: '21:00' },
      allowedDays: ALL_7_DAYS,
    });
    expect(result.passed).toBe(false);
    expect(result.reasonCode).toBe('OUTSIDE_CALLING_HOURS');
    expect(result.detail).not.toContain('only');
    expect(result.detail).not.toContain('Mon-Sun');
    expect(result.detail).toContain('08:00-20:00');
    expect(result.detail).toContain('FL');
  });

  it('a campaign that itself excludes the day still uses the ORIGINAL campaign-day message (unchanged from 779fe15)', () => {
    // A Mon-Fri-only campaign in a state (TX) that would otherwise allow Saturday.
    const SATURDAY = '2026-07-18';
    const result = callingHoursGateCheck({
      now: centralAt(SATURDAY, 10, 0),
      tz: 'America/Chicago',
      state: 'TX',
      window: SYSTEM_WINDOW,
      allowedDays: [1, 2, 3, 4, 5],
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('Mon-Fri');
    expect(result.detail).toContain('Saturday');
    expect(result.detail).not.toContain('TX');
  });
});

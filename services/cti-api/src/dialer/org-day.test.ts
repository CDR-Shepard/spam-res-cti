import { describe, expect, it } from 'vitest';
import { orgMidnightUtc, orgTodayIso } from './org-day.js';

const laClock = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
const laDate = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

describe('orgMidnightUtc', () => {
  it('is 00:00 LA on the same LA day, in winter (PST, UTC-8)', () => {
    const now = new Date('2026-01-15T20:30:00Z'); // 12:30 PST
    const m = orgMidnightUtc(now);
    expect(laClock(m)).toBe('00:00');
    expect(laDate(m)).toBe(laDate(now));
    expect(m.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });
  it('is 00:00 LA on the same LA day, in summer (PDT, UTC-7)', () => {
    const now = new Date('2026-08-24T18:00:00Z'); // 11:00 PDT
    const m = orgMidnightUtc(now);
    expect(laClock(m)).toBe('00:00');
    expect(m.toISOString()).toBe('2026-08-24T07:00:00.000Z');
  });
  it('handles the UTC-evening rollover (late LA night is still the same LA day)', () => {
    const now = new Date('2026-08-25T05:30:00Z'); // 22:30 PDT on Aug 24
    expect(orgMidnightUtc(now).toISOString()).toBe('2026-08-24T07:00:00.000Z');
  });

  it('supports positive-offset and fractional-offset zones (general contract)', () => {
    const tokyo = orgMidnightUtc(new Date('2026-08-24T18:00:00Z'), 'Asia/Tokyo'); // 03:00 Aug 25 JST
    expect(tokyo.toISOString()).toBe('2026-08-24T15:00:00.000Z'); // JST midnight Aug 25 = 15:00Z Aug 24
    const kolkata = orgMidnightUtc(new Date('2026-08-24T12:00:00Z'), 'Asia/Kolkata'); // 17:30 IST
    expect(kolkata.toISOString()).toBe('2026-08-23T18:30:00.000Z'); // IST midnight Aug 24 = 18:30Z Aug 23
  });
  /**
   * The same-LA-day guard is load-bearing, not belt-and-braces: the scan walks
   * candidate offsets from -14h, so in a UTC-10 zone the first instant that
   * renders 00:00 local is the PREVIOUS local day's midnight. Without the
   * `ymdIn(tz, candidate) === ymdIn(tz, now)` check the window would open a
   * full day early and inherit yesterday's dials.
   */
  it('returns TODAY\'s midnight, not yesterday\'s, in a far-west zone (UTC-10)', () => {
    const honolulu = orgMidnightUtc(new Date('2026-08-24T18:00:00Z'), 'Pacific/Honolulu'); // 08:00 HST Aug 24
    expect(honolulu.toISOString()).toBe('2026-08-24T10:00:00.000Z');
  });

  it('is correct on both DST transition days of 2026', () => {
    for (const iso of ['2026-03-08T20:00:00Z', '2026-11-01T20:00:00Z']) {
      const m = orgMidnightUtc(new Date(iso));
      expect(laClock(m)).toBe('00:00');
      expect(laDate(m)).toBe(laDate(new Date(iso)));
    }
  });
});

describe('orgTodayIso', () => {
  it('is the en-CA (ISO order) LA calendar date for the given instant', () => {
    expect(orgTodayIso(new Date('2026-08-26T07:00:00Z'))).toBe('2026-08-26'); // 00:00 PDT
    expect(orgTodayIso(new Date('2026-08-26T06:59:00Z'))).toBe('2026-08-25'); // 23:59 PDT the day before
  });

  it('defaults to the current instant when no date is passed', () => {
    expect(orgTodayIso()).toBe(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
        new Date(),
      ),
    );
  });

  it('supports an explicit timezone override, same rule as orgMidnightUtc', () => {
    expect(orgTodayIso(new Date('2026-08-24T18:00:00Z'), 'Asia/Tokyo')).toBe('2026-08-25');
  });
});

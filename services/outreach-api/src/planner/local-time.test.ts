import { describe, expect, it } from 'vitest';
import { localDayStart, nextLocalDayStart, nextLocalOpening, recipientTimezone, withinLocalWindow } from './local-time.js';

const LA = 'America/Los_Angeles';
const CHICAGO = 'America/Chicago';
const EMAIL = { start: '08:00', endExclusive: '18:00' };

describe('recipientTimezone', () => {
  it.each([
    ['+14155550101', LA],
    ['+13125550101', CHICAGO],
    ['+12125550101', 'America/New_York'],
    ['+18005550101', CHICAGO], // toll-free: no zone, Chicago fallback
    [null, CHICAGO],
  ])('%s → %s', (e164, tz) => {
    expect(recipientTimezone(e164)).toBe(tz);
  });
});

describe('local day boundaries', () => {
  it.each([
    // [at, timezone, localDayStart, nextLocalDayStart]
    ['2026-10-06T17:00:00Z', LA, '2026-10-06T07:00:00Z', '2026-10-07T07:00:00Z'], // Tue 10:00 PDT
    ['2026-10-07T05:30:00Z', LA, '2026-10-06T07:00:00Z', '2026-10-07T07:00:00Z'], // Tue 22:30 PDT
    ['2026-10-06T17:00:00Z', CHICAGO, '2026-10-06T05:00:00Z', '2026-10-07T05:00:00Z'],
    ['2026-10-31T19:00:00Z', LA, '2026-10-31T07:00:00Z', '2026-11-01T07:00:00Z'], // the night DST ends
    ['2026-11-01T20:00:00Z', LA, '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'], // the 25-hour day
  ])('%s in %s', (at, tz, start, next) => {
    expect(localDayStart(new Date(at), tz).toISOString()).toBe(new Date(start).toISOString());
    expect(nextLocalDayStart(new Date(at), tz).toISOString()).toBe(new Date(next).toISOString());
  });
});

describe('nextLocalOpening', () => {
  it('returns the start itself inside the window', () => {
    const at = new Date('2026-10-06T15:00:00Z'); // 10:00 CDT
    expect(withinLocalWindow(at, CHICAGO, EMAIL)).toBe(true);
    expect(nextLocalOpening(at, CHICAGO, EMAIL)).toEqual(at);
  });
  it('moves an evening start to 08:00 the next local morning', () => {
    expect(nextLocalOpening(new Date('2026-10-06T23:30:00Z'), CHICAGO, EMAIL)).toEqual(new Date('2026-10-07T13:00:00Z'));
  });
  it('treats the end of the window as exclusive', () => {
    expect(withinLocalWindow(new Date('2026-10-06T23:00:00Z'), CHICAGO, EMAIL)).toBe(false); // 18:00 CDT
  });
});

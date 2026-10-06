import { describe, expect, it } from 'vitest';
import { addLocalDays, zonedInstant, zonedParts } from './zoned.js';

const LA = 'America/Los_Angeles';

describe('zonedInstant', () => {
  it.each([
    ['an ordinary PDT morning', 2026, 10, 7, 11, 0, '2026-10-07T18:00:00.000Z'],
    ['an ordinary PST morning', 2026, 11, 2, 9, 0, '2026-11-02T17:00:00.000Z'],
    ['midnight', 2026, 10, 7, 0, 0, '2026-10-07T07:00:00.000Z'],
    ['the last minute of a day', 2026, 12, 31, 23, 59, '2027-01-01T07:59:00.000Z'],
    ['the overlap (1:30 happens twice): the earlier, PDT instant', 2026, 11, 1, 1, 30, '2026-11-01T08:30:00.000Z'],
    ['just after the overlap', 2026, 11, 1, 2, 0, '2026-11-01T10:00:00.000Z'],
    ['the gap (2:30 never happens): the instant after the gap, 3:30 PDT', 2026, 3, 8, 2, 30, '2026-03-08T10:30:00.000Z'],
    ['the start of the gap', 2026, 3, 8, 2, 0, '2026-03-08T10:00:00.000Z'],
    ['just before the gap', 2026, 3, 8, 1, 59, '2026-03-08T09:59:00.000Z'],
    ['just after the gap', 2026, 3, 8, 3, 0, '2026-03-08T10:00:00.000Z'],
    ['later on the day of the gap', 2026, 3, 8, 10, 0, '2026-03-08T17:00:00.000Z'],
    ['earlier on the day of the gap', 2026, 3, 8, 0, 30, '2026-03-08T08:30:00.000Z'],
  ])('%s', (_label, y, m, d, hh, mm, iso) => {
    expect(zonedInstant(LA, y, m, d, hh, mm).toISOString()).toBe(iso);
  });

  it('works east of UTC and in a zone without DST', () => {
    expect(zonedInstant('Europe/Berlin', 2026, 10, 25, 2, 30).toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(zonedInstant('Asia/Kolkata', 2026, 10, 7, 9, 0).toISOString()).toBe('2026-10-07T03:30:00.000Z');
    expect(zonedInstant('America/Phoenix', 2026, 7, 1, 9, 0).toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(zonedInstant('UTC', 2026, 1, 1, 0, 0).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('zonedParts', () => {
  it('reads the wall clock and the ISO weekday', () => {
    expect(zonedParts(new Date('2026-10-06T15:00:00Z'), LA)).toEqual({ year: 2026, month: 10, day: 6, hour: 8, minute: 0, isoWeekday: 2 });
    expect(zonedParts(new Date('2026-10-12T07:00:00Z'), LA)).toEqual({ year: 2026, month: 10, day: 12, hour: 0, minute: 0, isoWeekday: 1 });
    expect(zonedParts(new Date('2026-10-11T19:00:00Z'), LA).isoWeekday).toBe(7);
  });

  it('is the local day, not the UTC day', () => {
    expect(zonedParts(new Date('2026-10-07T03:00:00Z'), LA)).toMatchObject({ day: 6, hour: 20, isoWeekday: 2 });
  });

  it('round-trips with zonedInstant every half hour across both DST changes', () => {
    for (const start of ['2026-03-07T08:00:00Z', '2026-10-31T07:00:00Z']) {
      for (let i = 0; i < 96; i += 1) {
        const at = new Date(Date.parse(start) + i * 30 * 60_000);
        const p = zonedParts(at, LA);
        const back = zonedInstant(LA, p.year, p.month, p.day, p.hour, p.minute);
        // Inside the fall-back overlap the wall clock maps to the earlier instant; everywhere else it is exact.
        expect(zonedParts(back, LA), at.toISOString()).toEqual(p);
        expect(back.getTime() <= at.getTime(), at.toISOString()).toBe(true);
      }
    }
    const t = new Date('2026-10-07T18:00:00.000Z');
    const p = zonedParts(t, LA);
    expect(zonedInstant(LA, p.year, p.month, p.day, p.hour, p.minute)).toEqual(t);
  });
});

describe('addLocalDays', () => {
  it.each([
    ['the same day', '2026-10-06T15:00:00Z', 0, { year: 2026, month: 10, day: 6 }],
    ['tomorrow', '2026-10-06T15:00:00Z', 1, { year: 2026, month: 10, day: 7 }],
    ['across a month end', '2026-10-30T15:00:00Z', 3, { year: 2026, month: 11, day: 2 }],
    ['across a year end', '2026-12-31T15:00:00Z', 1, { year: 2027, month: 1, day: 1 }],
    ['from the local evening (already the next UTC day)', '2026-10-07T05:00:00Z', 1, { year: 2026, month: 10, day: 7 }],
    ['across a leap day', '2028-02-28T20:00:00Z', 1, { year: 2028, month: 2, day: 29 }],
    ['backwards', '2026-11-01T15:00:00Z', -1, { year: 2026, month: 10, day: 31 }],
  ])('%s', (_label, iso, n, expected) => {
    expect(addLocalDays(new Date(iso), n, LA)).toEqual(expected);
  });
});

import { describe, expect, it, vi } from 'vitest';
import * as orgDay from '../dialer/org-day.js';
import {
  MAX_RANGE_DAYS,
  addDays,
  assembleTalkTimeReport,
  dayStartUtc,
  dialerSecondsByUserDay,
  intersectIntervals,
  mergeIntervals,
  parseTalkRange,
  type TalkRange,
} from './talk-time.js';

const range = (from: string, to: string): TalkRange => {
  const r = parseTalkRange({ from, to });
  if (!r.ok) throw new Error(r.error);
  return r.range;
};

describe('days — the org\'s Pacific calendar', () => {
  it('a day starts at Pacific midnight in UTC, DST-safe', () => {
    expect(dayStartUtc('2026-10-01').toISOString()).toBe('2026-10-01T07:00:00.000Z'); // PDT
    expect(dayStartUtc('2026-12-01').toISOString()).toBe('2026-12-01T08:00:00.000Z'); // PST
    expect(dayStartUtc('2026-11-01').toISOString()).toBe('2026-11-01T07:00:00.000Z'); // fall-back day starts in PDT
  });

  it('addDays crosses month and year ends', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-01', -6)).toBe('2026-09-25');
  });
});

describe('parseTalkRange', () => {
  it('lists every day, inclusive, and bounds the range from first midnight to the midnight after the last day', () => {
    const r = range('2026-09-28', '2026-10-01');
    expect(r.days).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']);
    expect(r.start.toISOString()).toBe('2026-09-28T07:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-02T07:00:00.000Z');
  });

  it('one day is fine', () => {
    expect(range('2026-10-01', '2026-10-01').days).toEqual(['2026-10-01']);
  });

  it('rejects malformed or impossible dates, a reversed range, and more than 92 days', () => {
    expect(parseTalkRange({ from: '2026-10-1', to: '2026-10-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: '2026-02-30', to: '2026-03-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: '2026-13-01', to: '2026-13-02' }).ok).toBe(false);
    expect(parseTalkRange({ to: '2026-10-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: ['2026-10-01'], to: '2026-10-01' }).ok).toBe(false);
    expect(parseTalkRange({ from: '2026-10-02', to: '2026-10-01' })).toEqual({ ok: false, error: 'from must be on or before to' });
    expect(parseTalkRange({ from: '2026-01-01', to: addDays('2026-01-01', MAX_RANGE_DAYS - 1) }).ok).toBe(true);
    expect(parseTalkRange({ from: '2026-01-01', to: addDays('2026-01-01', MAX_RANGE_DAYS) })).toEqual({ ok: false, error: 'at most 92 days' });
  });
});

describe('mergeIntervals — a rep\'s line is counted once', () => {
  it('merges overlapping and touching spans, drops empty ones, keeps gaps', () => {
    expect(mergeIntervals([
      { start: 50, end: 60 },
      { start: 0, end: 10 },
      { start: 5, end: 20 },
      { start: 20, end: 25 },
      { start: 30, end: 30 },
    ])).toEqual([{ start: 0, end: 25 }, { start: 50, end: 60 }]);
  });

  // The activity windows can be tens of thousands of dials; a merge that copies
  // the result array on every step is quadratic and would stall the event loop.
  it('merges 50 000 spans in one linear pass', () => {
    const spans = Array.from({ length: 50_000 }, (_, i) => ({ start: i * 2, end: i * 2 + 1 }));
    const merged = mergeIntervals(spans);
    expect(merged).toHaveLength(50_000);
    expect(merged[0]).toEqual({ start: 0, end: 1 });
    expect(merged[49_999]).toEqual({ start: 99_998, end: 99_999 });
  });
});

describe('intersectIntervals', () => {
  it('keeps only the overlap of two sorted, merged lists', () => {
    expect(intersectIntervals(
      [{ start: 0, end: 10 }, { start: 20, end: 30 }],
      [{ start: 5, end: 25 }],
    )).toEqual([{ start: 5, end: 10 }, { start: 20, end: 25 }]);
  });
  it('touching spans share no time; either side empty gives nothing', () => {
    expect(intersectIntervals([{ start: 0, end: 10 }], [{ start: 10, end: 20 }])).toEqual([]);
    expect(intersectIntervals([], [{ start: 0, end: 10 }])).toEqual([]);
  });
});

describe('dialerSecondsByUserDay', () => {
  const days = ['2026-09-30', '2026-10-01'];
  const NOW = new Date('2026-10-02T03:00:00Z');

  it('splits a leg across Pacific midnight', () => {
    // 23:30 → 00:15 PDT across Sep 30 / Oct 1 (Pacific midnight = 07:00Z).
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: new Date('2026-10-01T06:30:00Z'), endedAt: new Date('2026-10-01T07:15:00Z') }],
      [{ userId: 'u1', start: new Date('2026-10-01T06:30:00Z'), end: new Date('2026-10-01T07:15:00Z') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-09-30': 1800, '2026-10-01': 900 } });
  });

  it('counts a replaced leg that lingered beside its successor once', () => {
    const out = dialerSecondsByUserDay(
      [
        { userId: 'u1', joinedAt: new Date('2026-10-01T16:00:00Z'), endedAt: new Date('2026-10-01T17:00:00Z') },
        { userId: 'u1', joinedAt: new Date('2026-10-01T16:30:00Z'), endedAt: new Date('2026-10-01T18:00:00Z') },
      ],
      [{ userId: 'u1', start: new Date('2026-10-01T16:00:00Z'), end: new Date('2026-10-01T18:00:00Z') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-01': 7200 } });
  });

  it('an open leg counts up to now; time outside the range is not counted', () => {
    const out = dialerSecondsByUserDay(
      [
        { userId: 'u1', joinedAt: new Date('2026-10-02T02:00:00Z'), endedAt: null },
        { userId: 'u2', joinedAt: new Date('2026-09-29T15:00:00Z'), endedAt: new Date('2026-09-29T16:00:00Z') },
      ],
      [
        { userId: 'u1', start: new Date('2026-10-02T02:00:00Z'), end: null },
        { userId: 'u2', start: new Date('2026-09-29T15:00:00Z'), end: new Date('2026-09-29T16:00:00Z') },
      ],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-01': 3600 } });
  });
});

describe('dialerSecondsByUserDay — only active time counts (idle-cutoff spec)', () => {
  const days = ['2026-10-05'];
  const NOW = new Date('2026-10-06T16:00:00Z');
  const at = (hhmmss: string) => new Date(`2026-10-05T${hhmmss}-07:00`); // PDT
  const MIN = 60;

  it('a dial counts the 15 minutes after it, inside the open line only', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [{ userId: 'u1', start: at('10:00:00'), end: at('10:00:00') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 15 * MIN } });
  });

  it('dials less than 15 minutes apart count continuously', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [
        { userId: 'u1', start: at('10:00:00'), end: at('10:00:00') },
        { userId: 'u1', start: at('10:10:00'), end: at('10:10:00') },
      ],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 25 * MIN } });
  });

  it('a long conversation counts in full plus 15 minutes after it ends', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [{ userId: 'u1', start: at('10:00:00'), end: at('10:40:00') }],
      days, NOW,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 55 * MIN } });
  });

  it('a conversation still going (end null) counts to now, inside the open line', () => {
    const now = at('10:30:00');
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: null }],
      [{ userId: 'u1', start: at('10:05:00'), end: null }],
      days, now,
    );
    expect(out).toEqual({ u1: { '2026-10-05': 25 * MIN } });
  });

  it('an open line with no activity counts nothing, and activity on no open line counts nothing', () => {
    expect(dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: at('10:00:00'), endedAt: at('12:00:00') }],
      [{ userId: 'u2', start: at('10:00:00'), end: at('10:00:00') }],
      days, NOW,
    )).toEqual({});
  });

  it("Matt's 2026-10-05: an hour of dialing, then a line left open until 9:35 pm, counts about an hour, not 8", () => {
    const legs = [
      { userId: 'u1', joinedAt: at('13:32:29'), endedAt: at('13:33:55') },
      { userId: 'u1', joinedAt: at('13:34:43'), endedAt: at('13:53:56') },
      { userId: 'u1', joinedAt: at('13:57:56'), endedAt: at('17:57:56') },
      { userId: 'u1', joinedAt: at('17:57:58'), endedAt: at('18:01:35') },
      { userId: 'u1', joinedAt: at('18:01:36'), endedAt: at('18:04:39') },
      { userId: 'u1', joinedAt: at('18:04:40'), endedAt: at('21:35:14') },
    ];
    const activity = [
      { userId: 'u1', start: at('13:32:30'), end: at('13:32:30') },
      { userId: 'u1', start: at('13:40:00'), end: at('13:40:00') },
      { userId: 'u1', start: at('13:58:00'), end: at('13:58:00') },
      { userId: 'u1', start: at('14:07:00'), end: at('14:19:03') }, // last call, prospect hung up 2:19 pm
    ];
    const seconds = dialerSecondsByUserDay(legs, activity, days, NOW).u1!['2026-10-05']!;
    // windows 13:32:30–13:55:00 and 13:58:00–14:34:03, inside the legs:
    // 13:32:30–13:33:55 (85 s) + 13:34:43–13:53:56 (1153 s) + 13:58:00–14:34:03 (2163 s);
    // the three reconnected legs after 17:57 had no activity at all.
    expect(seconds).toBe(85 + 1153 + 2163);
  });

  it('still splits at Pacific midnight', () => {
    const out = dialerSecondsByUserDay(
      [{ userId: 'u1', joinedAt: new Date('2026-10-05T06:50:00Z'), endedAt: new Date('2026-10-05T07:30:00Z') }],
      [{ userId: 'u1', start: new Date('2026-10-05T06:50:00Z'), end: new Date('2026-10-05T07:10:00Z') }],
      ['2026-10-04', '2026-10-05'], NOW,
    );
    // active 06:50 → 07:25Z; Pacific midnight is 07:00Z
    expect(out).toEqual({ u1: { '2026-10-04': 600, '2026-10-05': 1500 } });
  });
});

describe('dialerSecondsByUserDay — performance (final review I1)', () => {
  // The old code called dayStartUtc TWICE per day (day i's start, then day
  // i+1's start again as "day i's end"), each call scanning ~113 candidate
  // offsets in orgMidnightUtc — the one synchronous hotspot this branch added
  // to the event loop that also serves live Twilio webhooks. A spy on the
  // count is deterministic; a timing assertion would be flaky on CI.
  it('a 92-day range computes at most 93 day starts, not ~184', () => {
    const spy = vi.spyOn(orgDay, 'orgMidnightUtc');
    const days = Array.from({ length: 92 }, (_, i) => addDays('2026-01-01', i));
    dialerSecondsByUserDay([], [], days, new Date('2026-04-03T00:00:00Z'));
    expect(spy.mock.calls.length).toBeLessThanOrEqual(93);
    spy.mockRestore();
  });

  it('an empty day list does no work and returns no rows', () => {
    const spy = vi.spyOn(orgDay, 'orgMidnightUtc');
    expect(dialerSecondsByUserDay([{ userId: 'u1', joinedAt: new Date(), endedAt: null }], [], [], new Date())).toEqual({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('assembleTalkTimeReport', () => {
  const r = range('2026-09-30', '2026-10-01');
  const names = [{ id: 'u1', name: 'Garrett Martorello' }, { id: 'u2', name: 'Norah Lee' }];
  const talk = [
    { userId: 'u1', day: '2026-09-30', source: 'outbound' as const, calls: 3, seconds: 600 },
    { userId: 'u1', day: '2026-10-01', source: 'powerDial' as const, calls: 2, seconds: 900 },
    { userId: 'u1', day: '2026-10-01', source: 'inbound' as const, calls: 1, seconds: 120 },
    { userId: 'u2', day: '2026-10-01', source: 'outbound' as const, calls: 5, seconds: 2400 },
  ];
  const dialer = { u1: { '2026-10-01': 5400 }, u3: { '2026-09-30': 60 } };

  it('one row per rep, highest talk time first, with per-source totals and per-day detail', () => {
    const report = assembleTalkTimeReport({ range: r, names, talk, dialer });
    expect(report).toMatchObject({ from: '2026-09-30', to: '2026-10-01', timezone: 'America/Los_Angeles' });
    expect(report.reps.map((x) => x.userId)).toEqual(['u2', 'u1', 'u3']);
    const u1 = report.reps.find((x) => x.userId === 'u1')!;
    expect(u1).toEqual({
      userId: 'u1',
      name: 'Garrett Martorello',
      talkSeconds: 1620,
      connectedCalls: 6,
      bySource: { outbound: { calls: 3, seconds: 600 }, powerDial: { calls: 2, seconds: 900 }, inbound: { calls: 1, seconds: 120 } },
      dialerSeconds: 5400,
      days: [
        { day: '2026-09-30', talkSeconds: 600, connectedCalls: 3, dialerSeconds: 0 },
        { day: '2026-10-01', talkSeconds: 1020, connectedCalls: 3, dialerSeconds: 5400 },
      ],
    });
  });

  it('a rep with only dialer time still appears; an unknown user id is named as such', () => {
    const u3 = assembleTalkTimeReport({ range: r, names, talk, dialer }).reps.find((x) => x.userId === 'u3')!;
    expect(u3).toMatchObject({ name: 'Unknown user', talkSeconds: 0, connectedCalls: 0, dialerSeconds: 60 });
  });

  it('totals sum the reps', () => {
    expect(assembleTalkTimeReport({ range: r, names, talk, dialer }).totals)
      .toEqual({ talkSeconds: 4020, connectedCalls: 11, dialerSeconds: 5460 });
  });

  it('nothing in the range → no reps, zero totals', () => {
    expect(assembleTalkTimeReport({ range: r, names: [], talk: [], dialer: {} }))
      .toMatchObject({ reps: [], totals: { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 } });
  });
});

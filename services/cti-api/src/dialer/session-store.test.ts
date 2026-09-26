import { describe, expect, it } from 'vitest';
import { missBreakdown, rolloverSummary, sessionCounts, skipBreakdown } from './session-store.js';

const item = (status: string) => ({ status } as Parameters<typeof sessionCounts>[0][number]);

describe('sessionCounts', () => {
  it('tallies queue item statuses', () => {
    const c = sessionCounts([
      item('done'), item('connected'), item('no_connect'), item('no_connect'),
      item('skipped'), item('unreachable'), item('pending'), item('dialing'),
    ]);
    expect(c).toMatchObject({ total: 8, done: 1, connected: 1, noConnect: 2, skipped: 1, unreachable: 1, pending: 1 });
  });

  // Review round 2 (Minor #5b): a take-callback cancel (`skipped` + `canceled`,
  // engine.ts `takeCallback`) shares its ordinal with the `pending` copy that
  // requeues the same person (`callbackRequeue`) — one person, counted once,
  // as whichever row now speaks for them, not as a skip AND a pending.
  it('a take-callback cancel and its requeue copy at the same ordinal count as ONE person, not two', () => {
    const c = sessionCounts([
      { status: 'done', ordinal: 0, outcome: 'connected' },
      { status: 'skipped', ordinal: 1, outcome: 'canceled' },
      { status: 'pending', ordinal: 1, outcome: null },
    ] as unknown as Parameters<typeof sessionCounts>[0]);
    expect(c).toMatchObject({ total: 2, done: 1, pending: 1, skipped: 0 });
  });

  it('…but a lone cancelled row (no sibling at its ordinal — should not normally happen) still counts rather than silently vanishing', () => {
    const c = sessionCounts([
      { status: 'skipped', ordinal: 5, outcome: 'canceled' },
    ] as unknown as Parameters<typeof sessionCounts>[0]);
    expect(c).toMatchObject({ total: 1, skipped: 1 });
  });

  it('a normal skip (no requeue copy at its ordinal) still counts as a skip', () => {
    const c = sessionCounts([
      { status: 'skipped', ordinal: 2, outcome: 'already_worked' },
    ] as unknown as Parameters<typeof sessionCounts>[0]);
    expect(c).toMatchObject({ total: 1, skipped: 1 });
  });
});

describe('skipBreakdown', () => {
  it('counts skipped rows per outcome and ignores non-skipped rows', () => {
    expect(skipBreakdown([
      { status: 'skipped', outcome: 'already_worked' },
      { status: 'skipped', outcome: 'already_worked' },
      { status: 'skipped', outcome: 'skip_on_dialer' },
      { status: 'skipped', outcome: null },
      { status: 'pending', outcome: null },
    ])).toEqual({ already_worked: 2, skip_on_dialer: 1, other: 1 });
  });

  // Same pairing as sessionCounts above, so the two stay consistent — the
  // module's own doc comment on tallyOutcomes asserts skipBreakdown's total
  // always matches sessionCounts(items).skipped.
  it('excludes a take-callback cancel that has its requeue copy, so the bucket total still matches counts.skipped', () => {
    const items = [
      { status: 'skipped', ordinal: 1, outcome: 'canceled' },
      { status: 'pending', ordinal: 1, outcome: null },
      { status: 'skipped', ordinal: 2, outcome: 'already_worked' },
    ];
    expect(skipBreakdown(items as unknown as Parameters<typeof skipBreakdown>[0])).toEqual({ already_worked: 1 });
  });
});

describe('missBreakdown', () => {
  it('counts no_connect rows per reason and ignores every other status', () => {
    expect(missBreakdown([
      { status: 'no_connect', outcome: 'voicemail' },
      { status: 'no_connect', outcome: 'voicemail' },
      { status: 'no_connect', outcome: 'no_answer' },
      { status: 'no_connect', outcome: null },
      { status: 'skipped', outcome: 'already_worked' },
      { status: 'done', outcome: 'connected' },
    ])).toEqual({ voicemail: 2, no_answer: 1, other: 1 });
  });
  it('is empty for a run with no misses', () => {
    expect(missBreakdown([{ status: 'pending', outcome: null }])).toEqual({});
  });
});

describe('rolloverSummary', () => {
  it('splits succeeded jobs into moved (next business day) vs pushed (later, by the cap)', () => {
    const s = rolloverSummary([
      { status: 'succeeded', targetDate: '2026-08-21', nextDay: '2026-08-21' },
      { status: 'succeeded', targetDate: '2026-08-24', nextDay: '2026-08-21' },
      { status: 'failed', targetDate: null, nextDay: '2026-08-21' },
      { status: 'pending', targetDate: null, nextDay: '2026-08-21' },
    ]);
    expect(s).toEqual({ moved: 1, pushed: 1, failed: 1, pending: 1 });
  });
  it('counts an in_flight job as pending too', () => {
    const s = rolloverSummary([{ status: 'in_flight', targetDate: null, nextDay: null }]);
    expect(s).toEqual({ moved: 0, pushed: 0, failed: 0, pending: 1 });
  });
  it('a no-task success (no targetDate) counts as neither moved nor pushed', () => {
    expect(rolloverSummary([{ status: 'succeeded', targetDate: null, nextDay: '2026-08-21' }])).toEqual({ moved: 0, pushed: 0, failed: 0, pending: 0 });
  });
});

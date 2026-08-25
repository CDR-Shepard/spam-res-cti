import { describe, expect, it } from 'vitest';
import { rolloverSummary, sessionCounts, skipBreakdown } from './session-store.js';

const item = (status: string) => ({ status } as Parameters<typeof sessionCounts>[0][number]);

describe('sessionCounts', () => {
  it('tallies queue item statuses', () => {
    const c = sessionCounts([
      item('done'), item('connected'), item('no_connect'), item('no_connect'),
      item('skipped'), item('unreachable'), item('pending'), item('dialing'),
    ]);
    expect(c).toMatchObject({ total: 8, done: 1, connected: 1, noConnect: 2, skipped: 1, unreachable: 1, pending: 1 });
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

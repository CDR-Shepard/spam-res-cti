import { describe, expect, it } from 'vitest';
import { rolloverSummary, sessionCounts } from './session-store.js';

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

describe('rolloverSummary', () => {
  const nextDay = (d: string) => (d === '2026-08-20' ? '2026-08-21' : 'x');
  it('splits succeeded jobs into moved (next business day) vs pushed (later, by the cap)', () => {
    const s = rolloverSummary([
      { status: 'succeeded', fromDate: '2026-08-20', targetDate: '2026-08-21' },
      { status: 'succeeded', fromDate: '2026-08-20', targetDate: '2026-08-24' },
      { status: 'failed', fromDate: '2026-08-20', targetDate: null },
      { status: 'pending', fromDate: '2026-08-20', targetDate: null },
    ], nextDay);
    expect(s).toEqual({ moved: 1, pushed: 1, failed: 1, pending: 1 });
  });
  it('a no-task success (no targetDate) counts as neither moved nor pushed', () => {
    expect(rolloverSummary([{ status: 'succeeded', fromDate: '2026-08-20', targetDate: null }], nextDay)).toEqual({ moved: 0, pushed: 0, failed: 0, pending: 0 });
  });
});

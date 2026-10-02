import { describe, expect, it } from 'vitest';
import { BACKOFF_MS, DIALER_TIME_WINDOW_DAYS, backoffMs, planDialerTimeWrites, windowDays, type SyncedRow, type WindowLeg } from './dialer-time-plan.js';

const MIN = 60_000;
// 2026-10-02 10:00 PDT = 17:00Z
const NOW = new Date('2026-10-02T17:00:00Z');
const DAYS = ['2026-09-30', '2026-10-01', '2026-10-02'];

function leg(userId: string, joined: string, ended: string | null, orgId = 'org1'): WindowLeg {
  return { orgId, userId, joinedAt: new Date(joined), endedAt: ended ? new Date(ended) : null };
}
function row(over: Partial<SyncedRow> & Pick<SyncedRow, 'userId' | 'day'>): SyncedRow {
  return { id: `row-${over.userId}-${over.day}`, orgId: 'org1', salesforceTaskId: '00TX', syncedSeconds: 0, attempts: 0, nextAttemptAt: new Date(0), ...over };
}

describe('windowDays', () => {
  it('is today and the two Pacific days before it', () => {
    expect(DIALER_TIME_WINDOW_DAYS).toBe(3);
    expect(windowDays(NOW)).toEqual(DAYS);
    // 2026-10-02 23:30 PDT is still Oct 2 in Pacific (06:30Z Oct 3)
    expect(windowDays(new Date('2026-10-03T06:30:00Z'))).toEqual(DAYS);
  });
});

describe('planDialerTimeWrites', () => {
  // Garrett: 09:00-09:30 PDT on Oct 2 = 1800 s
  const legs = [leg('g', '2026-10-02T16:00:00Z', '2026-10-02T16:30:00Z')];

  it('plans a create for a rep with time and no row yet', () => {
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [] })).toEqual([
      { orgId: 'org1', userId: 'g', day: '2026-10-02', seconds: 1800, row: null },
    ]);
  });

  it('plans nothing when the stored seconds already match', () => {
    const rows = [row({ userId: 'g', day: '2026-10-02', syncedSeconds: 1800 })];
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows })).toEqual([]);
  });

  it('plans an update when the seconds changed, carrying the row', () => {
    const r = row({ userId: 'g', day: '2026-10-02', syncedSeconds: 1200 });
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [r] })).toEqual([
      { orgId: 'org1', userId: 'g', day: '2026-10-02', seconds: 1800, row: r },
    ]);
  });

  it('skips a row whose backoff is not due yet', () => {
    const r = row({ userId: 'g', day: '2026-10-02', syncedSeconds: null, attempts: 2, nextAttemptAt: new Date(NOW.getTime() + MIN) });
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [r] })).toEqual([]);
  });

  it('counts an open leg up to now, and merges overlapping legs once', () => {
    const open = [
      leg('g', '2026-10-02T16:00:00Z', null), // 09:00 PDT → now (10:00) = 3600 s
      leg('g', '2026-10-02T16:10:00Z', '2026-10-02T16:20:00Z'), // inside the open one
    ];
    expect(planDialerTimeWrites({ legs: open, days: DAYS, now: NOW, rows: [] })[0]?.seconds).toBe(3600);
  });

  it('splits a leg across Pacific midnight onto both days', () => {
    // 23:50 PDT Oct 1 (06:50Z Oct 2) → 00:20 PDT Oct 2 (07:20Z) = 600 s + 1200 s
    const cross = [leg('g', '2026-10-02T06:50:00Z', '2026-10-02T07:20:00Z')];
    const planned = planDialerTimeWrites({ legs: cross, days: DAYS, now: NOW, rows: [] });
    expect(planned.map((p) => [p.day, p.seconds])).toEqual([
      ['2026-10-01', 600],
      ['2026-10-02', 1200],
    ]);
  });

  it('never creates for a zero-second day (no row, no Task id), even with other reps having real time', () => {
    const two = [leg('g', '2026-10-02T16:00:00Z', '2026-10-02T16:00:00Z'), leg('j', '2026-10-02T16:00:00Z', '2026-10-02T16:01:00Z', 'org2')];
    expect(planDialerTimeWrites({ legs: two, days: DAYS, now: NOW, rows: [] })).toEqual([
      { orgId: 'org2', userId: 'j', day: '2026-10-02', seconds: 60, row: null },
    ]);
  });

  it('corrects a synced Task back down to 0 when a later reconcile leaves that day at zero (I2)', () => {
    // 'g' dialed for real on Oct 1, but Oct 2's leg was reconciled to zero length —
    // a day that used to have real seconds synced to Salesforce must be corrected.
    const legs = [leg('g', '2026-10-01T16:00:00Z', '2026-10-01T16:30:00Z'), leg('g', '2026-10-02T16:00:00Z', '2026-10-02T16:00:00Z')];
    const r = row({ userId: 'g', day: '2026-10-02', salesforceTaskId: '00TX', syncedSeconds: 1800 });
    expect(planDialerTimeWrites({ legs, days: DAYS, now: NOW, rows: [r] })).toEqual([
      { orgId: 'org1', userId: 'g', day: '2026-10-01', seconds: 1800, row: null },
      { orgId: 'org1', userId: 'g', day: '2026-10-02', seconds: 0, row: r },
    ]);
  });

  it('never creates for 0: a corrected-to-zero row with no Task id yet is still skipped', () => {
    const r = row({ userId: 'g', day: '2026-10-02', salesforceTaskId: null, syncedSeconds: null });
    expect(planDialerTimeWrites({ legs: [], days: DAYS, now: NOW, rows: [r] })).toEqual([]);
  });

  it('corrects a synced Task to 0 for a rep with no legs left anywhere in the window (I2)', () => {
    // The rep has no legs at all in the 3-day window any more (e.g. all reconciled
    // away) — the row must still be found and corrected, not just skipped because
    // the rep has dropped out of dialerSecondsByUserDay's output entirely.
    const r = row({ userId: 'g', day: '2026-10-01', salesforceTaskId: '00TX', syncedSeconds: 900 });
    expect(planDialerTimeWrites({ legs: [], days: DAYS, now: NOW, rows: [r] })).toEqual([
      { orgId: 'org1', userId: 'g', day: '2026-10-01', seconds: 0, row: r },
    ]);
  });

  it('does not correct to 0 when the row is already 0, or its backoff is not due', () => {
    const synced = row({ userId: 'g', day: '2026-10-01', salesforceTaskId: '00TX', syncedSeconds: 0 });
    const backedOff = row({ userId: 'j', day: '2026-10-01', salesforceTaskId: '00TY', syncedSeconds: 900, nextAttemptAt: new Date(NOW.getTime() + MIN) });
    expect(planDialerTimeWrites({ legs: [], days: DAYS, now: NOW, rows: [synced, backedOff] })).toEqual([]);
  });
});

describe('backoffMs', () => {
  it('walks 5m, 15m, 1h, 3h, 6h and then stays at 6h', () => {
    expect(BACKOFF_MS).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN]);
    expect([1, 2, 3, 4, 5, 6, 50].map(backoffMs)).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 180 * MIN, 360 * MIN, 360 * MIN, 360 * MIN]);
  });
});

import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { BUILD_SKIP_OUTCOMES } from './create-session.js';
import type { DialerItem } from './session-store.js';
import {
  claimReadySessionQuery,
  runPosition,
  runSizeCutoff,
  saveRunDefaultsQuery,
  savedRolloverBusinessDays,
  savedRolloverBusinessDaysQuery,
  settledAtBuild,
  trimQueueQuery,
} from './run-settings.js';

// Never connects: drizzle only needs the dialect to render SQL (the house
// idiom — sms/inbound-text-worker.test.ts, salesforce/permission-set-live.test.ts).
const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
const NOW = new Date('2026-09-28T17:00:00Z');

describe('runSizeCutoff — the last row a run of N people keeps', () => {
  const row = (ordinal: number, status: DialerItem['status']) => ({ ordinal, status });
  // Dialable (pending) ordinals: 1, 3, 4, 6. Settled at build: 0, 2, 5.
  const queue = [
    row(0, 'skipped'), row(1, 'pending'), row(2, 'unreachable'), row(3, 'pending'),
    row(4, 'pending'), row(5, 'skipped'), row(6, 'pending'),
  ];

  it('All (null) keeps every row', () => {
    expect(runSizeCutoff(queue, null)).toBeNull();
  });
  it('N counts DIALABLE rows only: the 2nd pending row is ordinal 3', () => {
    expect(runSizeCutoff(queue, 2)).toBe(3);
  });
  it('N = 1 keeps the settled rows in front of the first person', () => {
    expect(runSizeCutoff(queue, 1)).toBe(1);
  });
  it('no more dialable rows than N keeps everything', () => {
    expect(runSizeCutoff(queue, 4)).toBeNull();
    expect(runSizeCutoff(queue, 500)).toBeNull();
  });
  it('queue order is ordinal order, whatever order the rows were read in', () => {
    expect(runSizeCutoff([...queue].reverse(), 3)).toBe(4);
  });
});

describe('the run-settings SQL Postgres receives', () => {
  // Review M1: run_size — min(maxRecords, pending rows), computed by the
  // caller (engine.ts claimReadySession) — rides the SAME claim update as
  // passes/maxRecords/rolloverBusinessDays.
  it('the claim flips ready → active and writes the four settings — including run_size — in the SAME update', () => {
    const { sql, params } = claimReadySessionQuery(db, 'S1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }, NOW, 50).toSQL();
    expect(sql).toBe(
      'update "dialer_sessions" set "status" = $1, "passes" = $2, "max_records" = $3, "rollover_business_days" = $4, "run_size" = $5, "updated_at" = $6 ' +
        'where ("dialer_sessions"."id" = $7 and "dialer_sessions"."status" = $8) returning "id", "user_id"',
    );
    expect(params).toEqual(['active', 1, 100, 2, 50, NOW.toISOString(), 'S1', 'ready']);
  });

  it("a Start with no settings flips the status only — the columns keep today's defaults", () => {
    const { sql, params } = claimReadySessionQuery(db, 'S1', null, NOW).toSQL();
    expect(sql).toBe(
      'update "dialer_sessions" set "status" = $1, "updated_at" = $2 ' +
        'where ("dialer_sessions"."id" = $3 and "dialer_sessions"."status" = $4) returning "id", "user_id"',
    );
    expect(params).toEqual(['active', NOW.toISOString(), 'S1', 'ready']);
  });

  it('All writes max_records NULL', () => {
    expect(claimReadySessionQuery(db, 'S1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }, NOW, null).toSQL().params)
      .toEqual(['active', 2, null, 1, null, NOW.toISOString(), 'S1', 'ready']);
  });

  it('an unlimited run (settings present, maxRecords null) also writes run_size NULL — the default omitted-runSize call', () => {
    // `runSize` defaults to null when the caller omits it (an unlimited Start
    // never computes one — engine.ts only reads the queue for a limited run).
    expect(claimReadySessionQuery(db, 'S1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }, NOW).toSQL().params)
      .toEqual(['active', 2, null, 1, null, NOW.toISOString(), 'S1', 'ready']);
  });

  it("the trim deletes only THIS run's rows past the cutoff ordinal", () => {
    const { sql, params } = trimQueueQuery(db, 'S1', 3).toSQL();
    expect(sql).toBe('delete from "dialer_queue_items" where ("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."ordinal" > $2)');
    expect(params).toEqual(['S1', 3]);
  });

  // Controller ruling S2: "How many" is remembered too — saveRunDefaultsQuery
  // now writes THREE columns onto users, not two.
  it("saving the defaults writes Calls per person, How many, and Missed tasks for ONE user", () => {
    const { sql, params } = saveRunDefaultsQuery(db, 'U1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }).toSQL();
    expect(sql).toBe('update "users" set "dialer_passes" = $1, "dialer_max_records" = $2, "dialer_rollover_business_days" = $3 where "users"."id" = $4');
    expect(params).toEqual([1, 100, 2, 'U1']);
  });

  it('saving All (null) writes NULL for dialer_max_records — null round-trips', () => {
    const { sql, params } = saveRunDefaultsQuery(db, 'U1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }).toSQL();
    expect(sql).toBe('update "users" set "dialer_passes" = $1, "dialer_max_records" = $2, "dialer_rollover_business_days" = $3 where "users"."id" = $4');
    expect(params).toEqual([2, null, 1, 'U1']);
  });

  it("the click-to-dial read takes ONE user's saved Missed-tasks choice", () => {
    const { sql, params } = savedRolloverBusinessDaysQuery(db, 'U1').toSQL();
    expect(sql).toBe('select "dialer_rollover_business_days" from "users" where "users"."id" = $1 limit $2');
    expect(params).toEqual(['U1', 1]);
  });
});

describe('savedRolloverBusinessDays', () => {
  const fake = (rows: unknown[]) =>
    ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }) }) as unknown as Parameters<typeof savedRolloverBusinessDays>[0];

  it("reads the rep's saved choice", async () => {
    await expect(savedRolloverBusinessDays(fake([{ businessDays: 2 }]), 'U1')).resolves.toBe(2);
    await expect(savedRolloverBusinessDays(fake([{ businessDays: 1 }]), 'U1')).resolves.toBe(1);
  });

  it("a missing row is today's rule: the next business day", async () => {
    await expect(savedRolloverBusinessDays(fake([]), 'U1')).resolves.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Review M1 (ruling: fix it): "record X of N" for a LIMITED run must count
// only the people this run actually dials — the settled rows (skip,
// unreachable, consent-blocked) the queue keeps in front of the cutoff must
// not count. `settledAtBuild` tells a build-time settle apart from a RUNTIME
// one (the cadence gate, take-callback); `runPosition` uses it to rank the
// current item among the row's this run will actually dial.
// ---------------------------------------------------------------------------
describe('settledAtBuild', () => {
  const row = (over: Partial<Pick<DialerItem, 'status' | 'outcome' | 'attempt' | 'redialOf'>>) =>
    ({ status: 'pending', outcome: null, attempt: 1, redialOf: null, ...over }) as Pick<DialerItem, 'status' | 'outcome' | 'attempt' | 'redialOf'>;

  it('unreachable (no number at build) settled at build', () => {
    expect(settledAtBuild(row({ status: 'unreachable', outcome: null }))).toBe(true);
  });

  it('every BUILD-time skip outcome settled at build', () => {
    for (const outcome of BUILD_SKIP_OUTCOMES) {
      expect(settledAtBuild(row({ status: 'skipped', outcome }))).toBe(true);
    }
  });

  it('a RUNTIME skip (the cadence gate, or a take-callback cancel) did NOT settle at build — the person WAS going to be dialed', () => {
    for (const outcome of ['cooldown', 'daily_cap', 'canceled']) {
      expect(settledAtBuild(row({ status: 'skipped', outcome }))).toBe(false);
    }
  });

  it('pending, dialing, connected, no_connect, and done rows never settled at build', () => {
    for (const status of ['pending', 'dialing', 'connected', 'no_connect', 'done'] as const) {
      expect(settledAtBuild(row({ status, outcome: null }))).toBe(false);
    }
  });

  it('an appended row (an attempt-2 retry, or a redial copy) never settled at build — it did not exist at build to have settled', () => {
    expect(settledAtBuild(row({ attempt: 2, status: 'skipped', outcome: 'skip_on_dialer' }))).toBe(false);
    expect(settledAtBuild(row({ redialOf: 'i0', status: 'skipped', outcome: 'skip_on_dialer' }))).toBe(false);
  });
});

describe('runPosition', () => {
  const row = (ordinal: number, over: Partial<Pick<DialerItem, 'status' | 'outcome' | 'attempt' | 'redialOf'>> = {}) =>
    ({ ordinal, status: 'pending', outcome: null, attempt: 1, redialOf: null, ...over }) as Pick<DialerItem, 'ordinal' | 'status' | 'outcome' | 'attempt' | 'redialOf'>;

  it('null for an unlimited run — "record X of N" only makes sense once N is capped', () => {
    expect(runPosition([row(0)], 0, null)).toBeNull();
  });

  it('5 inherited (build-time) skips plus a limited "first 100" run: the 3rd pending row reads position 3 of 100', () => {
    const skips = Array.from({ length: 5 }, (_, i) => row(i, { status: 'skipped', outcome: 'skip_on_dialer' }));
    const pendings = Array.from({ length: 100 }, (_, i) => row(5 + i));
    const items = [...skips, ...pendings];
    const runSize = 100;
    expect(runPosition(items, 7, runSize)).toBe(3); // ordinal 5+2, the 3rd pending row
    expect(runPosition(items, 5, runSize)).toBe(1); // the FIRST pending row — the 5 skips ahead of it don't count
    expect(runPosition(items, 104, runSize)).toBe(100); // the LAST pending row
  });

  it('a RUNTIME skip (the cadence gate) still counts toward the position — only BUILD-time settles are excluded', () => {
    const items = [
      row(0, { status: 'skipped', outcome: 'skip_on_dialer' }), // build-time — excluded
      row(1, { status: 'skipped', outcome: 'cooldown' }), // runtime — counted
      row(2, { status: 'dialing' }),
    ];
    expect(runPosition(items, 2, 2)).toBe(2);
  });

  it('an appended attempt-2 retry counts toward the position — it never settled at build', () => {
    const items = [
      row(0, { status: 'no_connect', outcome: 'voicemail' }),
      row(1, { status: 'dialing', attempt: 2 }), // the retry, appended past the build range
    ];
    expect(runPosition(items, 1, 1)).toBe(2);
  });

  it('rows past the current ordinal never count, even if they would otherwise qualify', () => {
    const items = [row(0), row(1), row(2)];
    expect(runPosition(items, 1, 3)).toBe(2);
  });
});

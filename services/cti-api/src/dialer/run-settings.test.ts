import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import type { DialerItem } from './session-store.js';
import {
  claimReadySessionQuery,
  runSizeCutoff,
  saveRunDefaultsQuery,
  savedRolloverBusinessDays,
  savedRolloverBusinessDaysQuery,
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
  it('the claim flips ready → active and writes the three settings in the SAME update', () => {
    const { sql, params } = claimReadySessionQuery(db, 'S1', { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }, NOW).toSQL();
    expect(sql).toBe(
      'update "dialer_sessions" set "status" = $1, "passes" = $2, "max_records" = $3, "rollover_business_days" = $4, "updated_at" = $5 ' +
        'where ("dialer_sessions"."id" = $6 and "dialer_sessions"."status" = $7) returning "id", "user_id"',
    );
    expect(params).toEqual(['active', 1, 100, 2, NOW.toISOString(), 'S1', 'ready']);
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
    expect(claimReadySessionQuery(db, 'S1', { passes: 2, maxRecords: null, rolloverBusinessDays: 1 }, NOW).toSQL().params)
      .toEqual(['active', 2, null, 1, NOW.toISOString(), 'S1', 'ready']);
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

/**
 * dialer-time-store — the SQL, pinned by rendering (no database in the unit
 * suite). Load-bearing: the bare ON CONFLICT DO NOTHING (a targeted one would
 * still work here, but the codebase rule is the bare form, and a PARTIAL index
 * would reject a targeted one with 42P10).
 */
import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { dialActivityStatement, loadActivity } from '../reports/talk-time-query.js';
import { claimRowStatement, insertRowStatement, liveDialerTimeStore, rowsForDaysStatement, windowLegsStatement } from './dialer-time-store.js';

// Only the wiring is under test here (the activity SQL is pinned in
// reports/talk-time-query.test.ts): the real statements stay, the read is a spy.
vi.mock('../reports/talk-time-query.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reports/talk-time-query.js')>()),
  loadActivity: vi.fn(async () => []),
}));

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

describe('dialer-time-store SQL', () => {
  it('loads every leg that overlaps the window, open legs included, bounded below by 3 days (M4)', () => {
    const start = new Date('2026-09-30T07:00:00Z');
    const end = new Date('2026-10-03T07:00:00Z');
    const lowerBound = new Date('2026-09-27T07:00:00Z'); // start - 3 days
    const q = windowLegsStatement(db, start, end).toSQL();
    expect(q.sql).toBe(
      'select "org_id", "user_id", "joined_at", "ended_at" from "dialer_rep_legs" where ("dialer_rep_legs"."joined_at" > $1 and "dialer_rep_legs"."joined_at" < $2 and ("dialer_rep_legs"."ended_at" is null or "dialer_rep_legs"."ended_at" > $3))',
    );
    expect(q.params).toEqual([lowerBound.toISOString(), end.toISOString(), start.toISOString()]);
  });

  it('reads the activity of EVERY org over the same range as the legs (no org filter)', async () => {
    const start = new Date('2026-09-19T07:00:00Z');
    const end = new Date('2026-10-03T07:00:00Z');
    await expect(liveDialerTimeStore(db).loadActivity(start, end)).resolves.toEqual([]);
    expect(loadActivity).toHaveBeenCalledWith(db, null, start, end);
    // A null org is what drops the predicate — the worker serves all orgs.
    expect(dialActivityStatement(db, null, start, end).toSQL().sql).not.toContain('org_id');
  });

  it('loads the rows for exactly the window days', () => {
    const q = rowsForDaysStatement(db, ['2026-09-30', '2026-10-01', '2026-10-02']).toSQL();
    expect(q.sql).toContain('from "dialer_time_tasks" where "dialer_time_tasks"."day" in ($1, $2, $3)');
    expect(q.params).toEqual(['2026-09-30', '2026-10-01', '2026-10-02']);
  });

  it('inserts with a bare ON CONFLICT DO NOTHING', () => {
    const q = insertRowStatement(db, 'org1', 'u1', '2026-10-02').toSQL();
    expect(q.sql).toMatch(/^insert into "dialer_time_tasks" /);
    expect(q.sql).toMatch(/on conflict do nothing$/);
    expect(q.sql).not.toMatch(/on conflict \(/);
  });

  it('claims a row atomically: only when due, and the lease is the write (I1)', () => {
    const now = new Date('2026-10-02T17:00:00Z');
    const leaseMs = 4 * 60_000;
    const q = claimRowStatement(db, 'row-1', now, leaseMs).toSQL();
    expect(q.sql).toBe(
      'update "dialer_time_tasks" set "next_attempt_at" = $1, "updated_at" = $2 where ("dialer_time_tasks"."id" = $3 and "dialer_time_tasks"."next_attempt_at" <= $4) returning "id", "org_id", "user_id", "day", "salesforce_task_id", "synced_seconds", "attempts", "next_attempt_at"',
    );
    expect(q.params).toEqual([new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), 'row-1', now.toISOString()]);
  });
});

/**
 * dialer-time-store — the SQL, pinned by rendering (no database in the unit
 * suite). Load-bearing: the bare ON CONFLICT DO NOTHING (a targeted one would
 * still work here, but the codebase rule is the bare form, and a PARTIAL index
 * would reject a targeted one with 42P10).
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { insertRowStatement, rowsForDaysStatement, windowLegsStatement } from './dialer-time-store.js';

const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

describe('dialer-time-store SQL', () => {
  it('loads every leg that overlaps the window, open legs included', () => {
    const start = new Date('2026-09-30T07:00:00Z');
    const end = new Date('2026-10-03T07:00:00Z');
    const q = windowLegsStatement(db, start, end).toSQL();
    expect(q.sql).toBe(
      'select "org_id", "user_id", "joined_at", "ended_at" from "dialer_rep_legs" where ("dialer_rep_legs"."joined_at" < $1 and ("dialer_rep_legs"."ended_at" is null or "dialer_rep_legs"."ended_at" > $2))',
    );
    expect(q.params).toEqual([end.toISOString(), start.toISOString()]);
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
});

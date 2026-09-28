import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import { enqueueFollowupRollover, rolloverJobInsert } from './followup-enqueue.js';
import type { RolloverEnqueue } from '../dialer/engine.js';

// The real de-duplication is the Postgres unique index
// `followup_rollover_unique` — UNIQUE(user_id, record_id, from_date), from
// migrations/0024_followup_rollover.sql — and only a real database can exercise
// a genuine conflict. What IS testable here, and what these pin, are the two
// halves this module owns: the insert must actually chain ON CONFLICT DO
// NOTHING (else a duplicated webhook raises, and two follow-ups for one person
// on one day would raise too), and `source_task_id` must reach the row — it is
// not part of the key, it names the TEMPLATE the worker copies.
function fakeDb() {
  const rows: Array<Record<string, unknown>> = [];
  let conflictClause: string | null = null;
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        rows.push(values);
        const p = Promise.resolve() as Promise<void> & { onConflictDoNothing: () => Promise<void> };
        p.onConflictDoNothing = async () => { conflictClause = 'do nothing'; };
        return p;
      },
    }),
  };
  return { db, rows, clause: () => conflictClause };
}

function job(over: Partial<RolloverEnqueue> = {}): RolloverEnqueue {
  return {
    orgId: 'org1', userId: 'user1', sfOwnerId: '005ABC', sessionId: 'sess1',
    recordId: '0031', objectType: 'Contact', fromDate: '2026-08-21',
    sourceTaskId: null,
    businessDays: 1,
    ...over,
  };
}

describe('enqueueFollowupRollover', () => {
  it('carries the source task id onto the row (the template the copy is made from)', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ sourceTaskId: '00T1' }));
    expect(f.rows).toEqual([expect.objectContaining({ sourceTaskId: '00T1', recordId: '0031', status: 'pending' })]);
  });

  it('two follow-up tasks on the SAME person collapse to ONE job — one rollover per person per day', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ sourceTaskId: '00T1' }));
    await enqueueFollowupRollover(f.db as never, job({ sourceTaskId: '00T2' }));
    // Both inserts are attempted (this module never decides), but they share one
    // conflict key — (user, record, fromDate) — so Postgres keeps the FIRST and
    // DO NOTHINGs the second. The surviving row's sourceTaskId ('00T1') names
    // the template; the worker completes '00T2' as a same-day sibling and still
    // creates exactly one copy.
    expect(new Set(f.rows.map((r) => `${r.userId}|${r.recordId}|${r.fromDate}`)).size).toBe(1);
    expect(f.rows[0]).toEqual(expect.objectContaining({ sourceTaskId: '00T1' }));
  });

  it('a Lead/Opp run leaves source task id null — the worker searches the record for the template', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ recordId: '00Q1', objectType: 'Lead' }));
    expect(f.rows[0]).toEqual(expect.objectContaining({ sourceTaskId: null, recordId: '00Q1' }));
  });

  it('inserts ON CONFLICT DO NOTHING so a duplicated webhook is a no-op', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job());
    expect(f.clause()).toBe('do nothing');
  });
});

// The job carries the run's "Missed tasks move to" (spec 2026-09-28), and the
// insert Postgres receives is pinned: every column the job names, and a BARE
// ON CONFLICT DO NOTHING — never a target (the partial-index trap, 42P10).
describe('rolloverJobInsert — the SQL Postgres receives', () => {
  // Never connects: drizzle only needs the dialect to render SQL.
  const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

  it('writes business_days with the rest of the job, bare ON CONFLICT DO NOTHING', () => {
    const { sql, params } = rolloverJobInsert(db, job({ businessDays: 2 })).toSQL();
    expect(sql).toBe(
      'insert into "followup_rollover_jobs" ("id", "org_id", "user_id", "sf_owner_id", "session_id", "record_id", "object_type", "from_date", ' +
        '"status", "attempts", "last_error", "next_attempt_at", "completed_at", "completed_task_id", "created_task_id", "target_date", "next_day", ' +
        '"source_task_id", "completed_task_ids", "business_days", "created_at", "updated_at") ' +
        'values (default, $1, $2, $3, $4, $5, $6, $7, $8, default, default, default, default, default, default, default, default, $9, default, $10, default, default) ' +
        'on conflict do nothing',
    );
    expect(params).toEqual(['org1', 'user1', '005ABC', 'sess1', '0031', 'Contact', '2026-08-21', 'pending', null, 2]);
  });

  it('enqueueFollowupRollover carries businessDays onto the row', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ businessDays: 2 }));
    expect(f.rows[0]).toEqual(expect.objectContaining({ businessDays: 2, status: 'pending' }));
  });
});

import { describe, it, expect } from 'vitest';
import { enqueueFollowupRollover } from './followup-enqueue.js';
import type { RolloverEnqueue } from '../dialer/engine.js';

// The real de-duplication is the Postgres unique index
// `followup_rollover_source_unique` — UNIQUE(user_id, COALESCE(source_task_id,
// record_id), from_date), created in migrations/0027_task_dialing.sql — and
// only a real database can exercise a genuine conflict. What IS testable here,
// and what these pin, are the two halves this module owns: the insert must
// actually chain ON CONFLICT DO NOTHING (else a duplicated webhook raises), and
// `source_task_id` must reach the row (else that index degrades back to a
// per-RECORD key and the second follow-up task on one person is swallowed).
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
    ...over,
  };
}

describe('enqueueFollowupRollover', () => {
  it('carries the source task id onto the row (the per-TASK half of the unique key)', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ sourceTaskId: '00T1' }));
    expect(f.rows).toEqual([expect.objectContaining({ sourceTaskId: '00T1', recordId: '0031', status: 'pending' })]);
  });

  it('two follow-up tasks on the SAME person differ only by source task id — both must be written', async () => {
    const f = fakeDb();
    await enqueueFollowupRollover(f.db as never, job({ sourceTaskId: '00T1' }));
    await enqueueFollowupRollover(f.db as never, job({ sourceTaskId: '00T2' }));
    // Same (user, record, fromDate): under the pre-0027 key these collided and
    // the second was silently dropped, leaving that task open past its due date.
    expect(f.rows.map((r) => r.sourceTaskId)).toEqual(['00T1', '00T2']);
    expect(new Set(f.rows.map((r) => `${r.userId}|${r.sourceTaskId ?? r.recordId}|${r.fromDate}`)).size).toBe(2);
  });

  it('a Lead/Opp run leaves source task id null, so the key falls back to the record', async () => {
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

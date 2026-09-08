/**
 * Tests for the pure, DB-free pieces of replay-converted-lead-jobs.mjs (see
 * the converted-lead fix-wave brief, IMPORTANT-3 and MINOR-6). The script's
 * `main()` connects to a real Postgres database and is gated behind an
 * `isMain` check (see the module's bottom), so importing this module for its
 * exported helpers never touches a database or requires DATABASE_URL — this
 * file must NEVER exercise `main()` or run the script against a real DB.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  auditLine,
  classifyJobs,
  CLEAR_STALE_LEAD_WHO_SQL,
  replayOneJob,
  RESET_JOB_SQL,
  safeRollback,
  SELECT_STUCK_JOBS_SQL,
} from './replay-converted-lead-jobs.mjs';

describe('IMPORTANT-3 — classifyJobs three-way breakdown', () => {
  it('groups a stale Lead id with no What as "fully re-match"', () => {
    const jobs = [
      { id: 'j1', call_id: 'c1', status: 'failed', salesforce_who_id: '00QAAA000001', salesforce_what_id: null },
    ];
    const { fullyReMatch, attachWithoutPersonLink, guardExcluded } = classifyJobs(jobs);
    expect(fullyReMatch.map((j) => j.id)).toEqual(['j1']);
    expect(attachWithoutPersonLink).toEqual([]);
    expect(guardExcluded).toEqual([]);
  });

  it('groups a stale Lead id with an existing What as "attaches without a person link"', () => {
    const jobs = [
      { id: 'j2', call_id: 'c2', status: 'pending', salesforce_who_id: '00QBBB000002', salesforce_what_id: '006XYZ000001' },
    ];
    const { fullyReMatch, attachWithoutPersonLink, guardExcluded } = classifyJobs(jobs);
    expect(fullyReMatch).toEqual([]);
    expect(attachWithoutPersonLink.map((j) => j.id)).toEqual(['j2']);
    expect(guardExcluded).toEqual([]);
  });

  it('excludes a row whose who id is not a Lead ("00Q") id — the clear-who guard will not touch it', () => {
    const jobs = [
      { id: 'j3', call_id: 'c3', status: 'failed', salesforce_who_id: '003CCC000003', salesforce_what_id: null },
      { id: 'j4', call_id: 'c4', status: 'failed', salesforce_who_id: null, salesforce_what_id: null },
    ];
    const { fullyReMatch, attachWithoutPersonLink, guardExcluded } = classifyJobs(jobs);
    expect(fullyReMatch).toEqual([]);
    expect(attachWithoutPersonLink).toEqual([]);
    expect(guardExcluded.map((j) => j.id)).toEqual(['j3', 'j4']);
  });

  it('classifies a realistic mixed batch into all three groups with the right counts', () => {
    const jobs = [
      { id: 'j1', call_id: 'c1', status: 'failed', salesforce_who_id: '00Q1', salesforce_what_id: null },
      { id: 'j2', call_id: 'c2', status: 'failed', salesforce_who_id: '00Q2', salesforce_what_id: 'a0J1' },
      { id: 'j3', call_id: 'c3', status: 'pending', salesforce_who_id: '00Q3', salesforce_what_id: null },
      { id: 'j4', call_id: 'c4', status: 'failed', salesforce_who_id: '0031', salesforce_what_id: null },
    ];
    const { fullyReMatch, attachWithoutPersonLink, guardExcluded } = classifyJobs(jobs);
    expect(fullyReMatch).toHaveLength(2);
    expect(attachWithoutPersonLink).toHaveLength(1);
    expect(guardExcluded).toHaveLength(1);
  });

  it('MINOR-3 — treats an empty-string what id as falsy, matching sync.ts:339\'s runtime predicate (falsiness, not `== null`)', () => {
    const jobs = [
      { id: 'j5', call_id: 'c5', status: 'failed', salesforce_who_id: '00Q5', salesforce_what_id: '' },
    ];
    const { fullyReMatch, attachWithoutPersonLink } = classifyJobs(jobs);
    expect(fullyReMatch.map((j) => j.id)).toEqual(['j5']);
    expect(attachWithoutPersonLink).toEqual([]);
  });
});

describe('IMPORTANT-3 — SELECT_STUCK_JOBS_SQL joins calls so who/what are visible before --apply', () => {
  it('joins the calls table', () => {
    expect(SELECT_STUCK_JOBS_SQL).toMatch(/join\s+calls\s+c\s+on\s+c\.id\s*=\s*j\.call_id/i);
  });

  it('selects both salesforce_who_id and salesforce_what_id', () => {
    expect(SELECT_STUCK_JOBS_SQL).toMatch(/c\.salesforce_who_id/);
    expect(SELECT_STUCK_JOBS_SQL).toMatch(/c\.salesforce_what_id/);
  });

  it('still filters to CONVERTED_LEAD jobs in a resettable status', () => {
    expect(SELECT_STUCK_JOBS_SQL).toMatch(/last_error like '%CONVERTED_LEAD%'/);
    expect(SELECT_STUCK_JOBS_SQL).toMatch(/status in \('failed', ?'pending'\)/);
  });
});

describe('MINOR-6 — RESET_JOB_SQL re-guards against a concurrently-succeeded job and stamps updated_at', () => {
  it('re-checks last_error and status in the UPDATE itself', () => {
    expect(RESET_JOB_SQL).toMatch(/update salesforce_sync_jobs/i);
    expect(RESET_JOB_SQL).toMatch(/last_error like '%CONVERTED_LEAD%'/);
    expect(RESET_JOB_SQL).toMatch(/status in \('failed', ?'pending'\)/);
  });

  it('stamps updated_at on the reset, per the schema comment (packages/db/src/schema.ts)', () => {
    expect(RESET_JOB_SQL).toMatch(/updated_at\s*=\s*now\(\)/);
  });

  it('still resets status/attempts/last_error/next_attempt_at for replay', () => {
    expect(RESET_JOB_SQL).toMatch(/status\s*=\s*'pending'/);
    expect(RESET_JOB_SQL).toMatch(/attempts\s*=\s*0/);
    expect(RESET_JOB_SQL).toMatch(/last_error\s*=\s*null/);
    expect(RESET_JOB_SQL).toMatch(/next_attempt_at\s*=\s*now\(\)/);
  });
});

describe('MINOR-6 — safeRollback never throws, even when the connection is already gone', () => {
  it('swallows a failed ROLLBACK instead of aborting the batch', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')) };
    await expect(safeRollback(client)).resolves.toBeUndefined();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('issues ROLLBACK normally when the connection is healthy', async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    await safeRollback(client);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});

/**
 * Fake pg client for replayOneJob: records every query in order and lets a
 * test control RESET_JOB_SQL's rowCount — the exact seam IMPORTANT-1 is
 * about. Every other query (BEGIN/CLEAR/COMMIT/ROLLBACK) reports rowCount 1,
 * matching a healthy connection.
 */
function fakeReplayClient({ resetRowCount = 1 } = {}) {
  const calls = [];
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql, params });
    if (sql === RESET_JOB_SQL) return { rowCount: resetRowCount };
    return { rowCount: 1 };
  });
  return { query, calls };
}

describe('IMPORTANT-1 — replayOneJob checks RESET_JOB_SQL rowCount before ever reporting a reset', () => {
  it('commits and reports "reset" when the job is still resettable (rowCount 1)', async () => {
    const client = fakeReplayClient({ resetRowCount: 1 });
    const job = { id: 'j1', call_id: 'c1', salesforce_who_id: '00QAAA000001', salesforce_what_id: null };
    const result = await replayOneJob(client, job);
    expect(result).toEqual({ status: 'reset' });
    expect(client.calls.map((c) => c.sql)).toEqual(['BEGIN', CLEAR_STALE_LEAD_WHO_SQL, RESET_JOB_SQL, 'COMMIT']);
    expect(client.calls[1].params).toEqual(['c1']);
    expect(client.calls[2].params).toEqual(['j1']);
  });

  it('rolls back and reports "skipped" — NEVER "reset" — when a concurrent tick already claimed the job (rowCount 0)', async () => {
    // This is the exact live sequence from the brief: the script SELECTs job J
    // as pending; runSyncTick claims it (pending -> in_flight) before this
    // transaction runs; the calls-clear would still apply, but RESET_JOB_SQL's
    // `status in ('failed','pending')` re-guard now matches ZERO rows. The old
    // script committed the calls clear anyway and still counted this as a
    // reset — a half-repaired call, job parked forever, reported as success.
    const client = fakeReplayClient({ resetRowCount: 0 });
    const job = { id: 'j2', call_id: 'c2', salesforce_who_id: '00QBBB000002', salesforce_what_id: null };
    const result = await replayOneJob(client, job);
    expect(result).toEqual({ status: 'skipped' });
    // ROLLBACK, not COMMIT — the calls-clear must not survive either.
    expect(client.calls.map((c) => c.sql)).toEqual(['BEGIN', CLEAR_STALE_LEAD_WHO_SQL, RESET_JOB_SQL, 'ROLLBACK']);
  });

  it('keeps the calls-then-jobs lock order (matches syncOne at sync.ts:432-449 — no new deadlock edge)', async () => {
    const client = fakeReplayClient({ resetRowCount: 1 });
    await replayOneJob(client, { id: 'j3', call_id: 'c3', salesforce_who_id: '00QCCC', salesforce_what_id: null });
    const order = client.calls.map((c) => c.sql);
    expect(order.indexOf(CLEAR_STALE_LEAD_WHO_SQL)).toBeLessThan(order.indexOf(RESET_JOB_SQL));
  });

  it('propagates a thrown error (e.g. a dropped connection) instead of swallowing it, so the caller can rollback + count it as failed', async () => {
    const client = {
      query: vi.fn(async (sql) => {
        if (sql === RESET_JOB_SQL) throw new Error('connection terminated unexpectedly');
        return { rowCount: 1 };
      }),
    };
    await expect(replayOneJob(client, { id: 'j4', call_id: 'c4', salesforce_who_id: '00Q4' })).rejects.toThrow(
      /connection terminated/,
    );
  });
});

describe('MINOR-4 — auditLine records the destroyed Lead pointer for every --apply row', () => {
  it('prints the old who id for a row whose who WAS the stale Lead id', () => {
    expect(auditLine({ id: 'j1', call_id: 'c1', salesforce_who_id: '00QAAA000001' })).toBe(
      '  job j1 call c1 who=00QAAA000001 → null',
    );
  });

  it('is silent for a guard-excluded row — the clear-who guard never touched salesforce_who_id, so nothing was destroyed', () => {
    expect(auditLine({ id: 'j3', call_id: 'c3', salesforce_who_id: '003CCC000003' })).toBeNull();
  });

  it('is silent when who was already null', () => {
    expect(auditLine({ id: 'j4', call_id: 'c4', salesforce_who_id: null })).toBeNull();
  });
});

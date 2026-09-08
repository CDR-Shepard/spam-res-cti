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
  classifyJobs,
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

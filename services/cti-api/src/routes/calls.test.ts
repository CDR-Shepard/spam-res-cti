import { describe, expect, it } from 'vitest';
import { syncErrorForJob } from './calls.js';

// The raw shape GET /calls gets back from salesforce_sync_jobs.
const SOQL_DUMP = 'SOQL failed (400): [{"message":"No such column","errorCode":"INVALID_FIELD"}]';

describe('syncErrorForJob', () => {
  it('surfaces the deliberate skip once the job is done', () => {
    expect(syncErrorForJob({ status: 'succeeded', lastError: 'not-owner' })).toBe('not-owner');
  });

  it('surfaces the terminal failure reason', () => {
    expect(syncErrorForJob({ status: 'failed', lastError: SOQL_DUMP })).toBe(SOQL_DUMP);
  });

  it('says nothing while the job is still retrying or in flight', () => {
    expect(syncErrorForJob({ status: 'pending', lastError: SOQL_DUMP })).toBeNull();
    expect(syncErrorForJob({ status: 'in_flight', lastError: SOQL_DUMP })).toBeNull();
  });

  it('is null for a clean sync and for a call with no job at all', () => {
    expect(syncErrorForJob({ status: 'succeeded', lastError: null })).toBeNull();
    expect(syncErrorForJob(undefined)).toBeNull();
  });
});

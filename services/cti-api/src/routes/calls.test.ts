import { describe, expect, it } from 'vitest';
import { syncErrorForCall } from './calls.js';

// The raw shape GET /calls gets back from salesforce_sync_jobs.
const SOQL_DUMP = 'SOQL failed (400): [{"message":"No such column","errorCode":"INVALID_FIELD"}]';
const NO_TASK = { salesforceTaskId: null };

describe('syncErrorForCall', () => {
  it('surfaces the deliberate skip once the job is done', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: 'not-owner' })).toBe('not-owner');
  });

  it('surfaces the terminal failure reason', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'failed', lastError: SOQL_DUMP })).toBe(SOQL_DUMP);
  });

  it('says nothing while the job is still retrying or in flight', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'pending', lastError: SOQL_DUMP })).toBeNull();
    expect(syncErrorForCall(NO_TASK, { status: 'in_flight', lastError: SOQL_DUMP })).toBeNull();
  });

  it('is null for a clean sync and for a call with no job at all', () => {
    expect(syncErrorForCall(NO_TASK, { status: 'succeeded', lastError: null })).toBeNull();
    expect(syncErrorForCall(NO_TASK, undefined)).toBeNull();
  });

  it('says nothing when the Task exists, however the job got there', () => {
    // Jobs written before the success path started clearing lastError still
    // carry the error of an attempt that later succeeded. The call has its Task.
    expect(syncErrorForCall({ salesforceTaskId: '00T1' }, { status: 'succeeded', lastError: SOQL_DUMP })).toBeNull();
    expect(syncErrorForCall({ salesforceTaskId: '00T1' }, { status: 'failed', lastError: SOQL_DUMP })).toBeNull();
  });
});

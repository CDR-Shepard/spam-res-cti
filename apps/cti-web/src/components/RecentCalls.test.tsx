import { describe, expect, it } from 'vitest';
import { recentSyncLabel } from './RecentCalls';
describe('recentSyncLabel', () => {
  it('explains a gated call instead of a bare "Local"', () => {
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: 'not-owner' })).toBe('Not synced · not owner');
    expect(recentSyncLabel({ salesforceTaskId: '00T1', syncError: null })).toBe('Synced');
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: null })).toBe('Local');
  });

  it('says a give-up is a give-up, not "Local"', () => {
    // The sync job exhausted its retries: this call will never reach Salesforce
    // on its own. "Local" reads like "not yet" and left the rep waiting for a
    // Task that is not coming.
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: 'failed' })).toBe('Not synced · failed');
    // A Task that exists outranks any stale reason on the job.
    expect(recentSyncLabel({ salesforceTaskId: '00T1', syncError: 'failed' })).toBe('Synced');
  });
});

import { describe, expect, it } from 'vitest';
import { recentSyncLabel } from './RecentCalls';
describe('recentSyncLabel', () => {
  it('explains a gated call instead of a bare "Local"', () => {
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: 'not-owner' })).toBe('Not synced · not owner');
    expect(recentSyncLabel({ salesforceTaskId: '00T1', syncError: null })).toBe('Synced');
    expect(recentSyncLabel({ salesforceTaskId: null, syncError: null })).toBe('Local');
  });
});

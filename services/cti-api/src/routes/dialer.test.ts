import { describe, expect, it } from 'vitest';

// The REAL schema the route parses with — imported, never mirrored. A local copy
// pinned a contract the route had already moved past ('Task' runs were missing).
import { StartBody } from './dialer.js';

describe('POST /dialer/sessions body validation', () => {
  it('accepts a Lead/Opportunity/Task list of SF ids and rejects junk', () => {
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['00Q000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Opportunity', recordIds: ['006000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Task', recordIds: ['00T000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Account', recordIds: ['00Q000000000001'] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: [] }).success).toBe(false);
  });

  it('rejects a right-length id that is not a Salesforce id shape', () => {
    // Length alone let punctuation through into a SOQL id list.
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['!!!!!!!!!!!!!!!'] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ["00Q0000000000'1"] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['00Q1'] }).success).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { callerMayCreateTaskOn, fetchOwnership, objectTypeForId } from './ownership.js';

const soqlQuery = vi.hoisted(() => vi.fn());
vi.mock('./client.js', () => ({ soqlQuery, soqlEscape: (v: string) => v }));

describe('objectTypeForId', () => {
  it('maps standard key prefixes; custom objects are "other"', () => {
    expect(objectTypeForId('00Q000000000001AAA')).toBe('Lead');
    expect(objectTypeForId('003000000000001')).toBe('Contact');
    expect(objectTypeForId('006000000000001')).toBe('Opportunity');
    expect(objectTypeForId('00T000000000001')).toBe('Task');
    expect(objectTypeForId('a0B000000000001')).toBe('other');
  });
});

describe('callerMayCreateTaskOn', () => {
  const me = '005ME';
  it('Lead / Contact: owner only', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X' }, me)).toBe(false);
    expect(callerMayCreateTaskOn({ type: 'Contact', ownerId: me }, me)).toBe(true);
  });
  it('Opportunity: owner OR Lead_Manager__c', () => {
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: '005X', leadManagerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: me, leadManagerId: null }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: '005X', leadManagerId: '005Y' }, me)).toBe(false);
  });
  it('Task: the assignee', () => {
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: me }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: '005X' }, me)).toBe(false);
  });
  it('objects the rule does not name are allowed', () => {
    expect(callerMayCreateTaskOn({ type: 'other', ownerId: '005X' }, me)).toBe(true);
  });
});

describe('fetchOwnership in an org without Lead_Manager__c', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(soqlQuery.mock.calls[n]?.[1] ?? '');

  const INVALID_FIELD = new Error(
    'SOQL failed (400): [{"message":"No such column \'Lead_Manager__c\'","errorCode":"INVALID_FIELD"}]',
  );

  it('learns the field is missing once and never re-issues the query it knows will fail', async () => {
    soqlQuery.mockReset();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First Opportunity: the two-field query 400s, the owner-only retry answers.
    soqlQuery.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ OwnerId: '005A' }]);
    expect(await fetchOwnership('u1', '006000000000001')).toMatchObject({ type: 'Opportunity', ownerId: '005A' });
    expect(soqlQuery).toHaveBeenCalledTimes(2);
    expect(soqlOf(0)).toContain('Lead_Manager__c');

    // A second, uncached Opportunity goes straight to owner-only: one request,
    // no guaranteed-400 against the org's API limits.
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005B' }]);
    expect(await fetchOwnership('u1', '006000000000002')).toMatchObject({ type: 'Opportunity', ownerId: '005B' });
    expect(soqlQuery).toHaveBeenCalledTimes(3);
    expect(soqlOf(2)).not.toContain('Lead_Manager__c');

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

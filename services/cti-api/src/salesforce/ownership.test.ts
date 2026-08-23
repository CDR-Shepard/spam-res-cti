import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOwnershipForTests,
  callerMayCreateTaskOn,
  fetchOwnership,
  mayCreateTaskOn,
  objectTypeForId,
  type OwnershipSnapshot,
} from './ownership.js';

const soqlQuery = vi.hoisted(() => vi.fn());
vi.mock('./client.js', () => ({ soqlQuery, soqlEscape: (v: string) => v }));

// The module owns a process-wide cache and a warn-once flag. Without this the
// order tests run in decides what they see.
beforeEach(() => {
  _resetOwnershipForTests();
  soqlQuery.mockReset();
});

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
  it('Opportunity: owner OR LeadManager__c', () => {
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

describe('mayCreateTaskOn', () => {
  const me = '005ME';
  const MINE: OwnershipSnapshot = { type: 'Lead', ownerId: me };
  const THEIRS: OwnershipSnapshot = { type: 'Opportunity', ownerId: '005X', leadManagerId: '005Y' };

  it('passes only when EVERY attached id passes — a Task lands on WhoId and WhatId both', async () => {
    const lookup = vi.fn(async (): Promise<OwnershipSnapshot> => MINE);
    expect(await mayCreateTaskOn(['00Q1', '0061'], me, lookup)).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('is false when the WhatId fails even though the WhoId passes', async () => {
    const lookup = vi.fn(async (id: string): Promise<OwnershipSnapshot> => (id === '00Q1' ? MINE : THEIRS));
    expect(await mayCreateTaskOn(['00Q1', '0061'], me, lookup)).toBe(false);
  });

  it('ignores null/undefined ids, and an empty set is allowed', async () => {
    const lookup = vi.fn(async (): Promise<OwnershipSnapshot> => THEIRS);
    expect(await mayCreateTaskOn([null, undefined], me, lookup)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never looks up a custom object — the rule allows it, so the round-trip is waste', async () => {
    const lookup = vi.fn(async (): Promise<OwnershipSnapshot> => THEIRS);
    expect(await mayCreateTaskOn(['a0B000000000001'], me, lookup)).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('fetchOwnership', () => {
  /** The SOQL text of the nth query the module issued. */
  const soqlOf = (n: number): string => String(soqlQuery.mock.calls[n]?.[1] ?? '');

  const INVALID_FIELD = new Error(
    'SOQL failed (400): [{"message":"No such column \'LeadManager__c\'","errorCode":"INVALID_FIELD"}]',
  );

  it('falls back to owner-only for THIS lookup on INVALID_FIELD, and warns once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First Opportunity: the two-field query 400s, the owner-only retry answers.
    soqlQuery.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ OwnerId: '005A' }]);
    expect(await fetchOwnership('u1', '006000000000001')).toMatchObject({ type: 'Opportunity', ownerId: '005A' });
    expect(soqlQuery).toHaveBeenCalledTimes(2);
    expect(soqlOf(0)).toContain('LeadManager__c');
    expect(soqlOf(1)).not.toContain('LeadManager__c');

    // A second, uncached Opportunity STILL asks for the field. The flag is a
    // warn deduper, not a control-flow latch: this process serves many orgs, and
    // the next org's Opportunity may well have LeadManager__c.
    soqlQuery.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ OwnerId: '005B' }]);
    expect(await fetchOwnership('u1', '006000000000002')).toMatchObject({ type: 'Opportunity', ownerId: '005B' });
    expect(soqlQuery).toHaveBeenCalledTimes(4);
    expect(soqlOf(2)).toContain('LeadManager__c');

    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('reads LeadManager__c normally in an org that has it', async () => {
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005A', LeadManager__c: '005ME' }]);
    expect(await fetchOwnership('u1', '006000000000001')).toEqual({
      type: 'Opportunity',
      ownerId: '005A',
      leadManagerId: '005ME',
    });
  });

  it('caches per user, not per record — SOQL runs under the caller\'s sharing', async () => {
    // u1 cannot see the Lead (no rows). u2 owns it. Same id, different answers:
    // a record-keyed cache would hand u1's blank snapshot to u2 and silently
    // suppress u2's Task.
    soqlQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ OwnerId: '005U2' }]);
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: null });
    expect(await fetchOwnership('u2', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: '005U2' });
    expect(soqlQuery).toHaveBeenCalledTimes(2);

    // Each user's own snapshot is still cached.
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: null });
    expect(await fetchOwnership('u2', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: '005U2' });
    expect(soqlQuery).toHaveBeenCalledTimes(2);
  });

  it('never queries for a custom object', async () => {
    expect(await fetchOwnership('u1', 'a0B000000000001')).toEqual({ type: 'other', ownerId: null });
    expect(soqlQuery).not.toHaveBeenCalled();
  });

  it('propagates a non-INVALID_FIELD error instead of caching it', async () => {
    soqlQuery.mockRejectedValueOnce(new Error('SOQL failed (503): service unavailable'));
    await expect(fetchOwnership('u1', '00Q000000000001')).rejects.toThrow('503');
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005A' }]);
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: '005A' });
  });
});

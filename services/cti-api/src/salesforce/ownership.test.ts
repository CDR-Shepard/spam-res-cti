import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOwnershipForTests,
  callerMayCreateTaskOn,
  fetchOwnership,
  isQueueLikeOwner,
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
  it('queue-owned records (OwnerId prefix 00G) are callable by anyone — ruling 2026-08-26', () => {
    const QUEUE = '00G8X000006aRkGUAU'; // LA Hunt Queue
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: QUEUE }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Contact', ownerId: QUEUE }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: QUEUE }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Opportunity', ownerId: QUEUE, leadManagerId: null }, me)).toBe(true);
  });
  it('regression pin: a Lead owned by a DIFFERENT USER id (005, not a queue) stays blocked', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X' }, me)).toBe(false);
  });

  // Pseudo-queue Users (ruling 2026-08-26): the org models some queues as
  // regular Users because Salesforce does not allow Groups to own
  // Opportunities. A record owned by one of these is queue-owned in spirit,
  // so the gate must treat it exactly like a `00G` Group id.
  it('pseudo-queue Users: a 005 owner whose Name matches /\\bqueue\\b/i is allowed, across object types', () => {
    const QUEUE_USER = '0058X00000FsyjzQAB'; // Opportunity Hunt Queue
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: QUEUE_USER, ownerName: 'Opportunity Hunt Queue' }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Contact', ownerId: QUEUE_USER, ownerName: 'Opportunity Hunt Queue' }, me)).toBe(true);
    expect(
      callerMayCreateTaskOn(
        { type: 'Opportunity', ownerId: QUEUE_USER, ownerName: 'Opportunity Hunt Queue', leadManagerId: null },
        me,
      ),
    ).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Task', ownerId: QUEUE_USER, ownerName: 'Opportunity Hunt Queue' }, me)).toBe(true);
  });

  it('pseudo-queue User: "Closer Hunt Queue LA" is allowed', () => {
    expect(
      callerMayCreateTaskOn({ type: 'Lead', ownerId: '005US0000075yp7YAA', ownerName: 'Closer Hunt Queue LA' }, me),
    ).toBe(true);
  });

  it('regression pin: a 005 owner named "Matt Penrod" (a real human rep) stays blocked', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X', ownerName: 'Matt Penrod' }, me)).toBe(false);
  });

  it('a 005 owner with no name (null/undefined) stays blocked — rule 2 needs a name to fire', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X', ownerName: null }, me)).toBe(false);
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X' }, me)).toBe(false);
  });

  it('word-boundary check: "Queued Reports" does NOT match — "queue" must appear as a whole word', () => {
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: '005X', ownerName: 'Queued Reports' }, me)).toBe(false);
  });

  it('regression pin: a 00G Group owner is still allowed regardless of name (including no name)', () => {
    const QUEUE = '00G8X000006aRkGUAU';
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: QUEUE }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: QUEUE, ownerName: null }, me)).toBe(true);
    expect(callerMayCreateTaskOn({ type: 'Lead', ownerId: QUEUE, ownerName: 'Anything At All' }, me)).toBe(true);
  });
});

describe('isQueueLikeOwner', () => {
  it('00G Group ids are always queue-like, regardless of name', () => {
    expect(isQueueLikeOwner('00G8X000006aRkGUAU', null)).toBe(true);
    expect(isQueueLikeOwner('00G8X000006aRkGUAU', undefined)).toBe(true);
    expect(isQueueLikeOwner('00G8X000006aRkGUAU', 'Anything')).toBe(true);
  });

  it('a 005 User id is queue-like only when the Name matches /\\bqueue\\b/i', () => {
    expect(isQueueLikeOwner('005US0000073cxZYAQ', 'Closer Hunt Queue SD')).toBe(true);
    expect(isQueueLikeOwner('005US000007XlDpYAK', 'Investor Hunt Queue')).toBe(true);
    expect(isQueueLikeOwner('005US000007XlDpYAK', 'QUEUE')).toBe(true);
    expect(isQueueLikeOwner('005X', 'Matt Penrod')).toBe(false);
    expect(isQueueLikeOwner('005X', 'Queued Reports')).toBe(false);
    expect(isQueueLikeOwner('005X', null)).toBe(false);
    expect(isQueueLikeOwner('005X', undefined)).toBe(false);
  });

  it('a null/other-prefixed owner id is never queue-like, even with a matching name', () => {
    expect(isQueueLikeOwner(null, 'Queue')).toBe(false);
    expect(isQueueLikeOwner('003000000000001', 'Queue')).toBe(false);
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
    // Both the two-field query and the owner-only retry must ask for Owner.Name
    // too — a pseudo-queue User owning the record must still be detected on
    // either path.
    expect(soqlOf(0)).toContain('Owner.Name');
    expect(soqlOf(1)).toContain('Owner.Name');

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

  it('reads LeadManager__c normally in an org that has it, and threads Owner.Name through as ownerName', async () => {
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005A', LeadManager__c: '005ME', Owner: { Name: 'Jane Doe' } }]);
    expect(await fetchOwnership('u1', '006000000000001')).toEqual({
      type: 'Opportunity',
      ownerId: '005A',
      ownerName: 'Jane Doe',
      leadManagerId: '005ME',
    });
    expect(soqlOf(0)).toContain('Owner.Name');
  });

  it('caches per user, not per record — SOQL runs under the caller\'s sharing', async () => {
    // u1 cannot see the Lead (no rows). u2 owns it. Same id, different answers:
    // a record-keyed cache would hand u1's blank snapshot to u2 and silently
    // suppress u2's Task.
    soqlQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ OwnerId: '005U2', Owner: { Name: 'Investor Hunt Queue' } }]);
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: null, ownerName: null });
    expect(await fetchOwnership('u2', '00Q000000000001')).toEqual({
      type: 'Lead',
      ownerId: '005U2',
      ownerName: 'Investor Hunt Queue',
    });
    expect(soqlQuery).toHaveBeenCalledTimes(2);
    expect(soqlOf(0)).toContain('Owner.Name');

    // Each user's own snapshot is still cached.
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: null, ownerName: null });
    expect(await fetchOwnership('u2', '00Q000000000001')).toEqual({
      type: 'Lead',
      ownerId: '005U2',
      ownerName: 'Investor Hunt Queue',
    });
    expect(soqlQuery).toHaveBeenCalledTimes(2);
  });

  it('never queries for a custom object', async () => {
    expect(await fetchOwnership('u1', 'a0B000000000001')).toEqual({ type: 'other', ownerId: null });
    expect(soqlQuery).not.toHaveBeenCalled();
  });

  it('missing/absent Owner relationship (older cached shape, partial API response) defaults ownerName to null rather than throwing', async () => {
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005A' }]);
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: '005A', ownerName: null });
  });

  it('propagates a non-INVALID_FIELD error instead of caching it', async () => {
    soqlQuery.mockRejectedValueOnce(new Error('SOQL failed (503): service unavailable'));
    await expect(fetchOwnership('u1', '00Q000000000001')).rejects.toThrow('503');
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005A' }]);
    expect(await fetchOwnership('u1', '00Q000000000001')).toEqual({ type: 'Lead', ownerId: '005A', ownerName: null });
  });
});

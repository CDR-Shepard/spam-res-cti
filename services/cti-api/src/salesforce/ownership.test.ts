import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetOwnershipForTests,
  callerMayCreateTaskOn,
  fetchOwnership,
  fetchOwnershipBatch,
  isSalesforceId,
  isQueueLikeOwner,
  mayCreateTaskOn,
  objectTypeForId,
  OWNERSHIP_BATCH_SIZE,
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

describe('isSalesforceId', () => {
  it('accepts 15- and 18-char alphanumeric ids, nothing else', () => {
    expect(isSalesforceId('00Q8X00000AbCdE')).toBe(true);
    expect(isSalesforceId('00Q8X00000AbCdEUAV')).toBe(true);
    expect(isSalesforceId('00Q1')).toBe(false);
    expect(isSalesforceId('00Q8X00000AbCdEUA')).toBe(false); // 17
    expect(isSalesforceId("00Q8X00000AbCd'")).toBe(false);
    expect(isSalesforceId("00Q8X00000AbCdE' OR Id != '")).toBe(false);
    expect(isSalesforceId('')).toBe(false);
  });
});

describe('fetchOwnershipBatch', () => {
  const soqlOf = (n: number): string => String(soqlQuery.mock.calls[n]?.[1] ?? '');
  const LEAD_A = '00Q8X00000AbCdEUAV';
  const LEAD_B = '00Q8X00000AbCdFUAV';
  const CONTACT = '0038X00000AbCdEQAV';
  const OPP = '0068X00000AbCdEQAV';
  const TASK = '00T8X00000AbCdEUAV';
  const INVALID_FIELD = new Error(
    'SOQL failed (400): [{"message":"No such column \'LeadManager__c\'","errorCode":"INVALID_FIELD"}]',
  );

  it('runs ONE query per object type — never one per record — with the exact SOQL', async () => {
    soqlQuery.mockImplementation(async (_u: string, q: string) => {
      if (/FROM Lead/.test(q)) return [{ Id: LEAD_A, OwnerId: '005ME', Owner: { Name: 'Me' } }, { Id: LEAD_B, OwnerId: '005X', Owner: { Name: 'Them' } }];
      if (/FROM Contact/.test(q)) return [{ Id: CONTACT, OwnerId: '00G8X000006aRkGUAU', Owner: { Name: 'LA Hunt Queue' } }];
      if (/FROM Opportunity/.test(q)) return [{ Id: OPP, OwnerId: '005X', Owner: { Name: 'Them' }, LeadManager__c: '005ME' }];
      if (/FROM Task/.test(q)) return [{ Id: TASK, OwnerId: '005ME', Owner: { Name: 'Me' } }];
      return [];
    });
    const got = await fetchOwnershipBatch('u1', [LEAD_A, CONTACT, OPP, LEAD_B, TASK]);

    expect(soqlQuery).toHaveBeenCalledTimes(4);
    expect(soqlQuery.mock.calls.every((c) => c[0] === 'u1')).toBe(true); // under the REP's sharing
    const queries = soqlQuery.mock.calls.map((c) => String(c[1])).sort();
    expect(queries).toEqual([
      `SELECT Id, OwnerId, Owner.Name FROM Contact WHERE Id IN ('${CONTACT}')`,
      `SELECT Id, OwnerId, Owner.Name FROM Lead WHERE Id IN ('${LEAD_A}','${LEAD_B}')`,
      `SELECT Id, OwnerId, Owner.Name FROM Task WHERE Id IN ('${TASK}')`,
      `SELECT Id, OwnerId, Owner.Name, LeadManager__c FROM Opportunity WHERE Id IN ('${OPP}')`,
    ].sort());

    expect(got.get(LEAD_A)).toEqual({ type: 'Lead', ownerId: '005ME', ownerName: 'Me' });
    expect(got.get(LEAD_B)).toEqual({ type: 'Lead', ownerId: '005X', ownerName: 'Them' });
    expect(got.get(CONTACT)).toEqual({ type: 'Contact', ownerId: '00G8X000006aRkGUAU', ownerName: 'LA Hunt Queue' });
    expect(got.get(OPP)).toEqual({ type: 'Opportunity', ownerId: '005X', ownerName: 'Them', leadManagerId: '005ME' });
    expect(got.get(TASK)).toEqual({ type: 'Task', ownerId: '005ME', ownerName: 'Me' });
    // The snapshots feed the ONE rule unchanged.
    expect(callerMayCreateTaskOn(got.get(OPP)!, '005ME')).toBe(true);
    expect(callerMayCreateTaskOn(got.get(LEAD_B)!, '005ME')).toBe(false);
  });

  it('chunks at 200 ids per query (a ~300-record run is two Lead queries, not 300)', async () => {
    expect(OWNERSHIP_BATCH_SIZE).toBe(200);
    const ids = Array.from({ length: 201 }, (_, i) => `00Q8X00000${String(i).padStart(5, '0')}`);
    soqlQuery.mockResolvedValue([]);
    await fetchOwnershipBatch('u1', ids);
    expect(soqlQuery).toHaveBeenCalledTimes(2);
    expect(soqlOf(0).match(/'00Q/g)).toHaveLength(200);
    expect(soqlOf(1)).toBe(`SELECT Id, OwnerId, Owner.Name FROM Lead WHERE Id IN ('${ids[200]}')`);
  });

  it('de-duplicates ids before querying', async () => {
    soqlQuery.mockResolvedValue([]);
    await fetchOwnershipBatch('u1', [LEAD_A, LEAD_A, LEAD_A]);
    expect(soqlOf(0)).toBe(`SELECT Id, OwnerId, Owner.Name FROM Lead WHERE Id IN ('${LEAD_A}')`);
  });

  it('an id Salesforce does not return (deleted / no read access) is simply ABSENT from the map', async () => {
    soqlQuery.mockResolvedValueOnce([{ Id: LEAD_A, OwnerId: '005ME' }]);
    const got = await fetchOwnershipBatch('u1', [LEAD_A, LEAD_B]);
    expect(got.has(LEAD_A)).toBe(true);
    expect(got.has(LEAD_B)).toBe(false);
    expect(got.get(LEAD_A)).toEqual({ type: 'Lead', ownerId: '005ME', ownerName: null });
  });

  it('matches a 15-char request id to the 18-char id Salesforce answers with', async () => {
    const fifteen = LEAD_A.slice(0, 15);
    soqlQuery.mockResolvedValueOnce([{ Id: LEAD_A, OwnerId: '005ME', Owner: { Name: 'Me' } }]);
    const got = await fetchOwnershipBatch('u1', [fifteen]);
    expect(got.get(fifteen)).toEqual({ type: 'Lead', ownerId: '005ME', ownerName: 'Me' });
  });

  it('NEVER puts a malformed id into SOQL — it is dropped (absent → not postable), not queried', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    soqlQuery.mockResolvedValue([]);
    const evil = "00Q8X00000AbCdE' OR Id != '";
    const got = await fetchOwnershipBatch('u1', [evil, '00Q1', LEAD_A]);
    expect(soqlQuery).toHaveBeenCalledTimes(1);
    expect(soqlOf(0)).toBe(`SELECT Id, OwnerId, Owner.Name FROM Lead WHERE Id IN ('${LEAD_A}')`);
    expect(got.has(evil)).toBe(false);
    expect(got.has('00Q1')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('only malformed ids → no query at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await fetchOwnershipBatch('u1', ['nope', ''])).size).toBe(0);
    expect(soqlQuery).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('objects the rule does not name get the same no-query `other` snapshot fetchOwnership gives', async () => {
    const custom = 'a0B8X00000AbCdEUAV';
    const got = await fetchOwnershipBatch('u1', [custom]);
    expect(got.get(custom)).toEqual({ type: 'other', ownerId: null });
    expect(soqlQuery).not.toHaveBeenCalled();
  });

  it('Opportunity: INVALID_FIELD on LeadManager__c retries THAT chunk owner-only (same fallback as fetchOwnership)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    soqlQuery.mockRejectedValueOnce(INVALID_FIELD).mockResolvedValueOnce([{ Id: OPP, OwnerId: '005ME', Owner: { Name: 'Me' } }]);
    const got = await fetchOwnershipBatch('u1', [OPP]);
    expect(soqlOf(0)).toBe(`SELECT Id, OwnerId, Owner.Name, LeadManager__c FROM Opportunity WHERE Id IN ('${OPP}')`);
    expect(soqlOf(1)).toBe(`SELECT Id, OwnerId, Owner.Name FROM Opportunity WHERE Id IN ('${OPP}')`);
    expect(got.get(OPP)).toEqual({ type: 'Opportunity', ownerId: '005ME', ownerName: 'Me', leadManagerId: null });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('INVALID_FIELD on a NON-Opportunity query is not swallowed', async () => {
    soqlQuery.mockRejectedValueOnce(INVALID_FIELD);
    await expect(fetchOwnershipBatch('u1', [LEAD_A])).rejects.toThrow('INVALID_FIELD');
  });

  it('any other failure PROPAGATES — the caller fails closed and retries, never posts unverified', async () => {
    soqlQuery.mockRejectedValueOnce(new Error('SOQL failed (503): service unavailable'));
    await expect(fetchOwnershipBatch('u1', [LEAD_A, OPP])).rejects.toThrow('503');
  });

  it('does not read or fill the single-record cache (a sweep wants the owner as of NOW)', async () => {
    soqlQuery.mockResolvedValueOnce([{ OwnerId: '005OLD' }]);
    await fetchOwnership('u1', LEAD_A); // cached for 5 minutes
    soqlQuery.mockResolvedValueOnce([{ Id: LEAD_A, OwnerId: '005NEW' }]);
    expect((await fetchOwnershipBatch('u1', [LEAD_A])).get(LEAD_A)?.ownerId).toBe('005NEW');
    expect((await fetchOwnership('u1', LEAD_A)).ownerId).toBe('005OLD'); // batch did not overwrite it
  });

  it('an empty id list is an empty map and no query', async () => {
    expect((await fetchOwnershipBatch('u1', [])).size).toBe(0);
    expect(soqlQuery).not.toHaveBeenCalled();
  });
});

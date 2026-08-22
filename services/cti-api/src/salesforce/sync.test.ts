import { describe, expect, it, vi } from 'vitest';
import { buildFullDetail, buildTaskDescription, syncJobLastError, syncOne, type SyncOneDeps } from './sync.js';
import type { OwnershipSnapshot } from './ownership.js';

type CallRow = Parameters<typeof buildFullDetail>[0];
type AuditRow = NonNullable<Parameters<typeof buildFullDetail>[1]>;

const call = (over: Partial<CallRow> = {}): CallRow => ({
  notes: 'STVM then NA',
  normalizedToNumber: '+18184455992',
  fromNumber: '+13235249247',
  provider: 'twilio',
  providerCallId: 'CA0786cee5011196eb88884e592ffeb2c6',
  durationSeconds: 4,
  disposition: 'No answer',
  startedAt: new Date('2026-07-01T21:37:58Z'),
  endedAt: new Date('2026-07-01T21:37:58Z'),
  ...over,
} as unknown as CallRow);

const audit = (over: Partial<AuditRow> = {}): AuditRow => ({
  decision: 'ALLOW',
  blockReason: null,
  reasons: ['PHONE_PARSED', 'FEDERAL_DNC_PRESCRUBBED'],
  ...over,
} as unknown as AuditRow);

const customFields = {
  External_Call_Id__c: 'call-1',
  From_Number__c: '+13235249247',
  To_Number__c: '818-445-5992',
};

describe('buildTaskDescription — rep notes only (Chatter-safe)', () => {
  it('is exactly the rep notes, no diagnostics or call-time line', () => {
    const d = buildTaskDescription(call());
    expect(d).toBe('STVM then NA');
    expect(d).not.toContain('Call:');
    expect(d).not.toContain('Caller Reputation CTI');
    expect(d).not.toContain('External_Call_Id__c');
  });

  it('is EMPTY when there are no notes (so the Chatter flow skips the call)', () => {
    expect(buildTaskDescription(call({ notes: null }))).toBe('');
    expect(buildTaskDescription(call({ notes: '   ' }))).toBe('');
  });
});

describe('buildFullDetail — complete record for our DB', () => {
  it('captures notes, the CTI block, reasons, and extended metadata', () => {
    const d = buildFullDetail(call(), audit(), customFields);
    expect(d).toContain('STVM then NA');
    expect(d).toContain('--- Caller Reputation CTI ---');
    expect(d).toContain('From: +13235249247');
    expect(d).toContain('FEDERAL_DNC_PRESCRUBBED');
    expect(d).toContain('--- Extended metadata ---');
    expect(d).toContain('External_Call_Id__c: call-1');
  });
});

// ---------------------------------------------------------------------------
// syncOne's ownership gate — the branch that decides a call gets NO Salesforce
// Task. A call Task carries BOTH a WhoId and a WhatId, so BOTH have to pass:
// gating only the Who would let another rep's Opportunity in through the What.
// ---------------------------------------------------------------------------
const ME = '005ME';

/** Minimal fake of the Drizzle surface syncOne touches. */
function fakeDb(callRow: Record<string, unknown>) {
  const updates: Array<{ patch: Record<string, unknown> }> = [];
  const db = {
    _updates: updates,
    query: {
      calls: { findFirst: async () => callRow },
      preCallAudits: { findFirst: async () => null },
    },
    update: () => ({ set: (patch: Record<string, unknown>) => ({ where: async () => { updates.push({ patch }); } }) }),
  };
  return db as unknown as SyncOneDeps['db'] & { _updates: typeof updates };
}

const callRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'call-1', userId: 'U1', direction: 'outbound', status: 'completed',
  fromNumber: '+13235249247', toNumber: '818-445-5992', normalizedToNumber: '+18184455992',
  salesforceTaskId: null, salesforceWhoId: null, salesforceWhatId: null,
  preCallAuditId: null, recordingUrl: null, provider: 'twilio', providerCallId: 'CA1',
  disposition: 'No answer', durationSeconds: 4, notes: null, startedAt: null, endedAt: null,
  ...over,
});

function syncDeps(over: Partial<SyncOneDeps> = {}): SyncOneDeps & { _db: ReturnType<typeof fakeDb> } {
  const db = fakeDb(callRow());
  return {
    db,
    salesforceUserId: vi.fn(async () => ME) as unknown as SyncOneDeps['salesforceUserId'],
    fetchOwnership: vi.fn(async (): Promise<OwnershipSnapshot> => ({ type: 'Lead', ownerId: ME })) as unknown as SyncOneDeps['fetchOwnership'],
    findByPhone: vi.fn(async () => null) as unknown as SyncOneDeps['findByPhone'],
    createCallTask: vi.fn(async () => ({ taskId: '00TNEW', degradedFields: null })) as unknown as SyncOneDeps['createCallTask'],
    ...over,
    _db: db,
  } as SyncOneDeps & { _db: ReturnType<typeof fakeDb> };
}

describe('syncOne — the after-call ownership gate', () => {
  it('writes the Task when the rep owns BOTH attached records', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', salesforceWhatId: '0061' }));
    const d = syncDeps({ db });
    const r = await syncOne('call-1', d);
    expect(r).toBeUndefined();
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
    expect((d.createCallTask as any).mock.calls[0][1]).toMatchObject({ whoId: '00Q1', whatId: '0061' });
    // ...and the call row is stamped with the new Task id.
    expect((db as any)._updates).toContainEqual({ patch: expect.objectContaining({ salesforceTaskId: '00TNEW' }) });
  });

  it('skips the Task when the WhoId is owned but the WhatId is another rep\'s Opportunity', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', salesforceWhatId: '0061' }));
    const d = syncDeps({
      db,
      fetchOwnership: vi.fn(async (_u: string, id: string): Promise<OwnershipSnapshot> =>
        (id === '0061'
          ? { type: 'Opportunity', ownerId: '005OTHER', leadManagerId: null }
          : { type: 'Lead', ownerId: ME })) as unknown as SyncOneDeps['fetchOwnership'],
    });
    expect(await syncOne('call-1', d)).toEqual({ skipped: 'not-owner' });
    expect(d.createCallTask).not.toHaveBeenCalled();
    // The call itself stays fully logged in the CTI — nothing was written.
    expect((db as any)._updates).toEqual([]);
  });

  it('costs no ownership lookup at all when the only match is a custom object', async () => {
    // The rule does not name Deal__c, so it is allowed outright — not even a
    // /users/me round-trip.
    const db = fakeDb(callRow());
    const d = syncDeps({
      db,
      findByPhone: vi.fn(async () => ({ whatId: 'a0J000000000001' })) as unknown as SyncOneDeps['findByPhone'],
    });
    expect(await syncOne('call-1', d)).toBeUndefined();
    expect(d.fetchOwnership).not.toHaveBeenCalled();
    expect(d.salesforceUserId).not.toHaveBeenCalled();
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
  });

  it('fails CLOSED: an ownership lookup error propagates so the tick retries', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1' }));
    const d = syncDeps({
      db,
      fetchOwnership: vi.fn(async () => { throw new Error('SOQL failed (503)'); }) as unknown as SyncOneDeps['fetchOwnership'],
    });
    await expect(syncOne('call-1', d)).rejects.toThrow(/503/);
    expect(d.createCallTask).not.toHaveBeenCalled();
  });
});

describe('syncJobLastError — what a succeeded job records', () => {
  it('carries the deliberate skip through to the job row, and nothing otherwise', () => {
    // This is the value runSyncTick writes on the succeeded job; GET /calls
    // turns it into the rep-visible "Not synced · not owner".
    expect(syncJobLastError({ skipped: 'not-owner' })).toBe('not-owner');
    expect(syncJobLastError(undefined)).toBeNull();
  });
});

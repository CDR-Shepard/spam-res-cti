import { describe, expect, it, vi } from 'vitest';
import {
  buildChatterText,
  buildFullDetail,
  buildTaskDescription,
  counterpartyE164,
  syncJobLastError,
  syncOne,
  type SyncOneDeps,
} from './sync.js';
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
  chatterFeedElementId: null,
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
    recordName: vi.fn(async () => null) as unknown as SyncOneDeps['recordName'],
    postChatterFeedItem: vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'],
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

  it('EXEMPTS an inbound call: a callback from another rep\'s lead still gets its Task', async () => {
    // The owner rule exists to stop a rep creating OUTBOUND activity on records
    // they do not own. An inbound call is the customer contacting THIS rep —
    // logging it is a record of what happened, not a land grab — so the gate
    // never runs and no ownership lookup is made at all.
    const db = fakeDb(callRow({ direction: 'inbound', salesforceWhoId: '00Q1', salesforceWhatId: '0061' }));
    const d = syncDeps({
      db,
      fetchOwnership: vi.fn(async (): Promise<OwnershipSnapshot> =>
        ({ type: 'Lead', ownerId: '005OTHER' })) as unknown as SyncOneDeps['fetchOwnership'],
    });
    expect(await syncOne('call-1', d)).toBeUndefined();
    expect(d.fetchOwnership).not.toHaveBeenCalled();
    expect(d.salesforceUserId).not.toHaveBeenCalled();
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
    expect((d.createCallTask as any).mock.calls[0][1]).toMatchObject({ callType: 'Inbound', whoId: '00Q1', whatId: '0061' });
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

// ---------------------------------------------------------------------------
// syncOne — the call-log subject (launch spec D). buildCallSubject itself is
// covered by call-subject.test.ts; these assert syncOne wires the RIGHT name
// into it, per the precedence: findByPhone match's name → else (whoId ??
// whatId) via deps.recordName → else null.
// ---------------------------------------------------------------------------
// counterpartyE164 — shared with routes/calls.ts's late-correction rewrite, so
// the two Subject writers can never disagree about which number they mean.
// ---------------------------------------------------------------------------
describe('counterpartyE164', () => {
  it('is the number we dialed on an outbound call', () => {
    expect(counterpartyE164({ direction: 'outbound', fromNumber: '+13235249247', normalizedToNumber: '+16195551234' }))
      .toBe('+16195551234');
  });

  it('is the normalized caller number on an inbound call', () => {
    expect(counterpartyE164({ direction: 'inbound', fromNumber: '(619) 555-1234', normalizedToNumber: '+13235249247' }))
      .toBe('+16195551234');
  });

  it('falls back to the raw caller value when it cannot be normalized', () => {
    expect(counterpartyE164({ direction: 'inbound', fromNumber: 'anonymous', normalizedToNumber: '+13235249247' }))
      .toBe('anonymous');
  });
});

// ---------------------------------------------------------------------------
describe('syncOne — the new call-log subject', () => {
  it('subject uses the new format with the matched record name', async () => {
    const db = fakeDb(callRow({ disposition: 'Voicemail', normalizedToNumber: '+16195551234' }));
    const d = syncDeps({
      db,
      findByPhone: vi.fn(async () => ({ whoId: '00Q1', name: 'Jane Doe' })) as unknown as SyncOneDeps['findByPhone'],
    });
    await syncOne('call-1', d);
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
    expect((d.createCallTask as any).mock.calls[0][1]).toMatchObject({
      subject: 'Outbound Call | Voicemail | (619) 555-1234 / Jane Doe',
    });
    // The name came straight off the match — no extra SF round-trip.
    expect(d.recordName).not.toHaveBeenCalled();
  });

  it('an inbound call (never dispositioned) is number-only with NO disposition slot', async () => {
    // The realistic inbound row: routes/inbound.ts never writes a disposition
    // and no later path sets one, so `disposition: null` is what syncOne
    // actually sees. The middle slot is omitted rather than reading
    // "Not dispositioned" on every inbound Task. Also covers the name
    // fallback: no match and no record name → number only, no dangling ' / '.
    const db = fakeDb(callRow({ direction: 'inbound', disposition: null, fromNumber: '+16195551234' }));
    const d = syncDeps({
      db,
      findByPhone: vi.fn(async () => null) as unknown as SyncOneDeps['findByPhone'],
      recordName: vi.fn(async () => null) as unknown as SyncOneDeps['recordName'],
    });
    await syncOne('call-1', d);
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
    expect((d.createCallTask as any).mock.calls[0][1]).toMatchObject({
      subject: 'Inbound Call | (619) 555-1234',
    });
  });

  it('a call-row-attached record (no findByPhone) resolves its name via the recordName dep', async () => {
    // salesforceWhoId is already set on the call row, so syncOne never calls
    // findByPhone — the name has to come from the injected recordName dep.
    const db = fakeDb(callRow({
      disposition: 'Connected',
      normalizedToNumber: '+16195551234',
      salesforceWhoId: '00Q1',
    }));
    const recordName = vi.fn(async () => 'Jane Doe') as unknown as SyncOneDeps['recordName'];
    const d = syncDeps({
      db,
      findByPhone: vi.fn(async () => { throw new Error('must not be called'); }) as unknown as SyncOneDeps['findByPhone'],
      recordName,
    });
    await syncOne('call-1', d);
    expect(recordName).toHaveBeenCalledWith('U1', '00Q1');
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
    expect((d.createCallTask as any).mock.calls[0][1]).toMatchObject({
      subject: 'Outbound Call | Connected | (619) 555-1234 / Jane Doe',
    });
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

// ---------------------------------------------------------------------------
// Chatter feed post (ruling 2026-08-26): every dispositioned call also gets ONE
// Chatter feed item on its related record, posted AFTER the Task write, never
// failing the Task sync, and idempotent across sync retries via
// chatter_feed_element_id.
// ---------------------------------------------------------------------------
describe('buildChatterText', () => {
  it('is just the subject line when there are no notes', () => {
    expect(buildChatterText('Outbound Call | No Answer | (619) 555-1234', undefined)).toBe(
      'Outbound Call | No Answer | (619) 555-1234',
    );
    expect(buildChatterText('Outbound Call | No Answer | (619) 555-1234', '   ')).toBe(
      'Outbound Call | No Answer | (619) 555-1234',
    );
  });

  it('appends the rep notes as a second paragraph when present', () => {
    expect(buildChatterText('Outbound Call | Voicemail | (619) 555-1234', 'will call back Tuesday')).toBe(
      'Outbound Call | Voicemail | (619) 555-1234\n\nwill call back Tuesday',
    );
  });
});

describe('syncOne — Chatter feed post', () => {
  it('posts one feed item on the related record and persists its id', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', disposition: 'No answer' }));
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    expect(postChatterFeedItem).toHaveBeenCalledTimes(1);
    const [userId, subjectId, text] = (postChatterFeedItem as any).mock.calls[0];
    expect(userId).toBe('U1');
    expect(subjectId).toBe('00Q1');
    expect(text).toContain('No answer');
    expect((db as any)._updates).toContainEqual({ patch: expect.objectContaining({ chatterFeedElementId: '0D5NEW' }) });
  });

  it('skips silently when the call has no related record', async () => {
    // No salesforceWhoId/WhatId on the row and no SOSL match — nothing to post to.
    const db = fakeDb(callRow());
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    expect(postChatterFeedItem).not.toHaveBeenCalled();
  });

  it('does not post again once chatter_feed_element_id is already set (idempotent across sync retries)', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', chatterFeedElementId: '0D5OLD' }));
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    expect(postChatterFeedItem).not.toHaveBeenCalled();
    expect((db as any)._updates.some((u: any) => 'chatterFeedElementId' in u.patch)).toBe(false);
  });

  it('a failed Chatter post does not fail the Task sync; the id stays null for a later retry', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1' }));
    const postChatterFeedItem = vi.fn(async () => {
      throw new Error('Salesforce Chatter post failed (500): {}');
    }) as unknown as SyncOneDeps['postChatterFeedItem'];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = syncDeps({ db, postChatterFeedItem });
    const result = await syncOne('call-1', d);
    expect(result).toBeUndefined();
    expect(d.createCallTask).toHaveBeenCalledTimes(1);
    expect((db as any)._updates).toContainEqual({ patch: expect.objectContaining({ salesforceTaskId: '00TNEW' }) });
    expect((db as any)._updates.some((u: any) => 'chatterFeedElementId' in u.patch)).toBe(false);
    expect(errSpy).toHaveBeenCalledWith('[sf-sync] chatter post failed', expect.objectContaining({ callId: 'call-1' }));
    errSpy.mockRestore();
  });

  it('threads the rep notes into the posted text as a second paragraph', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', notes: 'will call back Tuesday' }));
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    const text = (postChatterFeedItem as any).mock.calls[0][2];
    expect(text).toContain('\n\nwill call back Tuesday');
  });

  it('no notes → the posted text is a single line', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', notes: null }));
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    const text = (postChatterFeedItem as any).mock.calls[0][2];
    expect(text.split('\n')).toHaveLength(1);
  });

  // Finding 1 (CRITICAL, chatter-fix-findings.md): gate posting on
  // `call.disposition != null`. "Every DISPOSITIONED call" means an
  // undispositioned call — inbound (no wrap-up form) or an ensure-logged
  // outbound row synced before the rep ever set a disposition — must NOT
  // post, even when it has a related record. A call later swept into
  // AUTO_DISPOSITION and synced then DOES post (it IS its disposition by
  // then) — that path is exercised by the other tests in this block, which
  // all use callRow()'s default `disposition: 'No answer'`.
  it('an inbound call with a matched record but no disposition does not post to Chatter', async () => {
    const db = fakeDb(callRow({ direction: 'inbound', disposition: null, salesforceWhoId: '00Q1' }));
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    expect(postChatterFeedItem).not.toHaveBeenCalled();
    expect((db as any)._updates.some((u: any) => 'chatterFeedElementId' in u.patch)).toBe(false);
  });

  it('an outbound call with disposition: null (the ensure-logged shape) does not post to Chatter', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1', disposition: null }));
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const d = syncDeps({ db, postChatterFeedItem });
    await syncOne('call-1', d);
    expect(postChatterFeedItem).not.toHaveBeenCalled();
    expect((db as any)._updates.some((u: any) => 'chatterFeedElementId' in u.patch)).toBe(false);
  });

  // Finding 2 (MINOR, chatter-fix-findings.md): the SF POST and the
  // chatter_feed_element_id persist-write are separately guarded. A DB
  // failure AFTER a successful post must log its own distinct message (not
  // the "post failed" message) — a post that actually succeeded but whose id
  // never got saved must be diagnosable as such, so a future retry sweep
  // doesn't treat it as "never posted" and double-post blind.
  it('a successful post whose id persist-write then fails logs a distinct message, and the sync still succeeds', async () => {
    const db = fakeDb(callRow({ salesforceWhoId: '00Q1' }));
    (db as any).update = () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if ('chatterFeedElementId' in patch) {
            throw new Error('connection terminated');
          }
          (db as any)._updates.push({ patch });
        },
      }),
    });
    const postChatterFeedItem = vi.fn(async () => '0D5NEW') as unknown as SyncOneDeps['postChatterFeedItem'];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = syncDeps({ db, postChatterFeedItem });
    const result = await syncOne('call-1', d);
    expect(result).toBeUndefined();
    expect(postChatterFeedItem).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      '[sf-sync] chatter posted but id persist failed',
      expect.objectContaining({ callId: 'call-1', feedElementId: '0D5NEW' }),
    );
    expect(errSpy).not.toHaveBeenCalledWith('[sf-sync] chatter post failed', expect.anything());
    errSpy.mockRestore();
  });
});

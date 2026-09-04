import { describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { buildQueueRows, createAndStartSession, createDialerSession } from './create-session.js';
import { nextEligiblePendingItem } from './state.js';
import type { DialerItem } from './session-store.js';

/** Minimal db double: the session insert throws `insertErr`; the catch path
 *  reads back `existing` + `existingItems`. */
function conflictDb(existing: unknown, existingItems: unknown[], insertErr: unknown) {
  return {
    insert: () => ({ values: () => ({ returning: async () => { throw insertErr; } }) }),
    query: {
      dialerSessions: { findFirst: async () => existing },
      dialerQueueItems: { findMany: async () => existingItems },
    },
  } as never;
}

/** Minimal db double for the happy path: records the session insert values and
 *  the queue-item rows so a test can assert what creation actually wrote. */
function fakeDb() {
  const db = {
    _sessionInsert: undefined as Record<string, unknown> | undefined,
    _itemRows: [] as Array<Record<string, unknown>>,
    insert(table: unknown) {
      return {
        values(v: Record<string, unknown> | Array<Record<string, unknown>>) {
          if (table === schema.dialerQueueItems) {
            db._itemRows = v as Array<Record<string, unknown>>;
            return Promise.resolve(undefined);
          }
          db._sessionInsert = v as Record<string, unknown>;
          return { returning: async () => [{ id: 'S1', ...(v as Record<string, unknown>) }] };
        },
      };
    },
  };
  return db;
}

const noResolveDeps = {
  resolveDialNumber: (async () => null) as never,
  fetchTasks: (async () => []) as never,
  salesforceUserId: (async () => 'sf1') as never,
  workedToday: (async () => new Set<string>()) as never,
  consentBlocked: (async () => new Map()) as never,
};
const args = { userId: 'u1', orgId: 'o1', objectType: 'Lead' as const, recordIds: ['00Q000000000001'] };

describe('buildQueueRows', () => {
  it('numbers rows, carries the fallback number, and marks unreachable when no number resolved', () => {
    const rows = buildQueueRows('S1', [
      { recordId: '00Q1', objectType: 'Lead', toNumber: '+16195550100', fallbackNumber: '+16195550999' },
      { recordId: '00Q2', objectType: 'Lead', toNumber: '+16195550200' }, // no fallback provided
      { recordId: '00Q3', objectType: 'Lead', toNumber: null },
    ]);
    expect(rows).toEqual([
      { sessionId: 'S1', ordinal: 0, objectType: 'Lead', recordId: '00Q1', toNumber: '+16195550100', fallbackNumber: '+16195550999', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550999', taskId: null, followupEligible: true, status: 'pending', outcome: null },
      { sessionId: 'S1', ordinal: 1, objectType: 'Lead', recordId: '00Q2', toNumber: '+16195550200', fallbackNumber: null, attempt: 1, primaryNumber: '+16195550200', secondaryNumber: null, taskId: null, followupEligible: true, status: 'pending', outcome: null },
      { sessionId: 'S1', ordinal: 2, objectType: 'Lead', recordId: '00Q3', toNumber: null, fallbackNumber: null, attempt: 1, primaryNumber: null, secondaryNumber: null, taskId: null, followupEligible: true, status: 'unreachable', outcome: null },
    ]);
  });

  describe('buildQueueRows — Skip on Dialer', () => {
    it('marks a flagged record skipped with a visible outcome, keeping the number it resolved', () => {
      const rows = buildQueueRows('S1', [
        { recordId: '00Q1', objectType: 'Lead', toNumber: '+16195550100', fallbackNumber: '+16195550199', skipOnDialer: true },
      ]);
      expect(rows[0]).toMatchObject({
        status: 'skipped',
        outcome: 'skip_on_dialer',
        // Never silently dropped: the row keeps its numbers so the panel can
        // show WHO was skipped, and a re-run after an unchecked box has them.
        toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: '+16195550199',
      });
    });

    it('skip beats unreachable — a flagged record with no number is still skip_on_dialer', () => {
      const rows = buildQueueRows('S1', [
        { recordId: '00Q1', objectType: 'Lead', toNumber: null, skipOnDialer: true },
      ]);
      expect(rows[0]).toMatchObject({ status: 'skipped', outcome: 'skip_on_dialer', toNumber: null });
    });
  });

  describe('buildQueueRows — immutable number pair + attempt', () => {
    it('records the resolved Mobile/Phone as primary/secondary, attempt 1, so a retry can restore them', () => {
      const rows = buildQueueRows('S1', [
        { recordId: '00Q1', objectType: 'Lead', toNumber: '+16195550100', fallbackNumber: '+16195550199' },
        { recordId: '00Q2', objectType: 'Lead', toNumber: '+16195550200', fallbackNumber: null },
        { recordId: '00Q3', objectType: 'Lead', toNumber: null },
      ]);
      expect(rows[0]).toMatchObject({ attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550199' });
      expect(rows[1]).toMatchObject({ attempt: 1, primaryNumber: '+16195550200', secondaryNumber: null });
      expect(rows[2]).toMatchObject({ attempt: 1, primaryNumber: null, secondaryNumber: null, status: 'unreachable' });
    });
  });

  /**
   * The fallback is a DIALED number, not decoration: `engine.ts:345` swaps
   * `toNumber := fallbackNumber` on a true no-answer and re-dials it inside the
   * same session, and `:428` copies `secondaryNumber` onto the attempt-2 row.
   * Neither path re-reads consent, so a fallback that survives queue build is
   * dialed unchecked. Both halves of the pair are dropped here — the one place
   * the pair is written.
   */
  describe('buildQueueRows — a consent-blocked fallback is dropped', () => {
    it('drops both halves of the pair, leaving the clean primary dialable', () => {
      const rows = buildQueueRows('S1', [
        { recordId: '00Q1', objectType: 'Lead', toNumber: '+16195550100', fallbackNumber: '+16195550199', fallbackConsentBlock: 'opted_out' },
      ]);
      expect(rows[0]).toMatchObject({
        status: 'pending', outcome: null,
        toNumber: '+16195550100', primaryNumber: '+16195550100',
        // Nulled, so engine.ts's `if (outcome === 'no_answer' && item.fallbackNumber)`
        // cannot fire and the attempt-2 row inherits nothing to dial.
        fallbackNumber: null, secondaryNumber: null,
      });
    });

    it('keeps a clean fallback exactly as resolved', () => {
      const rows = buildQueueRows('S1', [
        { recordId: '00Q1', objectType: 'Lead', toNumber: '+16195550100', fallbackNumber: '+16195550199', fallbackConsentBlock: null },
      ]);
      expect(rows[0]).toMatchObject({ fallbackNumber: '+16195550199', secondaryNumber: '+16195550199' });
    });

    it('a blocked pair is skipped on the primary AND stripped of the fallback', () => {
      const rows = buildQueueRows('S1', [
        {
          recordId: '00Q1', objectType: 'Lead', toNumber: '+16195550100', fallbackNumber: '+16195550199',
          consentBlock: 'blocked', fallbackConsentBlock: 'dnc',
        },
      ]);
      expect(rows[0]).toMatchObject({
        status: 'skipped', outcome: 'blocked',
        toNumber: '+16195550100', primaryNumber: '+16195550100',
        fallbackNumber: null, secondaryNumber: null,
      });
    });
  });
});

describe('createAndStartSession', () => {
  const deps = { ...noResolveDeps, db: {} as never };

  it('creates the session, then kicks the engine with the new session id', async () => {
    const advance = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ sessionId: 'S1', total: 2 });

    const result = await createAndStartSession({ ...deps, advance }, args, create);

    expect(create).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledWith('S1');
    expect(result).toEqual({ sessionId: 'S1', total: 2 });
    // The kick must come AFTER creation — otherwise there is no session to advance.
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(advance.mock.invocationCallOrder[0]!);
  });

  it('propagates a kick failure (so the route surfaces it rather than showing a dead run)', async () => {
    const advance = vi.fn().mockRejectedValue(new Error('originate failed'));
    const create = vi.fn().mockResolvedValue({ sessionId: 'S1', total: 1 });

    await expect(createAndStartSession({ ...deps, advance }, args, create)).rejects.toThrow('originate failed');
  });
});

describe('createDialerSession — one active session per rep', () => {
  it('returns the rep\'s existing active session on the unique-index conflict (no second session)', async () => {
    const conflict = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'dialer_sessions_one_active_per_user',
    });
    const db = conflictDb({ id: 'EXISTING' }, [{}, {}, {}], conflict);

    const result = await createDialerSession({ ...noResolveDeps, db }, args);

    // The existing active session, with its own item count — NOT a new session.
    expect(result).toEqual({ sessionId: 'EXISTING', total: 3 });
  });

  it('rethrows a unique violation on a different constraint (never masks unrelated conflicts)', async () => {
    const other = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'some_other_unique',
    });
    const db = conflictDb(null, [], other);

    await expect(createDialerSession({ ...noResolveDeps, db }, args)).rejects.toThrow('duplicate key');
  });
});

describe('createDialerSession — Task runs', () => {
  it('resolves each Task to its person, keeps the task id + eligibility on the row, and marks the session a Task run', async () => {
    const fetchTasks = vi.fn(async () => [
      { Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: '00Q1', WhatId: null, Who: { Type: 'Lead' } },
      { Id: '00T2', Subject: 'Check in', OwnerId: '005', WhoId: '0031', WhatId: null, Who: { Type: 'Contact' } },
      { Id: '00T3', Subject: 'FU', OwnerId: '005', WhoId: null, WhatId: '0011', What: { Type: 'Account' } },
    ]);
    const resolveDialNumber = vi.fn(async (_u: string, obj: string, _id: string) =>
      obj === 'Lead' ? { e164: '+16195550100', fallbackE164: null } : obj === 'Contact' ? { e164: '+16195550200', fallbackE164: null } : null);
    const db = fakeDb();
    const r = await createDialerSession({ db, resolveDialNumber, fetchTasks, salesforceUserId: async () => '005', workedToday: async () => new Set(), consentBlocked: async () => new Map() } as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Task', recordIds: ['00T1', '00T2', '00T3'] });
    expect(r.total).toBe(3);
    expect(db._sessionInsert!.objectType).toBe('Task');
    expect(db._itemRows.map((x) => [x.recordId, x.objectType, x.taskId, x.followupEligible, x.status])).toEqual([
      ['00Q1', 'Lead', '00T1', true, 'pending'],
      ['0031', 'Contact', '00T2', false, 'pending'],
      ['00T3', 'Task', '00T3', true, 'unreachable'],
    ]);
  });
});

describe('createDialerSession — Skip on Dialer', () => {
  /** Stands in for the real resolver's contract: a Lead/Opportunity reports the
   *  checkbox, a Contact never can (the field does not exist on Contact). */
  function resolverFor(flagged: Set<string>, e164: string | null = '+16195550100') {
    return vi.fn(async (_u: string, objectType: string, recordId: string) => ({
      e164, fallbackE164: null,
      skipOnDialer: objectType !== 'Contact' && flagged.has(recordId),
    }));
  }

  const deps = (db: unknown, resolveDialNumber: unknown, fetchTasks: unknown = async () => []) =>
    ({ db, resolveDialNumber, fetchTasks, salesforceUserId: async () => '005', workedToday: async () => new Set(), consentBlocked: async () => new Map() });

  it('a flagged Lead enters the queue skipped — visible, with its number still recorded', async () => {
    const db = fakeDb();
    await createDialerSession(deps(db, resolverFor(new Set(['00Q2']))) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] });

    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'pending', null],
      ['00Q2', 'skipped', 'skip_on_dialer'],
    ]);
    // Never silently dropped: it is a row in the run, with the number it resolved.
    expect(db._itemRows[1]).toMatchObject({ toNumber: '+16195550100', primaryNumber: '+16195550100' });
  });

  it('skip beats unreachable — a flagged record with no phone reads skip_on_dialer, not unreachable', async () => {
    const db = fakeDb();
    await createDialerSession(deps(db, resolverFor(new Set(['00Q1']), null)) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] });

    expect(db._itemRows[0]).toMatchObject({ status: 'skipped', outcome: 'skip_on_dialer', toNumber: null });
  });

  it('a Task run skips a flagged Opportunity target and never flags a Contact target', async () => {
    const fetchTasks = vi.fn(async () => [
      { Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: null, WhatId: '0061', What: { Type: 'Opportunity' } },
      { Id: '00T2', Subject: 'Follow-up', OwnerId: '005', WhoId: '0031', WhatId: null, Who: { Type: 'Contact' } },
    ]);
    const db = fakeDb();
    // '0031' is in the flagged set too: a Contact target must be dialed anyway,
    // because Skip_on_Dialer__c does not exist on Contact.
    await createDialerSession(deps(db, resolverFor(new Set(['0061', '0031'])), fetchTasks) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Task', recordIds: ['00T1', '00T2'] });

    expect(db._itemRows.map((x) => [x.recordId, x.objectType, x.status, x.outcome])).toEqual([
      ['0061', 'Opportunity', 'skipped', 'skip_on_dialer'],
      ['0031', 'Contact', 'pending', null],
    ]);
  });

  it('leaves the flagged row out of what the engine\'s first advance can pick', async () => {
    const db = fakeDb();
    const advance = vi.fn().mockResolvedValue(undefined);
    await createAndStartSession(
      { ...deps(db, resolverFor(new Set(['00Q1']))), advance } as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    expect(advance).toHaveBeenCalledWith('S1');
    // The engine only ever picks a 'pending' row, so the flagged ordinal-0 record
    // is not what the kick dials — no engine change is needed to honor the box.
    const next = nextEligiblePendingItem(db._itemRows as unknown as DialerItem[], new Date());
    expect(next?.recordId).toBe('00Q2');
  });
});

describe('createDialerSession — already-worked skip at queue build', () => {
  /** Stands in for the real resolver: each record dials the number mapped to
   *  its id (null = no phone), and reports the Skip on Dialer checkbox. */
  function resolverByRecord(numbers: Record<string, string | null>, flagged: Set<string> = new Set()) {
    return vi.fn(async (_u: string, _objectType: string, recordId: string) => ({
      e164: numbers[recordId] ?? null, fallbackE164: null, skipOnDialer: flagged.has(recordId),
    }));
  }

  const deps = (db: unknown, resolveDialNumber: unknown, workedToday: unknown, fetchTasks: unknown = async () => []) =>
    ({ db, resolveDialNumber, fetchTasks, workedToday, salesforceUserId: async () => '005', consentBlocked: async () => new Map() });

  it('a number the team dialed today enters as skipped/already_worked; the rest stay pending', async () => {
    const db = fakeDb();
    const workedToday = vi.fn(async () => new Set(['+16195550100']));
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550200' }), workedToday) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'skipped', 'already_worked'],
      ['00Q2', 'pending', null],
    ]);
    // Never silently dropped: the skipped row keeps the number it resolved, so
    // the panel can show WHO the day's earlier shift already reached.
    expect(db._itemRows[0]).toMatchObject({ toNumber: '+16195550100', primaryNumber: '+16195550100' });
    // ONE batched read for the whole run — not a query per record.
    expect(workedToday).toHaveBeenCalledOnce();
    expect(workedToday).toHaveBeenCalledWith('O1', ['+16195550100', '+16195550200']);
  });

  it('skip_on_dialer beats already_worked when both apply', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': '+16195550100' }, new Set(['00Q1'])), async () => new Set(['+16195550100'])) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );

    // The rep's own checkbox is the more specific reason — it is what the panel shows.
    expect(db._itemRows[0]).toMatchObject({ status: 'skipped', outcome: 'skip_on_dialer' });
  });

  it('a Task-run target reached via a different record is still caught (number-keyed)', async () => {
    const fetchTasks = vi.fn(async () => [
      { Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: '0031', WhatId: null, Who: { Type: 'Contact' } },
    ]);
    const db = fakeDb();
    // The number was worked today off some other record; this Task reaches the
    // same person through a Contact. Keyed by number, it is still a repeat.
    await createDialerSession(
      deps(db, resolverByRecord({ '0031': '+16195550100' }), async () => new Set(['+16195550100']), fetchTasks) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Task', recordIds: ['00T1'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.objectType, x.status, x.outcome])).toEqual([
      ['0031', 'Contact', 'skipped', 'already_worked'],
    ]);
  });

  it('a phone-less record cannot be already_worked (stays unreachable)', async () => {
    const db = fakeDb();
    const workedToday = vi.fn(async () => new Set(['+16195550100']));
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': null }), workedToday) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );

    expect(db._itemRows[0]).toMatchObject({ status: 'unreachable', outcome: null, toNumber: null });
    // Nothing to look up: a null number is filtered out of the batched read.
    expect(workedToday).toHaveBeenCalledWith('O1', []);
  });

  it('batches each distinct number once, even when two records share it', async () => {
    const db = fakeDb();
    const workedToday = vi.fn(async () => new Set<string>());
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550100', '00Q3': '+12135550200' }), workedToday) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2', '00Q3'] },
    );

    // The same person on two records is one number to look up: a list of 200
    // duplicates must not become 200 binds in the IN (...) clause.
    expect(workedToday).toHaveBeenCalledWith('O1', ['+16195550100', '+12135550200']);
    // Both rows still read the shared number's verdict (empty set here → dial).
    expect(db._itemRows.map((x) => [x.recordId, x.status])).toEqual([
      ['00Q1', 'pending'], ['00Q2', 'pending'], ['00Q3', 'pending'],
    ]);
  });

  it('a run whose every number was worked today builds an all-skipped queue and still kicks the engine', async () => {
    const db = fakeDb();
    const advance = vi.fn().mockResolvedValue(undefined);
    await createAndStartSession(
      {
        ...deps(db, resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+12135550200' }),
          async () => new Set(['+16195550100', '+12135550200'])),
        advance,
      } as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    // The headline case: a second shift restarting the morning's list inherits
    // all of it — every row visible as skipped/already_worked, nothing dropped.
    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'skipped', 'already_worked'],
      ['00Q2', 'skipped', 'already_worked'],
    ]);
    // The kick still goes out exactly once: creation always hands the engine
    // the session, which finds nothing pending and completes the run.
    expect(advance).toHaveBeenCalledOnce();
    expect(advance).toHaveBeenCalledWith('S1');
  });

  it('the fail-open dep returning an empty set leaves everything pending', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550200' }), async () => new Set()) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'pending', null],
      ['00Q2', 'pending', null],
    ]);
  });
});

describe('createDialerSession — consent gate at queue build', () => {
  /** Stands in for the real resolver: each record dials the number mapped to
   *  its id, and reports the Skip on Dialer checkbox. */
  function resolverByRecord(numbers: Record<string, string | null>, flagged: Set<string> = new Set()) {
    return vi.fn(async (_u: string, _objectType: string, recordId: string) => ({
      e164: numbers[recordId] ?? null, fallbackE164: null, skipOnDialer: flagged.has(recordId),
    }));
  }

  const deps = (
    db: unknown,
    resolveDialNumber: unknown,
    consentBlocked: unknown,
    workedToday: unknown = async () => new Set(),
    fetchTasks: unknown = async () => [],
  ) => ({ db, resolveDialNumber, fetchTasks, workedToday, consentBlocked, salesforceUserId: async () => '005' });

  /**
   * The headline fix: a list carrying an opted-out, manually-blocked or
   * federally-listed number no longer dials it silently. Each list gets its OWN
   * outcome, because "why didn't it dial?" is a compliance question.
   */
  it('stamps each consent list with its own visible outcome and leaves clean numbers pending', async () => {
    const db = fakeDb();
    const consentBlocked = vi.fn(async () => new Map([
      ['+16195550100', 'opted_out'],
      ['+16195550200', 'blocked'],
      ['+16195550300', 'dnc'],
    ]));
    await createDialerSession(
      deps(db, resolverByRecord({
        '00Q1': '+16195550100', '00Q2': '+16195550200', '00Q3': '+16195550300', '00Q4': '+16195550400',
      }), consentBlocked) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2', '00Q3', '00Q4'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'skipped', 'opted_out'],
      ['00Q2', 'skipped', 'blocked'],
      ['00Q3', 'skipped', 'dnc_blocked'],
      ['00Q4', 'pending', null],
    ]);
    // Never silently dropped: the blocked row keeps the number it resolved so
    // the panel can show WHICH person the run refused.
    expect(db._itemRows[0]).toMatchObject({ toNumber: '+16195550100', primaryNumber: '+16195550100' });
    // ONE batched read for the whole run, distinct numbers only.
    expect(consentBlocked).toHaveBeenCalledOnce();
    expect(consentBlocked).toHaveBeenCalledWith(
      'O1', ['+16195550100', '+16195550200', '+16195550300', '+16195550400'],
    );
  });

  /**
   * PRECEDENCE: consent > skip_on_dialer > already_worked > unreachable. The
   * consent block is the strongest signal there is — it says the call would be
   * unlawful, not merely redundant — so the rep must see THAT reason even when
   * a weaker one also applies.
   */
  it('consent beats skip_on_dialer, already_worked and unreachable', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(
        db,
        // 00Q1 also has the rep's own Skip on Dialer box checked.
        resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550200' }, new Set(['00Q1'])),
        async () => new Map([['+16195550100', 'opted_out'], ['+16195550200', 'dnc']]),
        // ...and both numbers were already worked today.
        async () => new Set(['+16195550100', '+16195550200']),
      ) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'skipped', 'opted_out'],
      ['00Q2', 'skipped', 'dnc_blocked'],
    ]);
  });

  it('the weaker reasons still apply to rows consent did not claim', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(
        db,
        resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550200', '00Q3': '+16195550300' }, new Set(['00Q2'])),
        async () => new Map([['+16195550100', 'blocked']]),
        async () => new Set(['+16195550300']),
      ) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2', '00Q3'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.outcome])).toEqual([
      ['00Q1', 'blocked'], ['00Q2', 'skip_on_dialer'], ['00Q3', 'already_worked'],
    ]);
  });

  it('a phone-less record cannot be consent-blocked (stays unreachable) and is not looked up', async () => {
    const db = fakeDb();
    const consentBlocked = vi.fn(async () => new Map());
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': null }), consentBlocked) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );

    expect(db._itemRows[0]).toMatchObject({ status: 'unreachable', outcome: null, toNumber: null });
    expect(consentBlocked).toHaveBeenCalledWith('O1', []);
  });

  it('a Task-run target reached through a different record is still caught (number-keyed)', async () => {
    const fetchTasks = vi.fn(async () => [
      { Id: '00T1', Subject: 'Follow-up', OwnerId: '005', WhoId: '0031', WhatId: null, Who: { Type: 'Contact' } },
    ]);
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverByRecord({ '0031': '+16195550100' }),
        async () => new Map([['+16195550100', 'opted_out']]), async () => new Set(), fetchTasks) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Task', recordIds: ['00T1'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.objectType, x.status, x.outcome])).toEqual([
      ['0031', 'Contact', 'skipped', 'opted_out'],
    ]);
  });

  /**
   * The adjudicated fail-OPEN: a broken consent READ hands back an empty map,
   * and the run proceeds. The queue must not die because a table was
   * unreachable — click-to-dial's fail-closed firewall is still there.
   */
  it('the fail-open dep returning an empty map leaves everything pending', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550200' }), async () => new Map()) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    expect(db._itemRows.map((x) => [x.recordId, x.status, x.outcome])).toEqual([
      ['00Q1', 'pending', null], ['00Q2', 'pending', null],
    ]);
  });

  it('a run whose every number is consent-blocked builds an all-skipped queue and still kicks the engine', async () => {
    const db = fakeDb();
    const advance = vi.fn().mockResolvedValue(undefined);
    await createAndStartSession(
      {
        ...deps(db, resolverByRecord({ '00Q1': '+16195550100', '00Q2': '+16195550200' }),
          async () => new Map([['+16195550100', 'opted_out'], ['+16195550200', 'blocked']])),
        advance,
      } as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2'] },
    );

    expect(db._itemRows.every((x) => x.status === 'skipped')).toBe(true);
    // The engine only ever picks a 'pending' row, so nothing here is dialable.
    expect(nextEligiblePendingItem(db._itemRows as unknown as DialerItem[], new Date())).toBeNull();
    expect(advance).toHaveBeenCalledOnce();
  });
});

/**
 * The gap the re-review caught: the consent batch carried only `toNumber`, so a
 * record whose Mobile is clean but whose Phone is on `opt_outs`,
 * `blocked_numbers` or `federal_dnc_entries` was still power-dialed on that
 * Phone — `engine.ts` swaps the fallback in on a true no-answer (:345) and
 * carries it onto the attempt-2 row (:428) without ever re-checking. Both
 * halves of the pair now go through the same one batched read.
 */
describe('createDialerSession — the fallback number goes through the consent gate too', () => {
  /** Resolver that returns a Mobile/Phone PAIR per record. */
  function resolverWithFallback(pairs: Record<string, { e164: string | null; fallbackE164: string | null }>) {
    return vi.fn(async (_u: string, _objectType: string, recordId: string) => ({
      e164: pairs[recordId]?.e164 ?? null,
      fallbackE164: pairs[recordId]?.fallbackE164 ?? null,
      skipOnDialer: false,
    }));
  }

  /**
   * A double that behaves like the real `blockedTargets`: it can only report on
   * numbers it was actually ASKED about (the SQL is `... IN (numbers)`). That is
   * what makes these tests fail if the batch ever narrows back to primaries —
   * a stub that ignores its argument would pass a queue build that never looks
   * the fallback up at all, which is precisely the bug being fixed.
   */
  function listBackedConsent(lists: Record<string, 'opted_out' | 'blocked' | 'dnc'>) {
    return vi.fn(async (_orgId: string, numbers: readonly string[]) =>
      new Map(numbers.filter((n) => lists[n]).map((n) => [n, lists[n]])));
  }

  const deps = (db: unknown, resolveDialNumber: unknown, consentBlocked: unknown, workedToday: unknown = async () => new Set()) =>
    ({ db, resolveDialNumber, fetchTasks: async () => [], workedToday, consentBlocked, salesforceUserId: async () => '005' });

  it('batches BOTH halves of every pair, distinct, in the one consent read', async () => {
    const db = fakeDb();
    const consentBlocked = vi.fn(async () => new Map());
    await createDialerSession(
      deps(db, resolverWithFallback({
        '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' },
        // Shares 00Q1's Phone as its own Mobile: one bind, not two.
        '00Q2': { e164: '+16195550199', fallbackE164: null },
        '00Q3': { e164: '+16195550300', fallbackE164: '+16195550399' },
      }), consentBlocked) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1', '00Q2', '00Q3'] },
    );

    expect(consentBlocked).toHaveBeenCalledOnce();
    expect(consentBlocked).toHaveBeenCalledWith(
      'O1', ['+16195550100', '+16195550199', '+16195550300', '+16195550399'],
    );
  });

  it('a clean Mobile with a blocked Phone still dials — but the Phone is gone from the row', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverWithFallback({ '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' } }),
        listBackedConsent({ '+16195550199': 'opted_out' })) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );

    expect(db._itemRows[0]).toMatchObject({
      status: 'pending', outcome: null,
      toNumber: '+16195550100', primaryNumber: '+16195550100',
      fallbackNumber: null, secondaryNumber: null,
    });
  });

  it.each(['opted_out', 'blocked', 'dnc'] as const)('drops a %s fallback on every list', async (verdict) => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverWithFallback({ '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' } }),
        listBackedConsent({ '+16195550199': verdict })) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );
    expect(db._itemRows[0]).toMatchObject({ status: 'pending', fallbackNumber: null, secondaryNumber: null });
  });

  it('leaves a clean pair whole', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverWithFallback({ '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' } }),
        listBackedConsent({ '+16195559999': 'blocked' })) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );
    expect(db._itemRows[0]).toMatchObject({
      status: 'pending', toNumber: '+16195550100', fallbackNumber: '+16195550199', secondaryNumber: '+16195550199',
    });
  });

  it('a blocked Mobile with a clean Phone is skipped on the Mobile, not quietly rerouted to the Phone', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverWithFallback({ '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' } }),
        listBackedConsent({ '+16195550100': 'dnc' })) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );
    // Skipped rows are terminal — the engine only ever claims a 'pending' row —
    // so the surviving Phone is never dialed.
    expect(db._itemRows[0]).toMatchObject({ status: 'skipped', outcome: 'dnc_blocked', toNumber: '+16195550100' });
    expect(nextEligiblePendingItem(db._itemRows as unknown as DialerItem[], new Date())).toBeNull();
  });

  it('the already-worked read is NOT widened to fallbacks — it stays one bind per dialed-first number', async () => {
    const db = fakeDb();
    const workedToday = vi.fn(async () => new Set<string>());
    await createDialerSession(
      deps(db, resolverWithFallback({ '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' } }),
        async () => new Map(), workedToday) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );
    expect(workedToday).toHaveBeenCalledWith('O1', ['+16195550100']);
  });

  it('fail-open leaves the whole pair intact', async () => {
    const db = fakeDb();
    await createDialerSession(
      deps(db, resolverWithFallback({ '00Q1': { e164: '+16195550100', fallbackE164: '+16195550199' } }),
        async () => new Map()) as never,
      { userId: 'U1', orgId: 'O1', objectType: 'Lead', recordIds: ['00Q1'] },
    );
    expect(db._itemRows[0]).toMatchObject({ status: 'pending', fallbackNumber: '+16195550199', secondaryNumber: '+16195550199' });
  });
});

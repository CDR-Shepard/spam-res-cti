import { describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';
import { buildQueueRows, createAndStartSession, createDialerSession } from './create-session.js';

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
      { sessionId: 'S1', ordinal: 0, objectType: 'Lead', recordId: '00Q1', toNumber: '+16195550100', fallbackNumber: '+16195550999', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550999', taskId: null, followupEligible: true, status: 'pending' },
      { sessionId: 'S1', ordinal: 1, objectType: 'Lead', recordId: '00Q2', toNumber: '+16195550200', fallbackNumber: null, attempt: 1, primaryNumber: '+16195550200', secondaryNumber: null, taskId: null, followupEligible: true, status: 'pending' },
      { sessionId: 'S1', ordinal: 2, objectType: 'Lead', recordId: '00Q3', toNumber: null, fallbackNumber: null, attempt: 1, primaryNumber: null, secondaryNumber: null, taskId: null, followupEligible: true, status: 'unreachable' },
    ]);
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
    const r = await createDialerSession({ db, resolveDialNumber, fetchTasks, salesforceUserId: async () => '005' } as never,
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

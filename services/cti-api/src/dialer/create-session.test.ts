import { describe, expect, it, vi } from 'vitest';
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
const noResolveDeps = {
  resolveDialNumber: (async () => null) as never,
  salesforceUserId: (async () => 'sf1') as never,
};
const args = { userId: 'u1', orgId: 'o1', objectType: 'Lead' as const, recordIds: ['00Q000000000001'] };

describe('buildQueueRows', () => {
  it('numbers rows, carries the fallback number, and marks unreachable when no number resolved', () => {
    const rows = buildQueueRows('S1', 'Lead', [
      { recordId: '00Q1', toNumber: '+16195550100', fallbackNumber: '+16195550999' },
      { recordId: '00Q2', toNumber: '+16195550200' }, // no fallback provided
      { recordId: '00Q3', toNumber: null },
    ]);
    expect(rows).toEqual([
      { sessionId: 'S1', ordinal: 0, objectType: 'Lead', recordId: '00Q1', toNumber: '+16195550100', fallbackNumber: '+16195550999', status: 'pending' },
      { sessionId: 'S1', ordinal: 1, objectType: 'Lead', recordId: '00Q2', toNumber: '+16195550200', fallbackNumber: null, status: 'pending' },
      { sessionId: 'S1', ordinal: 2, objectType: 'Lead', recordId: '00Q3', toNumber: null, fallbackNumber: null, status: 'unreachable' },
    ]);
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

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory fake DB: enough of the drizzle surface the engine uses.
//
// Adjustment vs. the brief's sketch: added `dialerQueueItems.findFirst`. The
// engine's `handleDialOutcome` looks an item up by `callId` via
// `deps.db.query.dialerQueueItems.findFirst({ where: eq(...) })`, which the
// original fake didn't expose (only `findMany` was stubbed). Since every
// other `findFirst`/`findMany` stub here already ignores its `where` clause
// and just returns the fixture closed over above (there's only ever one
// session/item per test), `findFirst` for items follows the same pattern:
// return the first fixture item, ignoring the filter.
//
// Adjustment 2 (test hardening): the original fake's `update().set().where()`
// mutated a single shared `_target` object that no assertion ever read, so a
// wrong status/field write from the engine would still pass every test.
// `_writes` now records every `{ patch }` the engine sends through
// `update(table).set(patch).where(...)`, in call order, so tests can assert
// on the actual DB transitions the engine makes (not just its telephony /
// rollover / screen-pop side effects).
function fakeDb(session: any, items: any[]) {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  return {
    _session: session,
    _items: items,
    _writes: writes,
    query: {
      dialerSessions: { findFirst: async () => session },
      dialerQueueItems: {
        findMany: async () => items,
        findFirst: async () => items[0] ?? null,
      },
    },
    update(_tbl: unknown) {
      return {
        set: (patch: any) => ({
          where: async () => {
            writes.push({ patch });
            Object.assign(_target, patch);
          },
        }),
      };
    },
  } as any;
}
let _target: any = {};

import { advanceSession, handleDialOutcome, type EngineDeps } from './engine.js';

const baseSession = { id: 'S1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', objectType: 'Lead', status: 'active' };
function makeDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    db: undefined as any,
    telephony: { originate: vi.fn(async () => ({ callId: 'CA1' })), bridgeToRep: vi.fn(async () => {}), hangup: vi.fn(async () => {}) },
    dialerPoolNumbers: vi.fn(async () => [{ e164: '+16190000000' }]) as any,
    rolloverFollowUp: vi.fn(async () => ({ completed: null, created: null })) as any,
    onScreenPop: vi.fn(),
    todayIso: '2026-07-13',
    ...over,
  };
}

describe('advanceSession', () => {
  beforeEach(() => { _target = {}; });
  it('dials the next pending item from a pool DID', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r.action).toBe('dialing');
    expect((deps.telephony.originate as any)).toHaveBeenCalledWith(expect.objectContaining({ toE164: '+16195550100', fromE164: '+16190000000' }));
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'dialing' }) });
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ callId: 'CA1' }) });
  });
  it('waits (does not dial) while an item is in flight', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    expect((await advanceSession('S1', deps)).action).toBe('waiting');
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('is idle when the session is not active', async () => {
    const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, status: 'paused' }, []);
    expect((await advanceSession('S1', deps)).action).toBe('idle');
  });
  it('marks the session done and returns { action: "done" } when no items are pending', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r.action).toBe('done');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
  });
  it('pauses the session and returns { action: "paused_no_numbers" } when the DID pool is empty', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps({ dialerPoolNumbers: vi.fn(async () => []) as any });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r.action).toBe('paused_no_numbers');
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
  });
});

describe('handleDialOutcome', () => {
  beforeEach(() => { _target = {}; });
  it('no_connect runs the rollover then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.rolloverFollowUp).toHaveBeenCalledWith('U1', '005', '00Q1', '2026-07-13');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });
  it('connected bridges + screen-pops and does NOT roll over', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.bridgeToRep).toHaveBeenCalledWith('CA1', 'U1');
    expect(deps.onScreenPop).toHaveBeenCalledWith('U1', 'Lead', '00Q1');
    expect(deps.rolloverFollowUp).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'connected' }) });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../db/index.js';

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
//
// Adjustment 3 (test hardening for the pause/resume status guards): those
// guards re-load the session from the DB before deciding whether to act, and
// `resumeSession` re-loads it again inside `advanceSession` after writing
// `status: 'active'`. A fake that always hands back the original fixture
// object would make that second read see the pre-resume status forever, so
// `resumeSession`'s own write would never be visible to itself. Session
// writes are now layered into a local `sessionOverride` (never mutating the
// shared fixture object passed in — several describe blocks below reuse the
// same `baseSession` reference, and mutating it in place would leak status
// changes across unrelated tests) and merged on top of the fixture for every
// `dialerSessions.findFirst` call, scoped to this one `fakeDb(...)` instance.
//
// Adjustment 4 (concurrency-safe advance): `advanceSession` now claims the
// next item inside `deps.db.transaction(async (tx) => ...)`, where `tx`
// exposes `.execute(sql)` (the advisory lock statement — the fake just
// no-ops it) and `.update(...).set(...).where(...).returning(...)` (the
// conditional pending -> dialing claim). The fake's `transaction()` hands the
// callback a `tx` whose `update().set().where().returning()` pushes onto the
// same shared `_writes` array as the outer (non-transactional) `update()` —
// this is what "dialing" now goes through, so the pre-existing assertion
// `_writes` contains a `status: 'dialing'` patch stays meaningful instead of
// silently passing for the wrong reason. `returning()` resolves to a single
// claimed row by default (claim succeeds), matching every existing test's
// single-pending-item fixtures. The new `claimReturnsRows: false` option
// (3rd `fakeDb` arg) makes it resolve to `[]` instead — simulating a
// concurrent claimant winning the race — without writing anything, matching
// real Postgres `UPDATE ... WHERE status = 'pending' RETURNING id` semantics
// when 0 rows match.
function fakeDb(session: any, items: any[], opts: { claimReturnsRows?: boolean } = {}) {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  let sessionOverride: Record<string, unknown> = {};
  const claimReturnsRows = opts.claimReturnsRows ?? true;
  return {
    _session: session,
    _items: items,
    _writes: writes,
    query: {
      dialerSessions: { findFirst: async () => ({ ...session, ...sessionOverride }) },
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
            if (_tbl === schema.dialerSessions) sessionOverride = { ...sessionOverride, ...patch };
          },
        }),
      };
    },
    async transaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        execute: async () => undefined, // pg_advisory_xact_lock(...) — no-op in the fake
        update(_tbl: unknown) {
          return {
            set: (patch: any) => ({
              where: () => ({
                returning: async () => {
                  if (!claimReturnsRows) return [];
                  writes.push({ patch });
                  Object.assign(_target, patch);
                  return [{ id: 'claimed' }];
                },
              }),
            }),
          };
        },
      };
      return fn(tx);
    },
  } as any;
}
let _target: any = {};

import {
  advanceSession,
  handleDialOutcome,
  pauseSession,
  resumeSession,
  skipCurrent,
  stopSession,
  repNext,
  type EngineDeps,
} from './engine.js';

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
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ callId: 'CA1', fromNumber: '+16190000000' }) });
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
  it('returns "waiting" without dialing when the atomic claim loses the race (0 rows updated)', async () => {
    // Simulates a second concurrent advance (or a retry) claiming the same
    // item first: the conditional `UPDATE ... WHERE status = 'pending'
    // RETURNING id` inside the per-session-locked transaction affects 0 rows,
    // so this call must back off instead of dialing a lead someone else is
    // already dialing.
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps();
    const fdb = fakeDb(baseSession, items, { claimReturnsRows: false });
    deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r).toEqual({ action: 'waiting' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'dialing' }) });
  });
  it('rolls the item back to pending (and rethrows) when originate fails after the claim succeeds', async () => {
    // A transient originate failure (Twilio 5xx, network blip) must not strand
    // the item 'dialing' forever with no call in flight — that would wedge
    // the whole session (inFlightItem would keep matching it) with no way to
    // retry. The claim already committed 'dialing' via the transaction, so
    // the rollback is a follow-up write back to 'pending'.
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps({ telephony: { originate: vi.fn(async () => { throw new Error('twilio 500'); }), bridgeToRep: vi.fn(async () => {}), hangup: vi.fn(async () => {}) } });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await expect(advanceSession('S1', deps)).rejects.toThrow('twilio 500');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'dialing' }) }); // claim landed
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'pending' }) }); // then rolled back
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

describe('pauseSession', () => {
  beforeEach(() => { _target = {}; });
  it('sets the session paused and does not touch items', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await pauseSession('S1', deps);
    expect(r).toEqual({ action: 'paused' });
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });
});

describe('resumeSession', () => {
  beforeEach(() => { _target = {}; });
  it('sets the session active then advances (dials the next pending item)', async () => {
    // Resume only proceeds from 'paused' (the terminal-status guard below), and
    // the fake DB's session write is now visible to the subsequent re-read
    // inside advanceSession (see fakeDb's `sessionOverride`), so this exercises
    // the real paused → active → dial transition end to end.
    const pausedSession = { ...baseSession, status: 'paused' };
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(pausedSession, items); deps.db = fdb;
    const r = await resumeSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'active' }) });
    expect(r.action).toBe('dialing');
    expect(deps.telephony.originate).toHaveBeenCalled();
  });
  it('does not reactivate a stopped session (terminal status guard)', async () => {
    const stoppedSession = { ...baseSession, status: 'stopped' };
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(stoppedSession, items); deps.db = fdb;
    const r = await resumeSession('S1', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'active' }) });
    expect(r).toEqual({ action: 'stopped' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
});

describe('skipCurrent', () => {
  beforeEach(() => { _target = {}; });
  it('hangs up a dialing item, marks it skipped, then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await skipCurrent('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped' }) });
    // advanceSession re-reads items via findMany, which the fake ignores filters
    // for and returns the same fixture (still 'dialing' in the fixture array) —
    // it still exercises the advance call without erroring.
    expect(r).toBeDefined();
  });
  it('hangs up a connected (already-bridged) item too, marks it skipped, then advances', async () => {
    // Regression test: skipping a *connected* call used to only mark it
    // skipped without hanging up (the old guard was `status === 'dialing'`),
    // leaving the live call up while advanceSession dialed the next lead —
    // two simultaneous live calls. Skip must hang up on any callId, dialing
    // or connected.
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await skipCurrent('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped' }) });
    expect(r).toBeDefined();
  });
  it('is a no-op skip (still advances) when nothing is in flight', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await skipCurrent('S1', deps);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(r.action).toBe('done');
  });
});

describe('stopSession', () => {
  beforeEach(() => { _target = {}; });
  it('hangs up a dialing item and stops the session', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await stopSession('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'stopped' }) });
    expect(r).toEqual({ action: 'stopped' });
  });
  it('does not hang up a connected (already-bridged) item, but still stops', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await stopSession('S1', deps);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'stopped' }) });
    expect(r).toEqual({ action: 'stopped' });
  });
});

describe('repNext', () => {
  beforeEach(() => { _target = {}; });
  it('marks the connected item done, then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await repNext('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(r).toBeDefined();
  });
  it('leaves a still-dialing item alone (rep cannot next before connect)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await repNext('S1', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(r.action).toBe('waiting');
  });
});

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';

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
//
// Adjustment 5 (C1/I3 review fixes): `handleDialOutcome`'s miss-path ordinal
// lookup now goes through `tx.query.dialerQueueItems.findMany` instead of
// `deps.db.query...findMany` (a second lookup would check out a second pool
// client while the transaction holds one — a real deadlock risk under
// concurrent misses), so `tx` grew a `.query` stub. The rollover enqueue
// (`deps.enqueueRollover`) now also runs INSIDE the transaction, receiving
// `tx` as its second argument, so `tx.insert(...).values(...)` needs the same
// `.onConflictDoNothing()`-bearing thenable the outer `insert` already
// exposes (real `enqueueFollowupRollover` chains it). Inserts made through
// `tx.insert` are recorded into a separate `_txInserts` array so tests can
// tell "inserted" apart from "inserted inside the transaction that also did
// the CAS".
//
// Adjustment 6 (M1 pin): the fake now FENCES the outer `db.query` for the
// duration of `transaction()` — while the callback runs, `handle.query` is a
// proxy that throws on any property access. `handleDialOutcome`'s ordinal
// lookup must go through `tx.query` (sharing the transaction's pool client);
// reaching for `deps.db.query` there checks out a SECOND client while the tx
// holds one, which deadlocks the pool under concurrent misses. Before this the
// two stubs were interchangeable and the regression would have passed silently.
//
// Adjustment 7 (Task 11 fix-round-1 M3): the outer (non-transactional)
// `update().set().where()` now also records `{ patch, where }` into
// `_updateWheres`, the same way `txWrites` already does for transactional
// updates. `_writes` stays patch-only (dozens of assertions match `{ patch }`
// exactly) so this rides in its own array — needed to pin the hang-up stamp's
// `isNull(prospect_ended_at)` guard as rendered SQL rather than only the
// JS-level dedup check.
/** `opts.otherSessions`: the rep's OTHER runs (with their items), for the
 *  cross-run checks — a paused run with a dial in flight blocks a new Start, and
 *  a paused run's teardown must not touch a live run's room. Filtered by the
 *  status the query binds, and never containing the session under test. */
function fakeDb(session: any, items: any[], opts: { claimReturnsRows?: boolean; otherSessions?: Array<{ session: any; items: any[] }> } = {}) {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  const inserts: Array<{ values: Record<string, unknown> }> = [];
  // Inserts made through `tx.insert(...)` — i.e. INSIDE `deps.db.transaction`
  // — land here, separately from the outer (non-transactional) `_inserts`.
  // Kept apart so a test can assert an insert rode inside the transaction
  // (I3/I4c) rather than merely happening at some point.
  const txInserts: Array<{ values: Record<string, unknown> }> = [];
  // Transactional updates, with the `where` they were guarded by — the outer
  // `_writes` deliberately records the patch ALONE (dozens of assertions match
  // `{ patch }` exactly), so the predicate gets its own array. Needed to pin
  // that the connect stamp is scoped to the number that connected, not to every
  // attempt row the item owns.
  const txWrites: Array<{ patch: Record<string, unknown>; where: unknown }> = [];
  // OUTER (non-transactional) updates, with the `where` they were guarded by —
  // mirrors `txWrites` but for `deps.db.update(...)` calls made outside a
  // transaction. Needed to pin the hang-up stamp's `isNull(prospect_ended_at)`
  // WHERE guard as rendered SQL, not just the JS-level `prospectEndedAt == null`
  // dedup check (Task 11 fix-round-1 M3).
  const updateWheres: Array<{ patch: Record<string, unknown>; where: unknown }> = [];
  let sessionOverride: Record<string, unknown> = {};
  const claimReturnsRows = opts.claimReturnsRows ?? true;
  const handle: any = {
    _session: session,
    _items: items,
    _writes: writes,
    _inserts: inserts,
    _txInserts: txInserts,
    _txWrites: txWrites,
    _updateWheres: updateWheres,
    query: {
      dialerSessions: {
        findFirst: async () => ({ ...session, ...sessionOverride }),
        findMany: async (args: { where: any }) => {
          const { params } = new PgDialect().sqlToQuery(args.where);
          return (opts.otherSessions ?? []).map((o) => o.session).filter((o) => params.includes(o.status));
        },
      },
      dialerQueueItems: {
        findMany: async (args?: { where?: any }) => {
          if (!opts.otherSessions || !args?.where) return items;
          const { params } = new PgDialect().sqlToQuery(args.where);
          return opts.otherSessions.find((o) => params.includes(o.session.id))?.items ?? items;
        },
        findFirst: async () => items[0] ?? null,
      },
    },
    // Used by recordConnectSticky (dialer/sticky.ts) — the engine calls this
    // directly (not through EngineDeps) on a connected outcome. Recording
    // into `_inserts` lets tests assert the sticky upsert fires with the
    // right values without pulling in a real DB.
    insert(_tbl: unknown) {
      return {
        values: (values: any) => {
          inserts.push({ values });
          const p = Promise.resolve() as Promise<void> & { onConflictDoUpdate: () => Promise<void>; onConflictDoNothing: () => Promise<void> };
          p.onConflictDoUpdate = async () => {};
          p.onConflictDoNothing = async () => {};
          return p;
        },
      };
    },
    update(_tbl: unknown) {
      return {
        set: (patch: any) => ({
          where: (w: any) => {
            const apply = () => {
              writes.push({ patch });
              updateWheres.push({ patch, where: w });
              Object.assign(_target, patch);
              if (_tbl === schema.dialerSessions) sessionOverride = { ...sessionOverride, ...patch };
            };
            return {
              // Unguarded `UPDATE ... WHERE id = $1` — awaited directly.
              then: (res: any, rej: any) => Promise.resolve(apply()).then(res, rej),
              // Guarded `UPDATE ... WHERE id = $1 AND status = 'pending' RETURNING id`
              // (setItemIfPending). Honors the guard against the fake's OWN item
              // rows, so a test can flip a row to 'dialing' mid-advance — a
              // concurrent advance winning the claim — and assert the skip write
              // is refused instead of clobbering the live dial.
              returning: async () => {
                const { sql: text, params } = new PgDialect().sqlToQuery(w);
                if (/"status" =/.test(text)) {
                  if (_tbl === schema.dialerSessions) {
                    // startSession's `WHERE id = $1 AND status = 'ready'` flip:
                    // honor it against the fake's CURRENT session status so a
                    // second Start (session already active) claims 0 rows.
                    const current = { ...session, ...sessionOverride };
                    if (!params.includes(current.id) || !params.includes(current.status)) return [];
                  } else {
                    const target = items.find((i: any) => params.includes(i.id));
                    if (!target || target.status !== 'pending') return [];
                  }
                }
                apply();
                return [{ id: 'updated' }];
              },
            };
          },
        }),
      };
    },
    async transaction(fn: (tx: any) => Promise<any>) {
      const tx = {
        // pg_advisory_xact_lock(...) — no-op in the fake, but it must ACCEPT the
        // query: the claim now takes a second (per-person) lock, and the
        // ordering test below wraps this to read each statement's params.
        execute: async (_q?: unknown) => undefined,
        // C1: handleDialOutcome's ordinal lookup now reads via `tx.query`, not
        // `deps.db.query` — that would check out a SECOND pool client while
        // the tx already holds one. Mirrors the outer `query.dialerQueueItems`
        // stub, ignoring the `where` filter the same way.
        query: {
          dialerQueueItems: { findMany: async () => items },
        },
        insert(_tbl: unknown) {
          return {
            values: (values: any) => {
              txInserts.push({ values });
              const p = Promise.resolve() as Promise<void> & { onConflictDoUpdate: () => Promise<void>; onConflictDoNothing: () => Promise<void> };
              p.onConflictDoUpdate = async () => {};
              p.onConflictDoNothing = async () => {};
              return p;
            },
          };
        },
        update(_tbl: unknown) {
          return {
            set: (patch: any) => ({
              where: (w?: any) => {
                const apply = () => { writes.push({ patch }); txWrites.push({ patch, where: w }); Object.assign(_target, patch); };
                return {
                  // Plain awaited UPDATE inside a transaction (the post-originate
                  // stamp, which rides with the dial-attempt insert).
                  then: (res: any, rej: any) => Promise.resolve(apply()).then(res, rej),
                  // The conditional pending -> dialing claim.
                  returning: async () => {
                    if (!claimReturnsRows) return [];
                    apply();
                    return [{ id: 'claimed' }];
                  },
                };
              },
            }),
          };
        },
      };
      // Any read of `deps.db.query` from inside the transaction is a bug — fence
      // it off for the callback's duration rather than letting it silently work.
      const outerQuery = handle.query;
      handle.query = new Proxy({}, {
        get(_t, prop) {
          throw new Error(`outer deps.db.query.${String(prop)} used inside a transaction — use tx.query`);
        },
      });
      try {
        return await fn(tx);
      } finally {
        handle.query = outerQuery;
      }
    },
  };
  return handle as any;
}
let _target: any = {};

import { enqueueFollowupRollover } from '../salesforce/followup-enqueue.js';
import {
  advanceSession,
  handleDialOutcome,
  pauseSession,
  resumeSession,
  skipCurrent,
  startSession,
  stopSession,
  repNext,
  redialCurrent,
  endCurrent,
  type EngineDeps,
} from './engine.js';

const REP_LEG = 'CA00000000000000000000000000000rep';
const baseSession = { id: 'S1', orgId: 'O1', userId: 'U1', sfOwnerId: '005', objectType: 'Lead', status: 'active' };
function makeDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    db: undefined as any,
    telephony: { originate: vi.fn(async () => ({ callId: 'CA1' })), bridgeToRep: vi.fn(async () => {}), hangup: vi.fn(async () => {}), endConference: vi.fn(async () => {}) },
    pickDid: vi.fn(async () => ({ e164: '+16190000000' })) as any,
    withinCallingHours: vi.fn(() => true) as any,
    nowUtc: new Date(Date.UTC(2026, 6, 13, 18, 0, 0)),
    // Now receives (job, db) — the 2nd arg is the transaction handle (I3).
    // Assertions on call args should match the 1st with expect.objectContaining
    // and leave the 2nd unconstrained (expect.anything()).
    enqueueRollover: vi.fn(async () => {}),
    onScreenPop: vi.fn(),
    todayIso: '2026-07-13',
    // Contact-cadence defaults: no history, nobody in flight, no capped state —
    // so every test above this line reads exactly as it did before the gate
    // existed, and only the tests that opt in exercise it.
    contactHistory: vi.fn(async () => []),
    inFlightElsewhere: vi.fn(async () => false),
    isDailyCapped: vi.fn(() => false),
    // LA midnight for `nowUtc` above (2026-07-13 00:00 PDT = 07:00 UTC).
    orgDayStart: new Date(Date.UTC(2026, 6, 13, 7, 0, 0)),
    ...over,
  };
}

// The rollover rule is per DAY, per OWNER: the task rolls when the owner's dials
// to the person since the org day began — the one that just missed included,
// since its attempt row is written at originate — reach two, none connected.
// `twoOwnMissesToday` is the history a miss that SHOULD roll reads.
const ownDial = (hoursAgo: number, connected = false) =>
  ({ userId: 'U1', sessionId: 'S1', toNumber: '+1', at: new Date(Date.UTC(2026, 6, 13, 18 - hoursAgo)), connected, source: 'dialer' as const, skipped: false });
const twoOwnMissesToday = () => vi.fn(async () => [ownDial(3), ownDial(0)]);
const oneOwnDialToday = () => vi.fn(async () => [ownDial(0)]);

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
  it('records exactly one append-only dial attempt, inside the dialing write transaction', async () => {
    // The per-customer ceiling counts these rows. It cannot count
    // dialer_queue_items: a row's to_number / from_number are mutable (the old
    // no-answer -> fallback path rewrote them in place), which would erase a
    // dial from the tally.
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await advanceSession('S1', deps);
    expect(fdb._txInserts).toEqual([
      { values: expect.objectContaining({
        orgId: 'O1', userId: 'U1', sessionId: 'S1', itemId: 'i1',
        toNumber: '+16195550100', fromNumber: '+16190000000',
      }) },
    ]);
    // ...and nothing was written outside that transaction.
    expect(fdb._inserts).toEqual([]);
  });
  it('records no dial attempt when the originate itself fails', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps({ telephony: { originate: vi.fn(async () => { throw new Error('twilio 500'); }), bridgeToRep: vi.fn(), hangup: vi.fn(), endConference: vi.fn() } as any });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await expect(advanceSession('S1', deps)).rejects.toThrow(/twilio 500/);
    expect(fdb._txInserts).toEqual([]);
  });
  it('waits (does not dial) while an item is in flight', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    expect((await advanceSession('S1', deps)).action).toBe('waiting');
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('does NOT release the conference on a non-terminal advance (rep is still mid-run)', async () => {
    // Guards against a regression that releases the conference unconditionally:
    // dropping the rep's leg mid-run would kill the run and free the Device
    // while calls are still being placed.
    const dialing = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const d1 = makeDeps(); d1.db = fakeDb(baseSession, dialing);
    expect((await advanceSession('S1', d1)).action).toBe('dialing');
    expect(d1.telephony.endConference).not.toHaveBeenCalled();

    const inFlight = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const d2 = makeDeps(); d2.db = fakeDb(baseSession, inFlight);
    expect((await advanceSession('S1', d2)).action).toBe('waiting');
    expect(d2.telephony.endConference).not.toHaveBeenCalled();

    const noNumbers = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const d3 = makeDeps({ pickDid: vi.fn(async () => null) as any }); d3.db = fakeDb(baseSession, noNumbers);
    expect((await advanceSession('S1', d3)).action).toBe('paused_no_numbers');
    expect(d3.telephony.endConference).not.toHaveBeenCalled();
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
  it('releases the rep conference when the queue drains, so the softphone Device is freed', async () => {
    // Server-side backstop: the rep leg joins with endConferenceOnExit=true, so
    // normally the client's own disconnect collapses the conference. If the
    // browser stopped polling (tab switched away, asleep), nothing would ever
    // end it — the rep's single Twilio Device stays busy and their next call
    // fails "a call is already in progress".
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await advanceSession('S1', deps);
    expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
  });
  // The rep's leg re-enters a fresh room every time a prospect leaves, so at run
  // end it is usually in NO started conference (or between rooms): completing a
  // room by name finds nothing, or just sends the leg round the rejoin loop.
  // Hanging up the leg itself is the only teardown that cannot miss.
  // ORDER is asserted on snapshots taken INSIDE the mocks and checked AFTER the
  // call. An `expect` inside the mock proves nothing here: releaseRepConference
  // wraps both Twilio calls in try/catch, so a failing assertion is swallowed and
  // logged, and "release after the flip" passed the whole suite.
  it('hangs up the rep\'s own leg by sid when the queue drains — before the conference teardown, and BOTH before the session leaves active', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, repCallSid: REP_LEG }, items); deps.db = fdb;
    const seen: Array<{ step: string; flipped: boolean }> = [];
    const flipped = () => fdb._writes.some((w: any) => w.patch.status === 'done');
    deps.telephony.hangup = vi.fn(async () => { seen.push({ step: 'hangup', flipped: flipped() }); });
    deps.telephony.endConference = vi.fn(async () => { seen.push({ step: 'endConference', flipped: flipped() }); });
    await advanceSession('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith(REP_LEG);
    expect(seen).toEqual([{ step: 'hangup', flipped: false }, { step: 'endConference', flipped: false }]);
    expect(flipped()).toBe(true);
  });
  it('a failed rep-leg hangup (the leg is usually already gone) still tears the room down and completes the run', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, repCallSid: REP_LEG }, items); deps.db = fdb;
    deps.telephony.hangup = vi.fn(async () => { throw new Error('Call is not in-progress'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await advanceSession('S1', deps)).action).toBe('done');
      expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
    } finally { err.mockRestore(); }
  });
  it('a run whose rep never joined (no stamped leg) hangs up nothing', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await advanceSession('S1', deps);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
  });
  it('still completes the run when releasing the conference fails (best-effort, never throws)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'done', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', outcome: 'connected' }];
    const deps = makeDeps({
      telephony: {
        originate: vi.fn(async () => ({ callId: 'CA1' })),
        bridgeToRep: vi.fn(async () => {}),
        hangup: vi.fn(async () => {}),
        endConference: vi.fn(async () => { throw new Error('twilio 500'); }),
      },
    });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r.action).toBe('done');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
  });
  it('pauses the session and returns { action: "paused_no_numbers" } when the DID pool is empty', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps({ pickDid: vi.fn(async () => null) as any });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r.action).toBe('paused_no_numbers');
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
  });
  it('asks pickDid with runKind "agent" for a Task session and "pool" otherwise', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+16195550100', secondaryNumber: null, followupEligible: true }];
    const d1 = makeDeps(); d1.db = fakeDb({ ...baseSession, objectType: 'Task' }, items);
    await advanceSession('S1', d1);
    expect(d1.pickDid).toHaveBeenCalledWith(expect.objectContaining({ runKind: 'agent', toE164: '+16195550100' }));
    const d2 = makeDeps(); d2.db = fakeDb(baseSession, items);
    await advanceSession('S1', d2);
    expect(d2.pickDid).toHaveBeenCalledWith(expect.objectContaining({ runKind: 'pool' }));
  });
  it('a customer_ceiling skip marks the item skipped and moves on without pausing', async () => {
    const items = [
      { id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+1', secondaryNumber: null, followupEligible: true },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+2', secondaryNumber: null, followupEligible: true },
    ];
    const pickDid = vi.fn().mockResolvedValueOnce({ skip: 'customer_ceiling' }).mockResolvedValueOnce({ e164: '+16190000000' });
    const deps = makeDeps({ pickDid } as any); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'customer_ceiling' }) });
    expect(r.action).toBe('dialing');
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
  });
  it('does NOT clobber a row a concurrent advance already claimed while pickDid was running', async () => {
    // The ceiling skip lands three queries after the row was read, so another
    // advance can have flipped it 'pending' -> 'dialing' in between. An
    // unconditional UPDATE would overwrite a LIVE dial with 'skipped'; the
    // guarded write matches 0 rows instead, and we back off rather than place a
    // second concurrent call for the same rep.
    const items = [
      { id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null },
    ];
    const pickDid = vi.fn(async () => {
      items[0]!.status = 'dialing'; // the other advance won the claim mid-pick
      return { skip: 'customer_ceiling' };
    });
    const deps = makeDeps({ pickDid } as any); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ outcome: 'customer_ceiling' }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(r.action).toBe('waiting');
  });
  it('skips (does not dial) an item whose recipient is currently out of calling hours', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps({ withinCallingHours: vi.fn(() => false) as any });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(deps.pickDid).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({
      patch: expect.objectContaining({ status: 'skipped', outcome: 'out_of_hours' }),
    });
    // With only one item, out-of-hours skip leaves nothing pending -> the
    // session completes on this same advance.
    expect(r.action).toBe('done');
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
    const deps = makeDeps({ telephony: { originate: vi.fn(async () => { throw new Error('twilio 500'); }), bridgeToRep: vi.fn(async () => {}), hangup: vi.fn(async () => {}), endConference: vi.fn(async () => {}) } });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await expect(advanceSession('S1', deps)).rejects.toThrow('twilio 500');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'dialing' }) }); // claim landed
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'pending' }) }); // then rolled back
  });
  it('returns waiting_retry (session stays active) when only floor-gated retries remain', async () => {
    const soon = new Date(Date.UTC(2026, 6, 13, 18, 3, 0));
    const items = [{ id: 'r1', ordinal: 3, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 2, retryNotBefore: soon }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(r).toEqual({ action: 'waiting_retry', nextRetryAt: soon.toISOString() });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
  });
});

describe('handleDialOutcome', () => {
  beforeEach(() => { _target = {}; });
  it('a SECOND miss (the owner\'s second dial today) enqueues exactly one rollover job, then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
    // I3: enqueueRollover now takes the transaction handle as its 2nd arg.
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', fromDate: '2026-07-13',
    }), expect.anything());
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
    // A second miss never requeues — no attempt-2 row anywhere, transactional or not.
    expect(fdb._inserts).toHaveLength(0);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });

  it('the rollover enqueue writes INSIDE the miss transaction (wired to the real enqueueFollowupRollover)', async () => {
    // M2: every other test here stubs `enqueueRollover`, so "it rides inside the
    // transaction" was only ever asserted about the stub's call site. Wire the
    // REAL enqueue (which does `db.insert(...).values(...).onConflictDoNothing()`)
    // and pin that its row lands in `_txInserts` — i.e. it went through the `tx`
    // handle — and not in the outer `_inserts`.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, sessionId: 'S1', followupEligible: true }];
    const deps = makeDeps({ enqueueRollover: (jobRow, handle) => enqueueFollowupRollover(handle, jobRow), contactHistory: twoOwnMissesToday() });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({
      orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead',
      fromDate: '2026-07-13', status: 'pending',
    }) });
    expect(fdb._inserts).toHaveLength(0);
  });

  it('the miss transaction never reaches for the outer deps.db.query (M1)', async () => {
    // The fake throws on any outer-`query` access while the tx callback runs, so
    // this passing at all is the assertion: the ordinal lookup used `tx.query`.
    const items = [
      { id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550199', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550199', sessionId: 'S1' },
    ];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await expect(handleDialOutcome('CA1', 'busy', deps)).resolves.toBeUndefined();
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(1);
  });

  it('a duplicated webhook for a SECOND miss does not enqueue twice', async () => {
    // claimReturnsRows:false simulates the conditional no_connect UPDATE
    // matching 0 rows — another invocation for this same call already won
    // the CAS. The rollover enqueue rides inside that same transaction, so
    // losing the CAS must also mean losing the enqueue.
    // The history says the rollover is due, so only the lost CAS stops it.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });

  it('a FIRST miss re-queues the record as an attempt-2 row at the end, dialing the OTHER number with a 5-min floor — and does NOT roll over (one dial today)', async () => {
    // sessionId is set explicitly on the item here (unlike most fixtures in this
    // file) because the requeue insert below copies it verbatim via
    // `item.sessionId` — must match baseSession.id for the assertion to mean
    // anything. Attempt 1 dials the primary only; the retry pass carries the
    // pair forward unchanged and dials the secondary, with no fallback left.
    const items = [
      { id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550199', sessionId: 'S1', followupEligible: true },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+2', secondaryNumber: null, sessionId: 'S1' },
    ];
    const deps = makeDeps({ contactHistory: oneOwnDialToday() }); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    // I4c: the attempt-2 row lands in `_txInserts`, NOT `_inserts` — it must
    // ride inside the same transaction as the CAS (I3), not after it.
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({
      sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', attempt: 2, ordinal: 2,
      toNumber: '+16195550199', fallbackNumber: null,
      primaryNumber: '+16195550100', secondaryNumber: '+16195550199', status: 'pending',
    }) });
    const ins = fdb._txInserts.find((x: any) => x.values.attempt === 2)!.values;
    expect(ins.retryNotBefore.getTime() - deps.nowUtc.getTime()).toBe(5 * 60_000);
  });
  it('a duplicated webhook for the first miss does not insert a second attempt-2 row', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });

  it('a Task run: the second miss enqueues the rollover with the dialed task id', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, taskId: '00T1', followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); deps.db = fakeDb({ ...baseSession, objectType: 'Task' }, items);
    await handleDialOutcome('CA1', 'busy', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ sourceTaskId: '00T1', recordId: '00Q1' }), expect.anything());
  });
  it('the attempt-2 requeue row carries the task id and eligibility forward (else attempt 2 would roll a "Check in" as eligible)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '0031', objectType: 'Contact', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null, taskId: '00T2', followupEligible: false }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, objectType: 'Task' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    // The requeue rides inside the miss transaction (I4c), so it lands in `_txInserts`.
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, taskId: '00T2', followupEligible: false }) });
  });
  it('the attempt-2 requeue row carries the display name forward (else the retry rings with a nameless card)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null, sessionId: 'S1', displayName: 'Ada Lovelace' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    // Carried, not defaulted: the column is nullable, so a requeue that forgot
    // it would silently write null and the second ring would show only the number.
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, recordId: '00Q1', displayName: 'Ada Lovelace' }) });
  });
  it('a Task run: a non-follow-up task is dialed twice but never enqueues a rollover', async () => {
    // The history says the rollover is due, so only the eligibility flag stops it.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '0031', objectType: 'Contact', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, taskId: '00T2', followupEligible: false }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb({ ...baseSession, objectType: 'Task' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });

  it('a legacy row with no number left to retry never requeues a null number — and still rolls on the owner\'s second dial today', async () => {
    // I1: rows created before migration 0024 have no primaryNumber/secondaryNumber.
    // toNumber is ALSO null here (the row already exhausted its numbers) — with
    // a real number in toNumber this would legitimately requeue using it (a
    // legacy row mid-run still has a dialable number to retry with). The
    // rollover no longer hangs off "nothing left to retry": it is the day's
    // count, and this history says it is due.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: null, fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: null, secondaryNumber: null, sessionId: 'S1', followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
  });
  it('a stopped run: a late first-miss webhook neither requeues nor enqueues when it is the owner\'s only dial today (task stays open)', async () => {
    // One dial in a day leaves the task open — a stopped session's belated
    // first-miss webhook just settles the row to no_connect; it must not
    // resurrect a dead run with a new attempt-2 row, and one dial today is not
    // the two the rollover needs.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: null, sessionId: 'S1', followupEligible: true }];
    const deps = makeDeps({ contactHistory: oneOwnDialToday() }); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });
  it('a stopped run: a late miss that is the owner\'s second dial today still enqueues', async () => {
    // The miss already happened for real — whether the run is live is
    // irrelevant to the day's count, so the rep's follow-up task still rolls.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: null, sessionId: 'S1', followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
  });
  it('a connect never requeues or enqueues', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null, fromNumber: '+16190000000' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._inserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });

  it('no_answer with a fallback number is a plain miss: NO immediate re-dial of the Phone', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'no_answer' }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+12135550199' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('the end-of-run retry dials the OTHER number when the record has one', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, toNumber: '+12135550199', primaryNumber: '+16195550100', secondaryNumber: '+12135550199' }) });
  });
  it('…and the same number again when it has only one', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, toNumber: '+16195550100' }) });
  });

  it('no_answer behaves like any plain no_connect (reason kept; rolls on the owner\'s second dial today)', async () => {
    // attempt: 2 — this is the record's SECOND miss, so nothing re-queues a
    // third attempt; the history says the rollover is due.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: null, followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'no_answer' }) });
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', fromDate: '2026-07-13',
    }), expect.anything());
  });

  it('a plain no_connect (busy / voicemail) NEVER falls back, even when a fallback number exists', async () => {
    // attempt: 2 for the same reason as above — isolates "never falls back" from
    // the separate first-miss-requeues behavior.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: '+12135550199', followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'busy', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+12135550199' }) });
    expect(deps.enqueueRollover).toHaveBeenCalled();
  });

  it('a duplicate/redelivered no_answer for the same call does nothing twice: no requeue, no rollover, no re-dial (compare-and-swap loses)', async () => {
    // claimReturnsRows:false simulates the conditional no_connect UPDATE
    // matching 0 rows — i.e. another invocation for this same call already
    // settled it. The row would otherwise requeue AND roll (first miss in a
    // live run, owner's second dial today), so both are live here.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, followupEligible: true }];
    const deps = makeDeps({ contactHistory: twoOwnMissesToday() }); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending' }) });
    expect(fdb._txInserts).toEqual([]);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('connected bridges + screen-pops and does NOT roll over', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.bridgeToRep).toHaveBeenCalledWith('CA1', 'U1', { repRejoins: false });
    expect(deps.onScreenPop).toHaveBeenCalledWith('U1', 'Lead', '00Q1');
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'connected' }) });
  });
  // The stamp is proof the rep's leg carries the rejoin action (only the join
  // that adds the action writes it). Without that proof the prospect must leave
  // the room standing: ending it under a leg that cannot rejoin ends the rep's
  // call — a run in flight across the deploy would die after one conversation.
  it('connected lets the prospect leg end the room ONLY when the run has a stamped rep leg', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, repCallSid: REP_LEG }, items);
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.bridgeToRep).toHaveBeenCalledWith('CA1', 'U1', { repRejoins: true });
  });
  it('connected records a sticky (org, rep, lead) -> pool DID binding when both numbers are known', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fromNumber: '+16190000000', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(fdb._inserts).toContainEqual({
      values: expect.objectContaining({
        orgId: 'O1', assignedUserId: 'U1', recipientE164: '+16195550100', e164: '+16190000000',
      }),
    });
  });
  it('connected skips the sticky write when fromNumber is missing (guard against null)', async () => {
    // fromNumber is only set once the engine claims a pool DID for the dial;
    // if it's somehow absent, recordConnectSticky must not be called at all
    // (rather than upserting a bogus e164) — this also proves the guard, not
    // just a caught error, since the fake db's `insert` would otherwise
    // record a call with an undefined e164.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(fdb._inserts).toEqual([]);
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
  it('stamps skipped BEFORE hanging up, so the hangup\'s completed/canceled callback finds the row settled', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    deps.telephony.hangup = vi.fn(async () => {
      expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped' }) });
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await skipCurrent('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
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
  it('releases the rep conference on stop, so the softphone Device is freed', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); deps.db = fakeDb(baseSession, items);
    await stopSession('S1', deps);
    expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
  });
  it('hangs up the rep\'s own leg on stop — active or paused — and releases BEFORE the session leaves its live status', async () => {
    for (const status of ['active', 'paused']) {
      const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
      const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status, repCallSid: REP_LEG }, items); deps.db = fdb;
      const seen: Array<{ step: string; flipped: boolean }> = [];
      const flipped = () => fdb._writes.some((w: any) => w.patch.status === 'stopped');
      deps.telephony.hangup = vi.fn(async () => { seen.push({ step: 'hangup', flipped: flipped() }); });
      deps.telephony.endConference = vi.fn(async () => { seen.push({ step: 'endConference', flipped: flipped() }); });
      await stopSession('S1', deps);
      expect(deps.telephony.hangup).toHaveBeenCalledTimes(1);
      expect(deps.telephony.hangup).toHaveBeenCalledWith(REP_LEG);
      expect(seen).toEqual([{ step: 'hangup', flipped: false }, { step: 'endConference', flipped: false }]);
      expect(flipped()).toBe(true);
    }
  });
  // The room name is rep-scoped. Stopping a PAUSED run while the rep has a NEW
  // active run (the paused one is a zombie from a dead tab, being reaped, or
  // stopped from the new run's "Stop the other run") must hang up the zombie's
  // own leg only: a by-name teardown would find the NEW run's room and drop the
  // rep and whoever they are talking to.
  it('stopping a paused run hangs up its own leg but leaves the room alone when another run of the rep\'s is active', async () => {
    const live = { session: { ...baseSession, id: 'S-LIVE', status: 'active' }, items: [] };
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'paused', repCallSid: REP_LEG }, items, { otherSessions: [live] }); deps.db = fdb;
    await stopSession('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith(REP_LEG);
    expect(deps.telephony.endConference).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'stopped' }) });
  });

  it('…but does tear the room down when the rep has no other active run (only a ready or paused one)', async () => {
    for (const status of ['ready', 'paused']) {
      const other = { session: { ...baseSession, id: 'S-OTHER', status }, items: [] };
      const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
      const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, status: 'paused', repCallSid: REP_LEG }, items, { otherSessions: [other] });
      await stopSession('S1', deps);
      expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
    }
  });

  it('an ACTIVE run always owns the room (the index makes it the rep\'s only one): no cross-run lookup', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, repCallSid: REP_LEG }, items, { otherSessions: [] }); deps.db = fdb;
    const spy = vi.spyOn(fdb.query.dialerSessions, 'findMany');
    await stopSession('S1', deps);
    expect(deps.telephony.endConference).toHaveBeenCalledWith('U1');
    expect(spy).not.toHaveBeenCalled();
  });

  // Same cross-run rule as the conference: a ready / stopped / done session has
  // no leg of its own, and a stale sid must never be hung up on its behalf.
  it('never hangs up a rep leg for a session that is not live', async () => {
    for (const status of ['ready', 'stopped', 'done']) {
      const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
      const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, status, repCallSid: REP_LEG }, items);
      await stopSession('S1', deps);
      expect(deps.telephony.hangup).not.toHaveBeenCalled();
    }
  });
  it('still stops when releasing the conference fails (best-effort, never throws)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps({
      telephony: {
        originate: vi.fn(async () => ({ callId: 'CA1' })),
        bridgeToRep: vi.fn(async () => {}),
        hangup: vi.fn(async () => {}),
        endConference: vi.fn(async () => { throw new Error('twilio 500'); }),
      },
    });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await stopSession('S1', deps);
    expect(r).toEqual({ action: 'stopped' });
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'stopped' }) });
  });
  it('a ready session (never started) stops with only the status written — no hangup, no conference release, no rollover', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'ready' }, items); deps.db = fdb;
    expect(await stopSession('S1', deps)).toEqual({ action: 'stopped' });
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(deps.telephony.endConference).not.toHaveBeenCalled();
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'stopped' }) }]);
  });
  it('flips the session to stopped BEFORE hanging up, so the hangup\'s terminal callback cannot originate the next record', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      deps.telephony.hangup = vi.fn(async () => {
        expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'stopped' }) });
      });
      await stopSession('S1', deps);
      expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
  });
  it('does not release the rep conference for an already-stopped session (the name is rep-scoped; another run may own it)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, items); deps.db = fdb;
    expect(await stopSession('S1', deps)).toEqual({ action: 'stopped' });
    expect(deps.telephony.endConference).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'stopped' }) }]);
  });
});

describe('repNext', () => {
  beforeEach(() => { _target = {}; });
  it('hangs up the connected prospect, marks the item done, then advances', async () => {
    // The prospect must be disconnected on Next — otherwise their leg lingers in
    // the rep's conference and the next prospect is bridged into the same room.
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await repNext('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(r).toBeDefined();
  });
  it('still completes Next when the hangup fails (best-effort, does not throw)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps({
      telephony: {
        originate: vi.fn(async () => ({ callId: 'CA1' })),
        bridgeToRep: vi.fn(async () => {}),
        hangup: vi.fn(async () => { throw new Error('twilio 500'); }),
        endConference: vi.fn(async () => {}),
      },
    });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
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
  it('settles the item done BEFORE hanging up — the hang-up stamp must not fire on the rep\'s own Next', async () => {
    // Regression guard for the ORDER fix: hanging up makes Twilio send the
    // `completed` status callback, which now maps to `hangup` in
    // handleDialOutcome's connected-hangup stamp. If the item were still
    // `connected` when that callback lands, it would read as "the prospect
    // hung up" and stamp `prospect_ended_at` on a call the REP ended via
    // Next. Settled first, the callback finds a `done` row and no-ops.
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const seen: boolean[] = [];
    deps.telephony.hangup = vi.fn(async () => { seen.push(fdb._writes.some((w: any) => w.patch.status === 'done')); });
    await repNext('S1', deps);
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(seen).toEqual([true]);
  });
});

describe('handleDialOutcome — the prospect hangs up on a connected call', () => {
  beforeEach(() => { _target = {}; });
  it('stamps prospect_ended_at, does NOT advance, does NOT redial', async () => {
    const items = [
      { id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null },
    ];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'hangup', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ prospectEndedAt: expect.any(Date) }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    // M4c: the stamp branch must never insert anything either — not the
    // pending item i2 (unaffected), not a redial copy, not a dial-attempt row.
    expect(fdb._inserts).toEqual([]);
    expect(fdb._txInserts).toEqual([]);
  });
  it('the WHERE guard is isNull(prospect_ended_at) — pinned as rendered SQL, not just the JS-level dedup check', async () => {
    // M3: `item.prospectEndedAt == null` above already stops a second JS-level
    // entry into this branch, but the WHERE clause is the real defense against
    // two nearly-simultaneous callbacks racing each other in Postgres. Pin it
    // as rendered SQL so a future refactor can't silently drop it while the
    // JS guard keeps every existing test green.
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'hangup', deps);
    const stampWrite = fdb._updateWheres.find((w: any) => 'prospectEndedAt' in w.patch);
    expect(stampWrite).toBeDefined();
    const { sql: text } = new PgDialect().sqlToQuery(stampWrite.where);
    expect(text).toContain('"prospect_ended_at" is null');
  });
  it('a duplicate callback does not stamp twice (only a null prospect_ended_at is written)', async () => {
    // The item is already stamped (a first callback already ran) but still
    // `connected` — the rep hasn't chosen Redial/Resume yet. A redelivered
    // terminal callback for the same call must be a total no-op: the JS guard
    // (`prospectEndedAt == null`) refuses to re-enter the stamp branch, and
    // falls into the `status !== 'dialing'` early return below it.
    const items = [
      { id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', prospectEndedAt: new Date() },
    ];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'hangup', deps);
    expect(fdb._writes).toEqual([]);
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('a duplicate async-AMD "human" for the same call arrives as connected outcome and is not treated as a hang-up', async () => {
    // Verified fact from the brief: a duplicate async-AMD human classification
    // re-delivers as the `connected` outcome, never `hangup`. The stamp branch
    // explicitly excludes `outcome === 'connected'` so this never mis-stamps a
    // still-live call as ended.
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ prospectEndedAt: expect.any(Date) }) });
  });
});

describe('redialCurrent', () => {
  beforeEach(() => { _target = {}; });
  const redialable = (over: Record<string, unknown> = {}) => [{
    id: 'i1', ordinal: 3, status: 'connected', toNumber: '+12135550199',
    primaryNumber: '+16195550100', secondaryNumber: '+12135550199',
    recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1,
    prospectEndedAt: new Date(), displayName: 'Ada', taskId: null,
    followupEligible: true, listPosition: 42, ...over,
  }];
  it('closes the connected item as done and dials the same person again next, on the number that connected, linked by redial_of — atomically, inside one transaction', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, redialable()); deps.db = fdb;
    await redialCurrent('S1', deps);
    // Both the settle and the copy insert ride through the conditional-update
    // transaction (the Minor "make the redial atomic" fix). The fake's `tx`
    // update pushes onto the SAME shared `_writes` array the outer handle uses
    // (by design — see the fakeDb doc comment), so `_txWrites` is the one that
    // proves this specific write rode INSIDE the transaction rather than on
    // the plain outer db handle; `_inserts` stays outer-only and must be empty.
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(fdb._txWrites).toContainEqual({ patch: expect.objectContaining({ status: 'done' }), where: expect.anything() });
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({
      recordId: '00Q1', toNumber: '+12135550199', ordinal: 3, attempt: 1,
      redialOf: 'i1', displayName: 'Ada', status: 'pending', listPosition: 42,
    }) });
    expect(fdb._inserts).toEqual([]);
  });
  it('is a no-op (returns the session status) when nothing is connected', async () => {
    // Nothing connected — a still-`dialing` item counts as in-flight but is
    // not eligible for redial, so this delegates straight to advanceSession,
    // which finds the in-flight item and waits. No insert either way.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await redialCurrent('S1', deps);
    expect(r).toEqual({ action: 'waiting' });
    expect(fdb._inserts).toEqual([]);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('refuses a still-live connected call: a stale tab pressing Redial before the hang-up stamp lands must never end a live conversation', async () => {
    // Same fixture as the happy path, minus `prospectEndedAt` — the prospect
    // is still on the line. Without this guard, redialCurrent would mark a
    // LIVE call 'done' and queue a copy while the prospect's leg is still in
    // the rep's conference.
    const items = redialable({ prospectEndedAt: null });
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const r = await redialCurrent('S1', deps);
    // advanceSession sees the item still `connected` (in flight) and waits.
    expect(r).toEqual({ action: 'waiting' });
    expect(fdb._writes).toEqual([]);
    expect(fdb._txWrites).toEqual([]);
    expect(fdb._inserts).toEqual([]);
    expect(fdb._txInserts).toEqual([]);
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
  });
  it('refuses on a session that is not active or paused (e.g. stopped) — no copy is ever inserted', async () => {
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, redialable()); deps.db = fdb;
    await redialCurrent('S1', deps);
    expect(fdb._inserts).toEqual([]);
    expect(fdb._txInserts).toEqual([]);
  });
  it('on a PAUSED session (Pause is available mid-conversation): inserts the copy and leaves the run paused — advanceSession never dials a non-active session', async () => {
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'paused' }, redialable()); deps.db = fdb;
    const r = await redialCurrent('S1', deps);
    expect(r).toEqual({ action: 'idle' });
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ redialOf: 'i1', status: 'pending' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('is atomic: a double-submitted Redial only ever inserts ONE copy (the conditional update guards it)', async () => {
    // `claimReturnsRows: false` simulates the SAME conditional update losing
    // the race — Postgres semantics for `UPDATE ... WHERE status = 'connected'
    // AND prospect_ended_at IS NOT NULL RETURNING id` matching 0 rows because
    // the first submission already flipped the item to 'done'. A paused
    // session keeps advanceSession's OWN claim transaction out of the picture
    // entirely, isolating this to redialCurrent's transaction alone.
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'paused' }, redialable(), { claimReturnsRows: false }); deps.db = fdb;
    await redialCurrent('S1', deps);
    expect(fdb._txInserts).toEqual([]);
  });
});

describe('endCurrent', () => {
  beforeEach(() => { _target = {}; });
  it('flips the session to PAUSED first, then settles the item done, then hangs up — closing the race with the 5s retry nudge', async () => {
    // Fix-round-1 #1: between the item's done-write and the hangup, the OLD
    // order left the session 'active' with nothing "in flight" (the item was
    // already 'done', not 'connected'/'dialing') — exactly the window
    // followup-worker.ts's startRetryNudgeLoop (or a concurrent advance) could
    // dial the NEXT record into. Paused first closes it, mirroring
    // stopSession's "flip first, hang up last" rule.
    const items = [
      { id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null },
    ];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    const seen: Array<{ paused: boolean; done: boolean }> = [];
    deps.telephony.hangup = vi.fn(async () => {
      seen.push({
        paused: fdb._writes.some((w: any) => w.patch.status === 'paused'),
        done: fdb._writes.some((w: any) => w.patch.status === 'done'),
      });
    });
    expect(await endCurrent('S1', deps)).toEqual({ action: 'paused' });
    expect(seen).toEqual([{ paused: true, done: true }]);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('works on a PAUSED run too — Pause is available mid-conversation, so End must too: settles done, hangs up, stays paused', async () => {
    // Fix-round-1 #2: a session can be `paused` with a `connected` item since
    // Pause doesn't hang up the prospect. End must still work there, not just
    // on `active`.
    const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'paused' }, items); deps.db = fdb;
    expect(await endCurrent('S1', deps)).toEqual({ action: 'paused' });
    expect(deps.telephony.hangup).toHaveBeenCalledWith('CA1');
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'done' }) });
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'paused' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('is a no-op on a session that is not active or paused (ready, stopped, or done) — never originates', async () => {
    for (const status of ['ready', 'stopped', 'done']) {
      const items = [{ id: 'i1', ordinal: 0, status: 'connected', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
      const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status }, items); deps.db = fdb;
      expect(await endCurrent('S1', deps)).toEqual({ action: status });
      expect(deps.telephony.hangup).not.toHaveBeenCalled();
      expect(fdb._writes).toEqual([]);
    }
  });
  it('is a no-op write-wise (still pauses the run, hangs up nothing) when no item is connected — active session', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    expect(await endCurrent('S1', deps)).toEqual({ action: 'paused' });
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'paused' }) }]);
  });
  it('…and the same when the session is already paused with nothing connected (the pause write is a harmless no-op)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: null }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'paused' }, items); deps.db = fdb;
    expect(await endCurrent('S1', deps)).toEqual({ action: 'paused' });
    expect(deps.telephony.hangup).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([{ patch: expect.objectContaining({ status: 'paused' }) }]);
  });
});

describe('handleDialOutcome — honest miss reasons', () => {
  beforeEach(() => { _target = {}; });
  const dialing = (over: Record<string, unknown> = {}) => [{
    id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead',
    callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: null, followupEligible: true, ...over,
  }];

  it.each(['voicemail', 'fax', 'busy', 'failed', 'canceled', 'hangup'] as const)(
    '%s settles the row as no_connect with that reason in `outcome`',
    async (reason) => {
      const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing()); deps.db = fdb;
      await handleDialOutcome('CA1', reason, deps);
      expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: reason }) });
    },
  );

  // The immediate Mobile→Phone fallback is gone: no reason earns it any more,
  // no_answer included. The other number waits for the end-of-run retry.
  it.each(['voicemail', 'no_answer'] as const)(
    'a %s with a fallback number still untried is a MISS — nothing falls back immediately',
    async (reason) => {
      const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing({ fallbackNumber: '+16195550200', attempt: 1 })); deps.db = fdb;
      await handleDialOutcome('CA1', reason, deps);
      expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+16195550200' }) });
      expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: reason }) });
    },
  );

  it('the status backstop never overwrites a settled row: a hangup for a call AMD already stamped writes nothing', async () => {
    const deps = makeDeps();
    const fdb = fakeDb(baseSession, dialing({ status: 'no_connect', outcome: 'voicemail' })); deps.db = fdb;
    await handleDialOutcome('CA1', 'hangup', deps);
    expect(fdb._writes).toEqual([]);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
});

describe('handleDialOutcome — rollover is per day, per owner', () => {
  beforeEach(() => { _target = {}; });
  const DAY = new Date(Date.UTC(2026, 6, 13, 7, 0, 0));
  const miss = (over: Record<string, unknown> = {}) => [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', primaryNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, followupEligible: true, taskId: null, ...over }];
  const d = (userId: string, hoursAgo: number, connected = false) => ({ userId, sessionId: 'S-x', toNumber: '+1', at: new Date(Date.UTC(2026, 6, 13, 18 - hoursAgo)), connected, source: 'dialer' as const, skipped: false });

  it("first miss of the day (only this dial on the log): requeue, no rollover — even on a STOPPED run", async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 0)]) }); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, miss()); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it("the owner's second dial of the day misses → rollover, whatever run it was in and whether or not the run is live", async () => {
    for (const status of ['active', 'stopped']) {
      const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); deps.db = fakeDb({ ...baseSession, status }, miss());
      await handleDialOutcome('CA1', 'voicemail', deps);
      expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ userId: 'U1', recordId: '00Q1', fromDate: '2026-07-13', sourceTaskId: null }), expect.anything());
    }
  });
  it('another rep\'s dial does not count toward the owner\'s two', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U2', 3), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss());
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it('a connect earlier today by the owner means no rollover', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3, true), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss());
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it('the history read for the rollover starts at the org day, and the enqueue still rides inside the CAS transaction', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss());
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect((deps.contactHistory as any).mock.calls[0][2]).toEqual(DAY);
    expect((deps.enqueueRollover as any).mock.calls[0][1]).toBeDefined(); // the tx handle
  });
  it('a task the rep may not roll (followupEligible=false) still never rolls', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); deps.db = fakeDb(baseSession, miss({ followupEligible: false }));
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it('a live run\'s first miss that is also the owner\'s second dial today BOTH requeues and rolls — the two are independent', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3), d('U1', 0)]) }); const fdb = fakeDb(baseSession, miss()); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, recordId: '00Q1' }) });
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
  });
  // Fix-round-1 #4 (controller ruling): a redial copy (redialOf set) must
  // never get its own end-of-run retry. Without this exclusion, a missed
  // redial would queue an attempt-2 row and the person who hung up would get
  // an automatic THIRD dial — contradicting "a hang-up never auto-redials".
  it('a missed REDIAL copy never gets its own attempt-2 requeue', async () => {
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 0)]) });
    const fdb = fakeDb(baseSession, miss({ redialOf: 'i0' })); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toEqual([]);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'voicemail' }) });
  });
  it('a missed redial copy still reads correctly for rollover: the ORIGINAL call connected, so the per-day rule (never connected) correctly does not roll — redialOf only blocks the requeue, not the rollover check', async () => {
    // `d('U1', 3, true)` is the original call that connected before the
    // prospect hung up; `d('U1', 0)` is the redial copy's own miss. Two dials
    // today, but NOT "every one of them a miss" — rolloverDue requires that —
    // so this must not enqueue, for the ordinary per-day reason, not because
    // of anything redial-specific.
    const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => [d('U1', 3, true), d('U1', 0)]) });
    const fdb = fakeDb(baseSession, miss({ redialOf: 'i0' })); deps.db = fdb;
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(fdb._txInserts).toEqual([]); // still no requeue
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });
  it('ORDER: the history read (the person, since the org day) lands BEFORE the transaction opens; inside it, CAS → requeue insert → enqueue', async () => {
    // The read must never ride inside the transaction: it is two queries on the
    // outer pool, and a second checkout while the tx holds a client is the
    // deadlock every `tx` handle in this file exists to avoid.
    const order: string[] = [];
    const deps = makeDeps({
      orgDayStart: DAY,
      contactHistory: vi.fn(async () => { order.push('history'); return [d('U1', 3), d('U1', 0)]; }),
      enqueueRollover: vi.fn(async () => { order.push('enqueue'); }),
    });
    const fdb = fakeDb(baseSession, miss()); deps.db = fdb;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => {
      order.push('tx');
      const realUpdate = tx.update.bind(tx); const realInsert = tx.insert.bind(tx);
      tx.update = (tbl: any) => { order.push('cas'); return realUpdate(tbl); };
      tx.insert = (tbl: any) => { order.push('requeue'); return realInsert(tbl); };
      return fn(tx);
    });
    await handleDialOutcome('CA1', 'voicemail', deps);
    expect(order).toEqual(['history', 'tx', 'cas', 'requeue', 'enqueue']);
    expect(deps.contactHistory).toHaveBeenCalledWith('O1', { numbers: ['+1'], recordId: '00Q1' }, DAY);
  });
  it('a failed rollover history read fails closed: no rollover, logged — and the miss still settles and requeues', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps = makeDeps({ orgDayStart: DAY, contactHistory: vi.fn(async () => { throw new Error('pool'); }) });
      const fdb = fakeDb(baseSession, miss()); deps.db = fdb;
      await handleDialOutcome('CA1', 'voicemail', deps);
      expect(deps.enqueueRollover).not.toHaveBeenCalled();
      expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'voicemail' }) });
      expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2 }) });
      expect(err).toHaveBeenCalledWith('[dialer] rollover history read failed', expect.objectContaining({ itemId: 'i1', err: 'pool' }));
    } finally { err.mockRestore(); }
  });
});

describe('startSession — the rep pressed Start dialing', () => {
  beforeEach(() => { _target = {}; });
  const ready = { ...baseSession, status: 'ready' };
  const pending = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];

  it('flips ready → active, then originates the first call', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    const r = await startSession('S1', deps);
    expect(fdb._writes[0]).toEqual({ patch: expect.objectContaining({ status: 'active' }) });
    expect(deps.telephony.originate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ action: 'dialing' });
  });

  it('is idempotent while a call is in flight: a second Start on an active session originates nothing', async () => {
    const dialing = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1 }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, dialing); deps.db = fdb;
    expect(await startSession('S1', deps)).toEqual({ action: 'waiting' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([]);
  });

  it('re-kicks an active session whose first originate failed (nothing in flight, rows still pending)', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    const r = await startSession('S1', deps);
    expect(deps.telephony.originate).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ action: 'dialing' });
    // No ready -> active flip was written: the session was already active.
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'active' }) });
  });

  it('two Starts against one session: the first flips and dials, the second finds it active and waits', async () => {
    // `pending` above is `const` with a literal `callId: null`, which rejects
    // the later `'CA1'` assignment below — declare a locally-typed fixture
    // instead of mutating the shared one.
    const items: Array<{ id: string; ordinal: number; status: string; toNumber: string; recordId: string; objectType: string; callId: string | null; attempt: number }> = [
      { id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 },
    ];
    const deps = makeDeps(); const fdb = fakeDb(ready, items); deps.db = fdb;
    expect(await startSession('S1', deps)).toMatchObject({ action: 'dialing' });
    // Simulate the first call now being in flight (the fake's items are static).
    items[0]!.status = 'dialing'; items[0]!.callId = 'CA1';
    expect(await startSession('S1', deps)).toEqual({ action: 'waiting' });
    expect(deps.telephony.originate).toHaveBeenCalledTimes(1);
  });

  it('never revives a stopped session', async () => {
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, pending); deps.db = fdb;
    expect(await startSession('S1', deps)).toEqual({ action: 'stopped' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });

  // A run PAUSED with a dial still ringing (the rep's tab died and the server
  // paused it — see routes/telephony.ts pauseRunThatLostItsLeg) does not hold
  // the one-active-run slot, so nothing stopped a new run from starting while
  // that dial was out. When it answered, `handleDialOutcome` bridged the human
  // into the rep's room — which by then was the NEW run's. Refuse, naming the
  // paused run, so the confirm block offers "Stop the other run" exactly as it
  // does for an active one (and stopping it hangs that dial up).
  it('refuses to start while a PAUSED run of the rep\'s still has a dial in flight, naming that run', async () => {
    const zombie = { session: { ...baseSession, id: 'S-PAUSED', status: 'paused' }, items: [{ id: 'z1', ordinal: 0, status: 'dialing', callId: 'CAz', toNumber: '+1', recordId: '00Q9', objectType: 'Lead' }] };
    const deps = makeDeps(); const fdb = fakeDb(ready, pending, { otherSessions: [zombie] }); deps.db = fdb;
    expect(await startSession('S1', deps)).toEqual({ action: 'conflict', activeSessionId: 'S-PAUSED' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(fdb._writes).toEqual([]); // still ready — Start again once the other run is stopped
  });

  it('…and a connected call counts as in flight too', async () => {
    const zombie = { session: { ...baseSession, id: 'S-PAUSED', status: 'paused' }, items: [{ id: 'z1', ordinal: 0, status: 'connected', callId: 'CAz', toNumber: '+1', recordId: '00Q9', objectType: 'Lead' }] };
    const deps = makeDeps(); deps.db = fakeDb(ready, pending, { otherSessions: [zombie] });
    expect(await startSession('S1', deps)).toMatchObject({ action: 'conflict', activeSessionId: 'S-PAUSED' });
  });

  it('a paused run with nothing in flight does not block a new Start', async () => {
    const idle = { session: { ...baseSession, id: 'S-PAUSED', status: 'paused' }, items: [{ id: 'z1', ordinal: 0, status: 'no_connect', callId: 'CAz', toNumber: '+1', recordId: '00Q9', objectType: 'Lead' }, { id: 'z2', ordinal: 1, status: 'pending', callId: null, toNumber: '+1', recordId: '00Q8', objectType: 'Lead' }] };
    const deps = makeDeps(); deps.db = fakeDb(ready, pending, { otherSessions: [idle] });
    expect(await startSession('S1', deps)).toMatchObject({ action: 'dialing' });
  });

  it('the paused-run check is scoped to the rep, excludes the session being started, and asks for paused runs only', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending, { otherSessions: [] }); deps.db = fdb;
    const spy = vi.spyOn(fdb.query.dialerSessions, 'findMany');
    await startSession('S1', deps);
    expect(spy).toHaveBeenCalledTimes(1);
    const { sql: text, params } = new PgDialect().sqlToQuery((spy.mock.calls[0]![0] as { where: SQL }).where);
    expect(text.replace(/\s+/g, ' ')).toContain('"dialer_sessions"."id" <> ');
    expect(text.replace(/\s+/g, ' ')).toContain('"dialer_sessions"."status" = ');
    expect(text).toContain('select user_id from dialer_sessions where id = ');
    expect(params).toEqual(['S1', 'paused', 'S1']);
  });

  const conflictViolation = (): Error => Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505', constraint: 'dialer_sessions_one_active_per_user',
  });

  it('reports conflict — with the OTHER run\'s id, and leaves the session ready — when the rep already has an active run', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    const violation = conflictViolation();
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw violation; } }) }) });
    // First lookup = the session being started (for its userId); second = the
    // rep's active run, which the 409 names so the panel can offer to stop it.
    fdb.query.dialerSessions.findFirst = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce({ ...baseSession, id: 'S-OTHER', status: 'active' });
    expect(await startSession('S1', deps)).toEqual({ action: 'conflict', activeSessionId: 'S-OTHER' });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });

  it('reports conflict with a null id when the other run ended between the refused flip and the lookup', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    const violation = conflictViolation();
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw violation; } }) }) });
    fdb.query.dialerSessions.findFirst = vi.fn()
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(null);
    expect(await startSession('S1', deps)).toEqual({ action: 'conflict', activeSessionId: null });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });

  it('rethrows any other database error', async () => {
    const deps = makeDeps(); const fdb = fakeDb(ready, pending); deps.db = fdb;
    fdb.update = () => ({ set: () => ({ where: () => ({ returning: async () => { throw new Error('connection reset'); } }) }) });
    await expect(startSession('S1', deps)).rejects.toThrow('connection reset');
  });
});

describe('advanceSession — contact cadence gate', () => {
  beforeEach(() => { _target = {}; });
  const pending = [{ id: 'i1', ordinal: 0, status: 'pending', toNumber: '+16195550100', primaryNumber: '+16195550100', secondaryNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: null, attempt: 1 }];
  const recent = (sessionId: string | null, hoursAgo: number, over: Record<string, unknown> = {}) =>
    ({ userId: 'U9', sessionId, toNumber: '+16195550100', at: new Date(Date.UTC(2026, 6, 13, 18 - hoursAgo, 0, 0)), connected: false, source: 'dialer', skipped: false, ...over });

  it('skips as cooldown when another run dialed the person in the last 3 h — and asks with BOTH numbers and the record', async () => {
    const deps = makeDeps({ contactHistory: vi.fn(async () => [recent('S-other', 1)]) as any }); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'cooldown' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(deps.contactHistory).toHaveBeenCalledWith('O1', { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' }, expect.any(Date));
    expect(r.action).toBe('done');
  });
  it("dials when the only recent dial is this run's own (end-of-run retry)", async () => {
    const deps = makeDeps({ contactHistory: vi.fn(async () => [recent('S1', 1)]) as any }); deps.db = fakeDb(baseSession, pending);
    expect((await advanceSession('S1', deps)).action).toBe('dialing');
  });
  it('skips as daily_cap in a capped state with three dials in 24 h', async () => {
    const deps = makeDeps({ isDailyCapped: vi.fn(() => true), contactHistory: vi.fn(async () => [recent(null, 20), recent('S1', 10), recent('S1', 5)]) as any });
    const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'daily_cap' }) });
    expect(deps.isDailyCapped).toHaveBeenCalledWith('+16195550100');
  });
  it('the history window is 24 h back from nowUtc (the longest any rule needs)', async () => {
    const deps = makeDeps(); deps.db = fakeDb(baseSession, pending);
    await advanceSession('S1', deps);
    const since = (deps.contactHistory as any).mock.calls[0][2] as Date;
    expect(deps.nowUtc.getTime() - since.getTime()).toBe(24 * 60 * 60_000);
  });
  it('a failed history read: capped state → skip as daily_cap_unverified; not capped → dial (fail open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const capped = makeDeps({ isDailyCapped: vi.fn(() => true), contactHistory: vi.fn(async () => { throw new Error('pool'); }) as any });
      const f1 = fakeDb(baseSession, pending); capped.db = f1;
      await advanceSession('S1', capped);
      expect(f1._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'daily_cap_unverified' }) });
      const open = makeDeps({ contactHistory: vi.fn(async () => { throw new Error('pool'); }) as any }); open.db = fakeDb(baseSession, pending);
      expect((await advanceSession('S1', open)).action).toBe('dialing');
    } finally { err.mockRestore(); }
  });
  it('skips as in_progress_elsewhere when another live run is ringing the person', async () => {
    const deps = makeDeps({ inFlightElsewhere: vi.fn(async () => true) }); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    // Capture the handle the claim transaction hands the engine, to prove the
    // check rides IT and not the outer db.
    let claimTx: unknown;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => { claimTx ??= tx; return fn(tx); });
    await advanceSession('S1', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'skipped', outcome: 'in_progress_elsewhere' }) });
    expect(deps.inFlightElsewhere).toHaveBeenCalledWith(expect.anything(), 'O1', { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' }, 'S1');
    // The first argument is the TRANSACTION's handle. Asking through the outer
    // db would check out a SECOND pool client while the claim transaction holds
    // one — the deadlock `enqueueRollover` takes `tx` to avoid.
    const handle = (deps.inFlightElsewhere as any).mock.calls[0][0];
    expect(handle).toBe(claimTx);
    expect(handle).not.toBe(fdb);
  });
  it('a lost race on the elsewhere skip never clobbers the live dial the winner started', async () => {
    // The skip lands after the claim transaction committed and released the
    // per-session lock, so a concurrent advance can own the row by then. The
    // guarded write must match 0 rows and back off — not overwrite a LIVE dial
    // with 'skipped'. Mirrors the ceiling-skip race above.
    const rows = [{ ...pending[0]! }];
    const deps = makeDeps({
      inFlightElsewhere: vi.fn(async () => { rows[0]!.status = 'dialing'; return true; }), // the other advance won it mid-check
    });
    const fdb = fakeDb(baseSession, rows); deps.db = fdb;
    const r = await advanceSession('S1', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ outcome: 'in_progress_elsewhere' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
    expect(r.action).toBe('waiting');
  });
  it('the in-flight check runs INSIDE the claim transaction, after the per-number lock', async () => {
    const order: string[] = [];
    const deps = makeDeps({ inFlightElsewhere: vi.fn(async () => { order.push('inflight'); return false; }) });
    const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => { const exec = tx.execute; tx.execute = async (q: any) => { const s = new PgDialect().sqlToQuery(q); order.push(`lock:${s.params.join(',')}`); return exec(q); }; order.push('tx'); return fn(tx); });
    await advanceSession('S1', deps);
    expect(order.slice(0, 4)).toEqual(['tx', 'lock:S1', 'lock:dial:+16195550100', 'inflight']);
  });
  it('the attempt row carries record_id', async () => {
    const deps = makeDeps(); const fdb = fakeDb(baseSession, pending); deps.db = fdb;
    await advanceSession('S1', deps);
    expect(fdb._txInserts[0]!.values).toEqual(expect.objectContaining({ recordId: '00Q1' }));
  });
});

describe('handleDialOutcome — connect stamps the dial log', () => {
  it('connected writes connected_at on the attempt row in the same transaction as the status', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    // Both writes must ride ONE transaction: a connect that settled the row but
    // lost the stamp would leave every later run leading with the wrong number.
    // Capture the handle each update went through, as the claim tests do.
    let txCount = 0; let connectTx: unknown; const through: unknown[] = [];
    const realTx = fdb.transaction.bind(fdb);
    fdb.transaction = async (fn: any) => realTx(async (tx: any) => {
      txCount++; connectTx = tx;
      const realUpdate = tx.update.bind(tx);
      tx.update = (tbl: any) => { through.push(tx); return realUpdate(tbl); };
      return fn(tx);
    });
    await handleDialOutcome('CA1', 'connected', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ connectedAt: expect.any(Date) }) });
    expect(txCount).toBe(1);
    expect(through).toHaveLength(2); // the status write and the stamp, both transactional
    expect(through[0]).toBe(connectTx);
    expect(through[1]).toBe(connectTx);
  });
  it('the stamp is scoped to the number THIS call dialed, not every attempt row the item owns', async () => {
    // One item can own two attempt rows (the removed no-answer fallback re-dialed
    // the same item on its Phone, and rows from before its removal still do).
    // Stamping by item alone would mark the number that rang out as connected
    // too — wrecking preferredNumbersFor and the cadence history.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    const stamp = fdb._txWrites.find((w: any) => 'connectedAt' in w.patch)!;
    const { sql: text, params } = new PgDialect().sqlToQuery(stamp.where as SQL);
    expect(text).toContain('"item_id" =');
    expect(text).toContain('"to_number" =');
    expect(params).toEqual(['i1', '+12135550199']);
  });
});

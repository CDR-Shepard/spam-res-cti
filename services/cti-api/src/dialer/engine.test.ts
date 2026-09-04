import { PgDialect } from 'drizzle-orm/pg-core';
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
function fakeDb(session: any, items: any[], opts: { claimReturnsRows?: boolean } = {}) {
  const writes: Array<{ patch: Record<string, unknown> }> = [];
  const inserts: Array<{ values: Record<string, unknown> }> = [];
  // Inserts made through `tx.insert(...)` — i.e. INSIDE `deps.db.transaction`
  // — land here, separately from the outer (non-transactional) `_inserts`.
  // Kept apart so a test can assert an insert rode inside the transaction
  // (I3/I4c) rather than merely happening at some point.
  const txInserts: Array<{ values: Record<string, unknown> }> = [];
  let sessionOverride: Record<string, unknown> = {};
  const claimReturnsRows = opts.claimReturnsRows ?? true;
  const handle: any = {
    _session: session,
    _items: items,
    _writes: writes,
    _inserts: inserts,
    _txInserts: txInserts,
    query: {
      dialerSessions: { findFirst: async () => ({ ...session, ...sessionOverride }) },
      dialerQueueItems: {
        findMany: async () => items,
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
                  const target = items.find((i: any) => params.includes(i.id));
                  if (!target || target.status !== 'pending') return [];
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
        execute: async () => undefined, // pg_advisory_xact_lock(...) — no-op in the fake
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
              where: () => {
                const apply = () => { writes.push({ patch }); Object.assign(_target, patch); };
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
  stopSession,
  repNext,
  type EngineDeps,
} from './engine.js';

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
  it('records exactly one append-only dial attempt, inside the dialing write transaction', async () => {
    // The per-customer ceiling counts these rows. It cannot count
    // dialer_queue_items: the no-answer -> fallback path rewrites to_number /
    // from_number on the same row, erasing the mobile dial from the tally.
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
  it('a SECOND miss enqueues exactly one rollover job, then advances', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
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
    const deps = makeDeps({ enqueueRollover: (jobRow, handle) => enqueueFollowupRollover(handle, jobRow) });
    const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
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
    await expect(handleDialOutcome('CA1', 'no_connect', deps)).resolves.toBeUndefined();
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(1);
  });

  it('a duplicated webhook for a SECOND miss does not enqueue twice', async () => {
    // claimReturnsRows:false simulates the conditional no_connect UPDATE
    // matching 0 rows — another invocation for this same call already won
    // the CAS. The rollover enqueue rides inside that same transaction, so
    // losing the CAS must also mean losing the enqueue.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });

  it('a FIRST miss re-queues the record as an attempt-2 row at the end, with the original numbers and a 5-min floor — and does NOT roll over', async () => {
    // sessionId is set explicitly on the item here (unlike most fixtures in this
    // file) because the requeue insert below copies it verbatim via
    // `item.sessionId` — must match baseSession.id for the assertion to mean
    // anything.
    const items = [
      { id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550199', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: '+16195550199', sessionId: 'S1' },
      { id: 'i2', ordinal: 1, status: 'pending', toNumber: '+2', recordId: '00Q2', objectType: 'Lead', callId: null, attempt: 1, primaryNumber: '+2', secondaryNumber: null, sessionId: 'S1' },
    ];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    // I4c: the attempt-2 row lands in `_txInserts`, NOT `_inserts` — it must
    // ride inside the same transaction as the CAS (I3), not after it.
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({
      sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', attempt: 2, ordinal: 2,
      toNumber: '+16195550100', fallbackNumber: '+16195550199',
      primaryNumber: '+16195550100', secondaryNumber: '+16195550199', status: 'pending',
    }) });
    const ins = fdb._txInserts.find((x: any) => x.values.attempt === 2)!.values;
    expect(ins.retryNotBefore.getTime() - deps.nowUtc.getTime()).toBe(5 * 60_000);
  });
  it('a duplicated webhook for the first miss does not insert a second attempt-2 row', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });

  it('a Task run: the second miss enqueues the rollover with the dialed task id', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, taskId: '00T1', followupEligible: true }];
    const deps = makeDeps(); deps.db = fakeDb({ ...baseSession, objectType: 'Task' }, items);
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({ sourceTaskId: '00T1', recordId: '00Q1' }), expect.anything());
  });
  it('the attempt-2 requeue row carries the task id and eligibility forward (else attempt 2 would roll a "Check in" as eligible)', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '0031', objectType: 'Contact', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null, taskId: '00T2', followupEligible: false }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, objectType: 'Task' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    // The requeue rides inside the miss transaction (I4c), so it lands in `_txInserts`.
    expect(fdb._txInserts).toContainEqual({ values: expect.objectContaining({ attempt: 2, taskId: '00T2', followupEligible: false }) });
  });
  it('a Task run: a non-follow-up task is dialed twice but never enqueues a rollover', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '0031', objectType: 'Contact', callId: 'CA1', attempt: 2, primaryNumber: '+1', secondaryNumber: null, taskId: '00T2', followupEligible: false }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, objectType: 'Task' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });

  it('a legacy row with no primaryNumber (pre-migration) enqueues the rollover instead of requeuing a null number', async () => {
    // I1: rows created before migration 0024 have no primaryNumber/secondaryNumber.
    // toNumber is ALSO null here (the row already exhausted its numbers) — with
    // a real number in toNumber this would legitimately requeue using it (a
    // legacy row mid-run still has a dialable number to retry with).
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: null, fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: null, secondaryNumber: null, sessionId: 'S1', followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
  });
  it('a stopped run: a late first-miss webhook neither requeues nor enqueues (task stays open)', async () => {
    // Spec: "a rep who stops after one pass leaves those tasks open" — a
    // stopped session's belated first-miss webhook just settles the row to
    // no_connect; it must not resurrect a dead run with a new attempt-2 row,
    // and it hasn't genuinely had its second miss yet so it must not enqueue.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+16195550100', secondaryNumber: null, sessionId: 'S1' }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(fdb._txInserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
  });
  it('a stopped run: a late SECOND-miss webhook still enqueues', async () => {
    // Unlike the first miss above, a second miss on a stopped run already
    // happened for real — it must still enqueue the rollover so the rep's
    // follow-up task gets created.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: null, sessionId: 'S1', followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb({ ...baseSession, status: 'stopped' }, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(deps.enqueueRollover).toHaveBeenCalledTimes(1);
  });
  it('a connect never requeues or enqueues', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 1, primaryNumber: '+1', secondaryNumber: null, fromNumber: '+16190000000' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._inserts.filter((x: any) => x.values.attempt === 2)).toHaveLength(0);
  });

  it('no_answer with a fallback number re-queues the item to dial the Phone next — no rollover, no no_connect', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', fromNumber: '+16190000000', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    // The item is reset to pending with the Phone as the number now dialed, and
    // its fallback cleared so a second no-answer can't loop.
    expect(fdb._writes).toContainEqual({
      patch: expect.objectContaining({ status: 'pending', toNumber: '+12135550199', fallbackNumber: null, callId: null }),
    });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
  });

  it('no_answer with NO fallback number behaves like a plain no_connect (rollover, reason kept)', async () => {
    // attempt: 2 — this is the record's SECOND miss, so the tail enqueues the
    // rollover rather than re-queuing a third attempt.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: null, recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: null, followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect', outcome: 'no_answer' }) });
    expect(deps.enqueueRollover).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'O1', userId: 'U1', sfOwnerId: '005', sessionId: 'S1', recordId: '00Q1', objectType: 'Lead', fromDate: '2026-07-13',
    }), expect.anything());
  });

  it('a plain no_connect (busy / voicemail) NEVER falls back, even when a fallback number exists', async () => {
    // attempt: 2 for the same reason as above — isolates "never falls back" from
    // the separate first-miss-requeues-instead-of-rolling-over behavior.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1', attempt: 2, primaryNumber: '+16195550100', secondaryNumber: '+12135550199', followupEligible: true }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_connect', deps);
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'no_connect' }) });
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending', toNumber: '+12135550199' }) });
    expect(deps.enqueueRollover).toHaveBeenCalled();
  });

  it('a duplicate/redelivered no_answer for the same call does NOT reset or re-dial twice (compare-and-swap loses)', async () => {
    // claimReturnsRows:false simulates the conditional reset UPDATE matching 0
    // rows — i.e. another invocation for this same call already flipped it.
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+16195550100', fallbackNumber: '+12135550199', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items, { claimReturnsRows: false }); deps.db = fdb;
    await handleDialOutcome('CA1', 'no_answer', deps);
    expect(fdb._writes).not.toContainEqual({ patch: expect.objectContaining({ status: 'pending' }) });
    expect(deps.telephony.originate).not.toHaveBeenCalled();
  });
  it('connected bridges + screen-pops and does NOT roll over', async () => {
    const items = [{ id: 'i1', ordinal: 0, status: 'dialing', toNumber: '+1', recordId: '00Q1', objectType: 'Lead', callId: 'CA1' }];
    const deps = makeDeps(); const fdb = fakeDb(baseSession, items); deps.db = fdb;
    await handleDialOutcome('CA1', 'connected', deps);
    expect(deps.telephony.bridgeToRep).toHaveBeenCalledWith('CA1', 'U1');
    expect(deps.onScreenPop).toHaveBeenCalledWith('U1', 'Lead', '00Q1');
    expect(deps.enqueueRollover).not.toHaveBeenCalled();
    expect(fdb._writes).toContainEqual({ patch: expect.objectContaining({ status: 'connected' }) });
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
});

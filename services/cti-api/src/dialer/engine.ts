import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import type { DialerItem } from './session-store.js';
import { earliestRetryAt, inFlightItem, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
import type { DialerTelephony } from './telephony-port.js';
import { recordConnectSticky } from './sticky.js';
import type { RolloverDb } from '../salesforce/followup-enqueue.js';
import type { PickDidArgs, PickDidResult } from './pick-agent-did.js';
import type { DialOutcome } from './outcome.js';

export interface RolloverEnqueue {
  orgId: string; userId: string; sfOwnerId: string; sessionId: string;
  recordId: string; objectType: string; fromDate: string;
  /** The exact Task the rep dialed (Task runs) — the worker rolls THAT task
   *  instead of searching the record, which on a record with several open
   *  follow-ups could roll one the rep never called. Null on Lead/Opp runs. */
  sourceTaskId: string | null;
}

export interface EngineDeps {
  db: ReturnType<typeof getDb>;
  telephony: DialerTelephony;
  /** Selects the outbound DID for a dial: `{ e164 }` to dial from, `{ skip }` to
   *  skip this recipient (over-contacted) and keep going, null = nothing
   *  eligible (fail closed → the run pauses). */
  pickDid: (args: PickDidArgs) => Promise<PickDidResult>;
  /** Is `nowUtc` within the recipient-local calling window for `toE164`? Pure predicate injected for testability. */
  withinCallingHours: (toE164: string, nowUtc: Date) => boolean;
  /** The "now" the engine reasons about — injected so calling-hours checks are deterministic in tests. */
  nowUtc: Date;
  /** Queue the rep's follow-up rollover for this record (drained by the follow-up
   *  worker). Idempotent on (user, sourceTaskId ?? record, fromDate) — so two
   *  follow-up tasks on the SAME person each get their own job. Called INSIDE the miss-path
   *  transaction (handleDialOutcome) with that transaction's `tx` as the second
   *  arg, so the enqueue commits or rolls back atomically with the CAS that
   *  flips the row out of 'dialing' — no try/catch here on purpose. */
  enqueueRollover: (job: RolloverEnqueue, db: RolloverDb) => Promise<void>;
  onScreenPop: (userId: string, objectType: string, recordId: string) => void;
  todayIso: string;
}

type Session = typeof schema.dialerSessions.$inferSelect;

async function loadItems(deps: EngineDeps, sessionId: string): Promise<DialerItem[]> {
  return deps.db.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, sessionId) });
}

async function setSession(deps: EngineDeps, id: string, status: Session['status']): Promise<void> {
  await deps.db.update(schema.dialerSessions).set({ status, updatedAt: new Date() }).where(eq(schema.dialerSessions.id, id));
}
async function setItem(deps: EngineDeps, id: string, patch: Partial<DialerItem>): Promise<void> {
  await deps.db.update(schema.dialerQueueItems).set({ ...patch, updatedAt: new Date() }).where(eq(schema.dialerQueueItems.id, id));
}

/**
 * Same write, but ONLY while the row is still 'pending' — returns the number of
 * rows it changed. Every skip below fires after at least one await (`pickDid`
 * alone runs three queries), so a concurrent advance can have flipped the row to
 * 'dialing' in the meantime; an unconditional UPDATE would overwrite a LIVE dial
 * with 'skipped'. 0 rows means that other advance owns the row now.
 */
async function setItemIfPending(deps: EngineDeps, id: string, patch: Partial<DialerItem>): Promise<number> {
  const rows = await deps.db
    .update(schema.dialerQueueItems)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(schema.dialerQueueItems.id, id), eq(schema.dialerQueueItems.status, 'pending')))
    .returning({ id: schema.dialerQueueItems.id });
  return rows.length;
}

/**
 * A guarded skip matched 0 rows: another advance claimed the row while we were
 * deciding. Re-read the queue instead of trusting our stale copy, and return
 * null to back off entirely if that advance is now dialing — carrying on would
 * place a SECOND concurrent call for the same rep.
 */
async function reloadAfterLostSkip(deps: EngineDeps, sessionId: string): Promise<DialerItem[] | null> {
  const fresh = await loadItems(deps, sessionId);
  return inFlightItem(fresh) ? null : fresh;
}

/**
 * Release the rep's conference now that their run is over, freeing their single
 * Twilio Device for the next call. The rep's softphone normally does this itself
 * (its leg joins with `endConferenceOnExit=true`); this is the backstop for when
 * the client never disconnects — tab switched away mid-run, asleep, or polling
 * stalled — which would otherwise leave the leg billing and the Device busy.
 *
 * Strictly best-effort: a Twilio failure here must never fail the run's
 * completion, which is already committed to the DB by the time we're called.
 */
async function releaseRepConference(deps: EngineDeps, userId: string, sessionId: string): Promise<void> {
  try {
    await deps.telephony.endConference(userId);
  } catch (err) {
    console.error('[dialer] endConference failed', { sessionId, userId, err: (err as Error).message });
  }
}

/** Postgres unique-violation on the one-active-session-per-rep partial index
 *  (`dialer_sessions_one_active_per_user`, migration 0022). It fires on the
 *  ready → active flip below, which is the only place a session becomes
 *  'active' now that creation inserts 'ready'. */
const ACTIVE_SESSION_INDEX = 'dialer_sessions_one_active_per_user';
function isActiveSessionConflict(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && e?.constraint === ACTIVE_SESSION_INDEX;
}

/** The `ready → active` compare-and-swap. 'lost' = 0 rows matched (the session
 *  is not ready — a second Start, or a stopped run); 'conflict' = the rep has
 *  another active run and the unique index refused the flip. */
async function claimReadySession(deps: EngineDeps, sessionId: string): Promise<'claimed' | 'lost' | 'conflict'> {
  try {
    const rows = await deps.db
      .update(schema.dialerSessions)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(schema.dialerSessions.id, sessionId), eq(schema.dialerSessions.status, 'ready')))
      .returning({ id: schema.dialerSessions.id });
    return rows.length > 0 ? 'claimed' : 'lost';
  } catch (err) {
    if (isActiveSessionConflict(err)) return 'conflict';
    throw err;
  }
}

/**
 * The rep pressed Start dialing on a `ready` session: flip it to `active` and
 * originate the first call. This is the ONE place a run begins — a session is
 * created `ready`, and nothing else moves it (`resumeSession` needs `paused`,
 * `repNext` needs a connected item, the webhooks need a dial that started).
 *
 * Compare-and-swap on status, so a double-submitted Start (two tabs, a retry)
 * advances exactly once: the loser matches 0 rows and, if the session is
 * already `active`, re-advances it rather than reporting success and doing
 * nothing. The partial unique index still enforces one active run per rep:
 * if another of the rep's sessions is active the flip is refused, THIS session
 * stays `ready`, and the caller gets `conflict` to explain to the rep — with
 * the OTHER run's id, so the confirm block can offer to stop it. Without that
 * handle a run wedged by a closed tab (its item stuck `connected`, which the
 * abandoned-session reaper skips forever) would be unreachable: the rep would
 * be told to "stop it first" with nothing to stop it from. `null` when the
 * lookup finds nothing (the other run ended in the meantime) — the rep gets
 * the sentence without the button and can simply press Start again.
 */
export async function startSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<Awaited<ReturnType<typeof advanceSession>> | { action: Session['status'] | 'idle' } | { action: 'conflict'; activeSessionId: string | null }> {
  const claim = await claimReadySession(deps, sessionId);
  if (claim === 'conflict') {
    const self = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
    const active = self
      ? await deps.db.query.dialerSessions.findFirst({
          where: and(eq(schema.dialerSessions.userId, self.userId), eq(schema.dialerSessions.status, 'active')),
        })
      : null;
    return { action: 'conflict', activeSessionId: active?.id ?? null };
  }
  if (claim === 'lost') {
    const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
    // Already active: re-advance rather than report success and do nothing.
    // With a call in flight this is a no-op (`waiting`; the pending → dialing
    // claim is its own CAS, so two tabs pressing Start cannot double-dial).
    // With nothing in flight it is the recovery for a first originate that
    // failed and rolled its item back to pending — the rep presses Start again.
    if (session?.status === 'active') return advanceSession(sessionId, deps);
    return { action: session?.status ?? 'idle' };
  }
  return advanceSession(sessionId, deps);
}

export async function advanceSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<{ action: 'dialing' | 'waiting' | 'waiting_retry' | 'done' | 'idle' | 'paused_no_numbers'; itemId?: string; nextRetryAt?: string }> {
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
  if (!session || session.status !== 'active') return { action: 'idle' };
  let items = await loadItems(deps, sessionId);
  if (inFlightItem(items)) return { action: 'waiting' };

  // Skip any unreachable pendings (defensive; creation already marks them).
  for (;;) {
    const next = nextEligiblePendingItem(items, deps.nowUtc);
    if (!next) {
      // Pending rows may remain but all be inside their retry floor — leave the
      // session active and tell the caller when it can advance (the presence-gated
      // retry-nudge loop advances it then; see salesforce/followup-worker.ts nudgeDueRetries).
      const retryAt = earliestRetryAt(items, deps.nowUtc);
      if (retryAt) return { action: 'waiting_retry', nextRetryAt: retryAt.toISOString() };
      // Release the conference BEFORE flipping the session out of 'active'. The
      // conference friendly name is rep-scoped (`pd_<userId>`), not per-run, so a
      // teardown that ran after the flip could resolve — and complete — the NEXT
      // run's conference. While this session is still 'active' the
      // one-active-session-per-rep index blocks a new run from starting, which
      // closes that window.
      await releaseRepConference(deps, session.userId, sessionId);
      await setSession(deps, sessionId, 'done');
      return { action: 'done' };
    }
    if (!next.toNumber) {
      await setItem(deps, next.id, { status: 'unreachable' });
      items = items.map((i) => (i.id === next.id ? { ...i, status: 'unreachable' } : i));
      continue;
    }
    if (!deps.withinCallingHours(next.toNumber, deps.nowUtc)) {
      if (await setItemIfPending(deps, next.id, { status: 'skipped', outcome: 'out_of_hours' })) {
        items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: 'out_of_hours' } : i));
        continue;
      }
      const fresh = await reloadAfterLostSkip(deps, sessionId);
      if (!fresh) return { action: 'waiting' };
      items = fresh;
      continue;
    }
    // Task runs dial the rep's own numbers; every other run kind dials the pool.
    const runKind = session.objectType === 'Task' ? 'agent' : 'pool';
    const did = await deps.pickDid({ orgId: session.orgId, userId: session.userId, toE164: next.toNumber, runKind });
    if (did && 'skip' in did) {
      // Over-contacted customer: skip THIS record, keep the run going.
      if (await setItemIfPending(deps, next.id, { status: 'skipped', outcome: did.skip })) {
        items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: did.skip } : i));
        continue;
      }
      const fresh = await reloadAfterLostSkip(deps, sessionId);
      if (!fresh) return { action: 'waiting' };
      items = fresh;
      continue;
    }
    if (!did) { await setSession(deps, sessionId, 'paused'); return { action: 'paused_no_numbers' }; }

    // Two reps' concurrent advances (or a retry racing the original call) could
    // both read the same `next` pending item before either writes. Hold a
    // per-session advisory lock for the duration of the claim so only one
    // transaction can win, then atomically flip pending -> dialing: if the
    // conditional UPDATE affects 0 rows, someone else already claimed this
    // item (or it moved on) and we back off rather than double-dial it.
    const claimed = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
      const rows = await tx
        .update(schema.dialerQueueItems)
        .set({ status: 'dialing', updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, next.id), eq(schema.dialerQueueItems.status, 'pending')))
        .returning({ id: schema.dialerQueueItems.id });
      return rows.length > 0;
    });
    if (!claimed) return { action: 'waiting' };

    // Captured before the closures below: TypeScript drops the `next.toNumber`
    // narrowing inside a nested function, and it is non-null from the guard above.
    const toE164 = next.toNumber;
    let callId: string;
    try {
      ({ callId } = await deps.telephony.originate({
        sessionId, itemId: next.id, fromE164: did.e164, toE164, userId: session.userId,
      }));
    } catch (err) {
      // Roll the item back so a transient originate failure doesn't strand it 'dialing'.
      await setItem(deps, next.id, { status: 'pending' });
      throw err;
    }
    // Stamp the dial AND record the attempt in ONE transaction. The attempt row
    // is what the shared per-customer ceiling counts (packages/firewall/src/evaluate.ts's
    // customerAttemptCounts) and it is append-only, so a later fallback dial of
    // this same item cannot rewrite it away the way it rewrites the item's own
    // to_number/from_number. Atomic with the stamp so the ceiling can never
    // disagree with what the queue says was dialed.
    await deps.db.transaction(async (tx) => {
      await tx
        .update(schema.dialerQueueItems)
        .set({ callId, fromNumber: did.e164, updatedAt: new Date() })
        .where(eq(schema.dialerQueueItems.id, next.id));
      await tx.insert(schema.dialerDialAttempts).values({
        orgId: session.orgId,
        userId: session.userId,
        sessionId,
        itemId: next.id,
        toNumber: toE164,
        fromNumber: did.e164,
      });
    });
    return { action: 'dialing', itemId: next.id };
  }
}

/**
 * Pause after any in-flight dial finishes; that dial itself is not interrupted.
 * A stopped/done session is terminal and cannot be reactivated by pause.
 */
export async function pauseSession(sessionId: string, deps: EngineDeps): Promise<{ action: Session['status'] | 'idle' }> {
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
  if (!session) return { action: 'idle' };
  if (session.status !== 'active') return { action: session.status };
  await setSession(deps, sessionId, 'paused');
  return { action: 'paused' };
}

/**
 * Resume dialing and immediately try to advance the queue.
 * A stopped/done session is terminal and cannot be reactivated by resume.
 */
export async function resumeSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<ReturnType<typeof advanceSession> | { action: Session['status'] | 'idle' }> {
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
  if (!session) return { action: 'idle' };
  if (session.status !== 'paused') return { action: session.status };
  await setSession(deps, sessionId, 'active');
  return advanceSession(sessionId, deps);
}

/**
 * Skip the in-flight item (rep chose not to wait/talk): mark the item
 * skipped FIRST, then hang up a live call regardless of whether it's still
 * dialing or already connected (skipping a connected call without hanging up
 * would leave it live while the next lead gets dialed), then try to advance
 * to the next item.
 *
 * The stamp runs before the hangup for the same reason `onDialerAmd` in
 * src/routes/dialer.ts stamps before it hangs up: hanging up makes Twilio
 * send a `completed` (or, for a still-ringing call, `canceled`) status
 * callback, and if that lands while this function is still awaiting the
 * hangup, `handleDialOutcome` would find the item still `dialing` and run
 * the full miss path — an attempt-2 requeue or a Salesforce follow-up
 * rollover, plus an `advanceSession` — before this function's own `skipped`
 * write landed on top of it. A rep's deliberate Skip must never manufacture
 * a follow-up. Stamped first, the callback finds the row already settled
 * and `handleDialOutcome` no-ops.
 */
export async function skipCurrent(sessionId: string, deps: EngineDeps): ReturnType<typeof advanceSession> {
  const items = await loadItems(deps, sessionId);
  const item = inFlightItem(items);
  if (item) {
    await setItem(deps, item.id, { status: 'skipped' });
    if (item.callId) {
      try {
        await deps.telephony.hangup(item.callId);
      } catch (err) {
        console.error('[dialer] skip hangup failed', { itemId: item.id, err: (err as Error).message });
      }
    }
  }
  return advanceSession(sessionId, deps);
}

/**
 * Hang up any in-flight dial and stop the session outright.
 *
 * A `connected` (already-bridged) call is deliberately NOT hung up by the
 * `hangup` call below — but releasing the rep's conference ends it anyway,
 * disconnecting every participant. That matches what the rep already sees: the
 * softphone's Stop drops their own conference leg (which carries
 * `endConferenceOnExit=true`) as soon as the stop request resolves, so a live
 * conversation ends on Stop either way.
 *
 * ORDER — release the conference, flip to `stopped`, hang up LAST. The hangup
 * makes Twilio send that call's terminal status callback (`canceled` while it
 * was still ringing; `completed` → `hangup` once it had answered). Were the
 * hangup first, that callback could land while this function was still
 * awaiting it: `handleDialOutcome` would find the row still `dialing` and the
 * session still `active` (its `sessionLive` rule), so it would requeue the
 * record as attempt 2 — or enqueue a rollover — and then `advanceSession`
 * would ORIGINATE THE NEXT RECORD after the rep pressed Stop, into a room
 * whose rep leg is already gone. Flipped first, the callback finds a stopped
 * session: the row simply settles as `no_connect` (an attempt-2 miss still
 * enqueues its rollover — that miss genuinely happened, and post-Stop
 * enqueueing is the endorsed behavior) and `advanceSession` returns `idle`.
 * Same reasoning as `skipCurrent`'s stamp-then-hang-up, one level up.
 */
export async function stopSession(sessionId: string, deps: EngineDeps): Promise<{ action: 'stopped' }> {
  const [session, items] = await Promise.all([
    deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) }),
    loadItems(deps, sessionId),
  ]);
  const item = inFlightItem(items);
  // Released before the status flip, for the same cross-run reason as
  // advanceSession. Only a live (active/paused) session ever joined a
  // conference — the conference name is rep-scoped, so releasing it for a
  // `ready`, already-`stopped`, or `done` session here could end a DIFFERENT
  // run the rep has active in another tab (the very case that leaves a second
  // session stuck `ready`).
  if (session && (session.status === 'active' || session.status === 'paused')) {
    await releaseRepConference(deps, session.userId, sessionId);
  }
  await setSession(deps, sessionId, 'stopped');
  if (item && item.status === 'dialing' && item.callId) {
    try {
      await deps.telephony.hangup(item.callId);
    } catch (err) {
      console.error('[dialer] stop hangup failed', { itemId: item.id, err: (err as Error).message });
    }
  }
  return { action: 'stopped' };
}

/** The rep clicking "Next" after finishing a talk: close out the connected item, then advance. */
export async function repNext(sessionId: string, deps: EngineDeps): ReturnType<typeof advanceSession> {
  const items = await loadItems(deps, sessionId);
  const item = inFlightItem(items);
  if (item && item.status === 'connected') {
    // Hang up the prospect BEFORE advancing — otherwise their leg stays in the
    // rep's conference (prospect legs join with endConferenceOnExit=false) and
    // the next prospect gets bridged into the SAME room: the previous caller
    // hears the next conversation and keeps billing. Mirrors skipCurrent.
    if (item.callId) {
      try {
        await deps.telephony.hangup(item.callId);
      } catch (err) {
        console.error('[dialer] next hangup failed', { itemId: item.id, err: (err as Error).message });
      }
    }
    await setItem(deps, item.id, { status: 'done' });
  }
  return advanceSession(sessionId, deps);
}

export async function handleDialOutcome(
  callId: string,
  outcome: DialOutcome,
  deps: EngineDeps,
): Promise<void> {
  const item = await deps.db.query.dialerQueueItems.findFirst({ where: eq(schema.dialerQueueItems.callId, callId) });
  if (!item || item.status !== 'dialing') return;
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, item.sessionId) });
  if (!session) return;

  if (outcome === 'connected') {
    await setItem(deps, item.id, { status: 'connected', outcome: 'connected' });
    await deps.telephony.bridgeToRep(callId, session.userId);
    deps.onScreenPop(session.userId, item.objectType, item.recordId);
    // Sticky-on-connect: remember this (org, rep, lead) -> pool DID binding so
    // an inbound callback from the lead rings the same rep. Best-effort — a
    // sticky write failure must never break an already-connected call.
    if (item.toNumber && item.fromNumber) {
      try {
        await recordConnectSticky(deps.db, {
          orgId: session.orgId,
          userId: session.userId,
          leadE164: item.toNumber,
          poolDid: item.fromNumber,
        });
      } catch (err) {
        console.error('[dialer] sticky upsert failed', { itemId: item.id, err: (err as Error).message });
      }
    }
    return; // wait for the rep's `next`
  }

  // TRUE no-answer (the Mobile rang out) with a Phone fallback still untried →
  // dial the Phone instead of giving up. Reset THIS item to pending with the
  // fallback number and clear it (so a second no-answer can't loop); the fallback
  // becomes the number now being dialed. advanceSession re-dials it — the item
  // keeps its ordinal, which is the lowest among unfinished items, so it's the
  // very next call, through the normal pool-DID + attempt-count path. Only a
  // 'no_answer' outcome reaches here: voicemail / fax / busy / failed /
  // canceled / hangup are plain misses (see dialer/outcome.ts) that never
  // fall back — the row below becomes 'no_connect' with that reason in
  // `outcome`, and the decision here does not read the reason.
  if (outcome === 'no_answer' && item.fallbackNumber) {
    // Compare-and-swap so a duplicate/redelivered webhook for THIS same call
    // can't reset (and therefore re-dial) the fallback twice: only the
    // invocation that still sees this exact call 'dialing' flips it to
    // 'pending'; a racing duplicate claims 0 rows and backs off, leaving any
    // fallback call the winner already started untouched. Mirrors
    // advanceSession's atomic pending->dialing claim.
    const claimed = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.dialerQueueItems)
        .set({
          status: 'pending',
          toNumber: item.fallbackNumber,
          fallbackNumber: null,
          callId: null,
          fromNumber: null,
          outcome: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.dialerQueueItems.id, item.id),
          eq(schema.dialerQueueItems.callId, callId),
          eq(schema.dialerQueueItems.status, 'dialing'),
        ))
        .returning({ id: schema.dialerQueueItems.id });
      return rows.length > 0;
    });
    if (!claimed) return; // a duplicate/redelivered webhook lost the race
    await advanceSession(item.sessionId, deps);
    return;
  }

  // No fallback left (or a non-no-answer miss) = one MISS. Decide the outcome
  // BEFORE the transaction, from a single truth table:
  //  - requeue: this is the record's first miss, it still has a number to
  //    retry with (the immutable pair, or — for legacy pre-0024 rows with no
  //    primaryNumber — whatever it was last dialing), and the run is still
  //    live (active/paused). Re-queued as an attempt-2 row at the END of the
  //    run, 5-min floor.
  //  - enqueue: everything else that isn't a requeue — the second miss, or a
  //    first miss with nothing left to retry with. Queues the follow-up
  //    rollover.
  // A STOPPED session's first-miss webhook does NEITHER: per spec, a rep who
  // stops after one pass leaves those tasks open, so the row just becomes
  // 'no_connect' and nothing is queued. A stopped session's second-miss
  // webhook still enqueues — that miss genuinely already happened.
  const attempt = item.attempt ?? 1; // a fixture/row missing `attempt` must not silently skip both branches
  const retryTo = item.primaryNumber ?? item.toNumber; // legacy rows (pre-0024) have no primaryNumber
  const retryFallback = item.secondaryNumber ?? item.fallbackNumber;
  const sessionLive = session.status === 'active' || session.status === 'paused';
  const requeue = attempt < 2 && retryTo != null && sessionLive;
  // Only a follow-up rolls over. Task runs dial whatever the rep's list holds
  // ("Check in", "Send quote"), and completing/copying one of those would
  // rewrite work the rollover rule was never meant to touch. Lead/Opp runs and
  // every pre-0027 row are eligible (the column defaults to true).
  const enqueue = !requeue && item.followupEligible && (attempt >= 2 || (retryTo == null && sessionLive));

  // The CAS, the requeue insert, and the rollover enqueue all ride inside the
  // same transaction, so a duplicated webhook can neither double-requeue nor
  // double-enqueue, and the enqueue commits/rolls back atomically with the
  // CAS (a retry can't lose the race against a rollover that outlived it).
  // The ordinal lookup uses `tx.query` (not `deps.db.query`) so it shares the
  // transaction's pool client instead of checking out a second one — with
  // enough concurrent misses that second checkout would deadlock the pool
  // permanently. No try/catch around the enqueue: a failure there should roll
  // the CAS back too, and the insert is idempotent via the unique index, so a
  // retry after rollback just repeats the same idempotent write.
  const claimed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.dialerQueueItems)
      .set({ status: 'no_connect', outcome, updatedAt: new Date() })
      .where(and(
        eq(schema.dialerQueueItems.id, item.id),
        eq(schema.dialerQueueItems.callId, callId),
        eq(schema.dialerQueueItems.status, 'dialing'),
      ))
      .returning({ id: schema.dialerQueueItems.id });
    if (rows.length === 0) return false;
    if (requeue) {
      const all = await tx.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, item.sessionId) });
      const maxOrdinal = all.reduce((m, i) => Math.max(m, i.ordinal), -1);
      await tx.insert(schema.dialerQueueItems).values({
        sessionId: item.sessionId, ordinal: maxOrdinal + 1, objectType: item.objectType, recordId: item.recordId,
        toNumber: retryTo, fallbackNumber: retryFallback,
        primaryNumber: item.primaryNumber, secondaryNumber: item.secondaryNumber,
        // Carried forward, not defaulted: without these the attempt-2 row falls
        // back to the column defaults (null / true), so the SECOND miss would
        // roll a "Check in" over as if it were a follow-up, and roll it by
        // search instead of by the task the rep actually dialed.
        taskId: item.taskId, followupEligible: item.followupEligible,
        attempt: 2, status: 'pending',
        retryNotBefore: new Date(deps.nowUtc.getTime() + RETRY_FLOOR_MS),
      });
    } else if (enqueue) {
      await deps.enqueueRollover({
        orgId: session.orgId, userId: session.userId, sfOwnerId: session.sfOwnerId, sessionId: session.id,
        recordId: item.recordId, objectType: item.objectType, fromDate: deps.todayIso,
        sourceTaskId: item.taskId ?? null,
      }, tx);
    }
    return true;
  });
  if (!claimed) return; // duplicate/redelivered webhook lost the race
  await advanceSession(item.sessionId, deps);
}

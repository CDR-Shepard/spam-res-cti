import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { DialerItem } from './session-store.js';
import { earliestRetryAt, inFlightItem, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
import type { DialerTelephony } from './telephony-port.js';
import { recordConnectSticky } from './sticky.js';
import type { RolloverDb } from '../salesforce/followup-worker.js';

export interface RolloverEnqueue {
  orgId: string; userId: string; sfOwnerId: string; sessionId: string;
  recordId: string; objectType: string; fromDate: string;
}

export interface EngineDeps {
  db: ReturnType<typeof getDb>;
  telephony: DialerTelephony;
  /** Selects the outbound DID for a (org, rep, recipient) dial; null = nothing eligible (fail closed). */
  pickDid: (orgId: string, userId: string, toE164: string) => Promise<{ e164: string } | null>;
  /** Is `nowUtc` within the recipient-local calling window for `toE164`? Pure predicate injected for testability. */
  withinCallingHours: (toE164: string, nowUtc: Date) => boolean;
  /** The "now" the engine reasons about — injected so calling-hours checks are deterministic in tests. */
  nowUtc: Date;
  /** Queue the rep's follow-up rollover for this record (drained by the follow-up
   *  worker). Idempotent on (user, record, fromDate). Called INSIDE the miss-path
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
      // session active and tell the caller when it can advance (the follow-up
      // worker tick nudges it then).
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
      await setItem(deps, next.id, { status: 'skipped', outcome: 'out_of_hours' });
      items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: 'out_of_hours' } : i));
      continue;
    }
    const did = await deps.pickDid(session.orgId, session.userId, next.toNumber);
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

    let callId: string;
    try {
      ({ callId } = await deps.telephony.originate({
        sessionId, itemId: next.id, fromE164: did.e164, toE164: next.toNumber, userId: session.userId,
      }));
    } catch (err) {
      // Roll the item back so a transient originate failure doesn't strand it 'dialing'.
      await setItem(deps, next.id, { status: 'pending' });
      throw err;
    }
    await setItem(deps, next.id, { callId, fromNumber: did.e164 });
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
 * Skip the in-flight item (rep chose not to wait/talk): hang up a live call
 * regardless of whether it's still dialing or already connected (skipping a
 * connected call without hanging up would leave it live while the next lead
 * gets dialed), mark the item skipped, then try to advance to the next item.
 */
export async function skipCurrent(sessionId: string, deps: EngineDeps): ReturnType<typeof advanceSession> {
  const items = await loadItems(deps, sessionId);
  const item = inFlightItem(items);
  if (item) {
    if (item.callId) {
      try {
        await deps.telephony.hangup(item.callId);
      } catch (err) {
        console.error('[dialer] skip hangup failed', { itemId: item.id, err: (err as Error).message });
      }
    }
    await setItem(deps, item.id, { status: 'skipped' });
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
 */
export async function stopSession(sessionId: string, deps: EngineDeps): Promise<{ action: 'stopped' }> {
  const [session, items] = await Promise.all([
    deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) }),
    loadItems(deps, sessionId),
  ]);
  const item = inFlightItem(items);
  if (item && item.status === 'dialing' && item.callId) await deps.telephony.hangup(item.callId);
  // Released before the status flip, for the same cross-run reason as advanceSession.
  if (session) await releaseRepConference(deps, session.userId, sessionId);
  await setSession(deps, sessionId, 'stopped');
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
  outcome: 'connected' | 'no_answer' | 'no_connect',
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
  // 'no_answer' outcome reaches here: busy / voicemail-machine / failed are
  // mapped to 'no_connect' by the webhook handlers and never fall back.
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
  const enqueue = !requeue && (attempt >= 2 || (retryTo == null && sessionLive));

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
        attempt: 2, status: 'pending',
        retryNotBefore: new Date(deps.nowUtc.getTime() + RETRY_FLOOR_MS),
      });
    } else if (enqueue) {
      await deps.enqueueRollover({
        orgId: session.orgId, userId: session.userId, sfOwnerId: session.sfOwnerId, sessionId: session.id,
        recordId: item.recordId, objectType: item.objectType, fromDate: deps.todayIso,
      }, tx);
    }
    return true;
  });
  if (!claimed) return; // duplicate/redelivered webhook lost the race
  await advanceSession(item.sessionId, deps);
}

import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import type { DialerItem } from './session-store.js';
import { inFlightItem, nextPendingItem } from './state.js';
import type { DialerTelephony } from './telephony-port.js';
import type { rolloverFollowUp } from '../salesforce/followup.js';
import { recordConnectSticky } from './sticky.js';

export interface EngineDeps {
  db: ReturnType<typeof getDb>;
  telephony: DialerTelephony;
  /** Selects the outbound DID for a (org, rep, recipient) dial; null = nothing eligible (fail closed). */
  pickDid: (orgId: string, userId: string, toE164: string) => Promise<{ e164: string } | null>;
  /** Is `nowUtc` within the recipient-local calling window for `toE164`? Pure predicate injected for testability. */
  withinCallingHours: (toE164: string, nowUtc: Date) => boolean;
  /** The "now" the engine reasons about — injected so calling-hours checks are deterministic in tests. */
  nowUtc: Date;
  rolloverFollowUp: typeof rolloverFollowUp;
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
): Promise<{ action: 'dialing' | 'waiting' | 'done' | 'idle' | 'paused_no_numbers'; itemId?: string }> {
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
  if (!session || session.status !== 'active') return { action: 'idle' };
  let items = await loadItems(deps, sessionId);
  if (inFlightItem(items)) return { action: 'waiting' };

  // Skip any unreachable pendings (defensive; creation already marks them).
  for (;;) {
    const next = nextPendingItem(items);
    if (!next) {
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
  if (item && item.status === 'connected') await setItem(deps, item.id, { status: 'done' });
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

  // No fallback left (or a non-no-answer miss): record the miss, roll over the
  // rep's follow-up task, advance. The finer reason is kept in `outcome`.
  await setItem(deps, item.id, { status: 'no_connect', outcome });
  try {
    await deps.rolloverFollowUp(session.userId, session.sfOwnerId, item.recordId, deps.todayIso);
  } catch (err) {
    console.error('[dialer] rollover failed', { itemId: item.id, err: (err as Error).message });
  }
  await advanceSession(item.sessionId, deps);
}

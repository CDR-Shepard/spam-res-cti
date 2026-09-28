import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { DAILY_CAP_WINDOW_MS } from '@cti/firewall';
import type { DialerItem } from './session-store.js';
import { cadenceVerdict, rolloverDue, type Dial, type Person } from './contact-history.js';
import { stampConnected } from './contact-history-live.js';
import { earliestRetryAt, inFlightItem, isTalking, nextEligiblePendingItem, RETRY_FLOOR_MS } from './state.js';
import type { DialerTelephony } from './telephony-port.js';
import { recordConnectSticky } from './sticky.js';
import type { RolloverDb } from '../salesforce/followup-enqueue.js';
import type { PickDidArgs, PickDidResult } from './pick-agent-did.js';
import type { DialOutcome } from './outcome.js';
import type { DialerRunSettings, RolloverBusinessDays } from '@cti/contracts';
import { claimReadySessionQuery, runSizeCutoff, saveRunDefaultsQuery, trimQueueQuery } from './run-settings.js';

export interface RolloverEnqueue {
  /** `sessionId` is null when the trigger is not a power-dial run (a
   *  click-to-dial miss); the jobs table's `session_id` is nullable. */
  orgId: string; userId: string; sfOwnerId: string; sessionId: string | null;
  recordId: string; objectType: string; fromDate: string;
  /** The exact Task the rep dialed (Task runs) — the worker rolls THAT task
   *  instead of searching the record, which on a record with several open
   *  follow-ups could roll one the rep never called. Null on Lead/Opp runs. */
  sourceTaskId: string | null;
  /** Missed tasks move to (spec 2026-09-28): the copy starts at the 1st or 2nd
   *  business day after the landing base — the run's setting for power dial,
   *  the rep's saved choice for click-to-dial. Captured here so the worker
   *  needs no session lookup. */
  businessDays: RolloverBusinessDays;
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
   *  worker). Idempotent on (user, record, fromDate) — the unique index
   *  `followup_rollover_unique` is keyed by RECORD, not by task, so two
   *  follow-up tasks on the SAME person on the same day collapse into ONE job
   *  (see followup-enqueue.ts). Called INSIDE the miss-path transaction
   *  (handleDialOutcome) with that transaction's `tx` as the second arg, so
   *  the enqueue commits or rolls back atomically with the CAS that flips the
   *  row out of 'dialing' — no try/catch here on purpose. */
  enqueueRollover: (job: RolloverEnqueue, db: RolloverDb) => Promise<void>;
  onScreenPop: (userId: string, objectType: string, recordId: string) => void;
  todayIso: string;
  /** The person's contact history since `since`, both sources. */
  contactHistory: (orgId: string, person: Person, since: Date) => Promise<Dial[]>;
  /** Ringing/connected in another live run of the org. Takes the CALLER'S db
   *  handle: the engine asks from inside the claim transaction and passes `tx`,
   *  so the read shares that transaction's pool client instead of checking out
   *  a second one — with enough concurrent claims that second checkout would
   *  deadlock the pool permanently. Same rule as `enqueueRollover`. */
  inFlightElsewhere: (db: Pick<ReturnType<typeof getDb>, 'select'>, orgId: string, person: Person, sessionId: string) => Promise<boolean>;
  /** Is the number's state daily-capped? Pure, from the area code. */
  isDailyCapped: (toE164: string) => boolean;
  /** The UTC instant the org's calendar day began (LA midnight for `nowUtc`) —
   *  the window the per-day rollover rule counts the owner's dials in. */
  orgDayStart: Date;
}

/** The person a queue item dials: both of the record's numbers, and the record. */
export function personOf(item: Pick<DialerItem, 'toNumber' | 'primaryNumber' | 'secondaryNumber' | 'fallbackNumber' | 'recordId'>): Person {
  const numbers = [...new Set([item.primaryNumber ?? item.toNumber, item.secondaryNumber ?? item.fallbackNumber].filter((n): n is string => !!n))];
  return { numbers, recordId: item.recordId };
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
 * Release the rep's conference leg now that their run is over, freeing their
 * single Twilio Device for the next call. The rep's softphone normally does this
 * itself (it drops its own leg); this is the backstop for when the client never
 * disconnects — tab switched away mid-run, asleep, or polling stalled — which
 * would otherwise leave the leg billing and the Device busy.
 *
 * Two steps, in this order:
 *  1. Hang up the rep's OWN leg by the sid stamped when it joined. This is the
 *     one that cannot miss. The leg re-enters a fresh room every time a
 *     prospect leaves (that is what keeps the hold music playing — see
 *     twilio-telephony.ts `bridgeTwiml`), so at run end the rep is usually
 *     alone in an un-started room, or between rooms, where a lookup by name
 *     finds nothing. And completing a room by name would not END the leg: its
 *     `<Dial action>` would send it round again while this session is still
 *     active (the callers release BEFORE the status flip, on purpose).
 *  2. Complete any in-progress conference of the rep's name — all there is for
 *     a run with no stamped leg (it started before the stamp existed, or the
 *     stamp failed), and harmless after step 1.
 *
 * Strictly best-effort: a Twilio failure here must never fail the run's
 * completion. The leg hangup in particular fails routinely — the client has
 * normally dropped the leg already, and Twilio refuses to update a finished call.
 */
async function releaseRepConference(deps: EngineDeps, session: Session): Promise<void> {
  if (session.repCallSid) {
    try {
      await deps.telephony.hangup(session.repCallSid);
    } catch (err) {
      console.error('[dialer] rep leg hangup failed', { sessionId: session.id, userId: session.userId, err: (err as Error).message });
    }
  }
  // The room name is rep-scoped, not per-run, so the by-name teardown is only
  // safe when THIS session is the one in the room. An active session is (the
  // one-active-run index makes it the rep's only one). A PAUSED session is not
  // when the rep already has a new active run — that is the zombie a dead tab
  // left behind (routes/telephony.ts pauseRunThatLostItsLeg), being reaped or
  // stopped from the new run's "Stop the other run" — and finding the room by
  // name would drop the new run's rep leg and whoever they are talking to.
  if (session.status !== 'active' && await repHasAnotherActiveRun(deps, session)) return;
  try {
    await deps.telephony.endConference(session.userId);
  } catch (err) {
    console.error('[dialer] endConference failed', { sessionId: session.id, userId: session.userId, err: (err as Error).message });
  }
}

async function repHasAnotherActiveRun(deps: EngineDeps, session: Session): Promise<boolean> {
  const others = await deps.db.query.dialerSessions.findMany({
    where: and(
      eq(schema.dialerSessions.userId, session.userId),
      ne(schema.dialerSessions.id, session.id),
      eq(schema.dialerSessions.status, 'active'),
    ),
  });
  return others.length > 0;
}

/**
 * A PAUSED run of the same rep's with a dial still in flight — the one thing
 * that must block a new Start although it does not hold the one-active-run
 * slot. It is what a dead tab leaves behind: the server pauses a run whose rep
 * leg ended (routes/telephony.ts pauseRunThatLostItsLeg), but the dial that
 * was ringing at that moment is still out, and when it answers
 * `handleDialOutcome` bridges the human into the rep's room — which would by
 * then be the NEW run's, mid-conversation. The rep's own user id comes from
 * the session being started, in the same query.
 */
async function pausedRunWithDialInFlight(deps: EngineDeps, sessionId: string): Promise<Session | null> {
  const paused = await deps.db.query.dialerSessions.findMany({
    where: and(
      ne(schema.dialerSessions.id, sessionId),
      eq(schema.dialerSessions.status, 'paused'),
      eq(schema.dialerSessions.userId, sql`(select user_id from dialer_sessions where id = ${sessionId})`),
    ),
  });
  for (const run of paused) {
    if (inFlightItem(await loadItems(deps, run.id))) return run;
  }
  return null;
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

/**
 * The `ready → active` compare-and-swap and — in the SAME transaction — the
 * run's settings (spec 2026-09-28): written onto the session by the flip's own
 * UPDATE, the already-built queue cut to the run size (`runSizeCutoff`), and
 * the rep's Calls per person / How many / Missed tasks saved as their next
 * defaults (controller ruling S2: How many is remembered too).
 *
 * 'lost' = 0 rows matched (the session is not ready — a second Start, or a
 * stopped run): nothing else is written, so a second Start never re-trims or
 * changes a live run's settings. 'conflict' = the rep has another active run
 * and the unique index refused the flip: the transaction rolls back whole, so
 * the queue and the saved defaults are untouched and the rep can press Start
 * again with other choices. `settings` null (a tab from before run settings)
 * flips the status only — the columns keep their defaults, today's run.
 *
 * A ready session has nothing in flight and no dial attempts, so the rows past
 * the cutoff are only queue — never a call, never a dial on anyone's log. The
 * rows are read through `tx.query`, never `deps.db.query`: a second pool
 * checkout while the transaction holds one is the deadlock every `tx` handle
 * in this file exists to avoid.
 */
async function claimReadySession(
  deps: EngineDeps,
  sessionId: string,
  settings: DialerRunSettings | null,
): Promise<'claimed' | 'lost' | 'conflict'> {
  try {
    return await deps.db.transaction(async (tx) => {
      const [claimed] = await claimReadySessionQuery(tx, sessionId, settings, new Date());
      if (!claimed) return 'lost' as const;
      if (settings) {
        if (settings.maxRecords !== null) {
          const items = await tx.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, sessionId) });
          const cutoff = runSizeCutoff(items, settings.maxRecords);
          if (cutoff !== null) await trimQueueQuery(tx, sessionId, cutoff);
        }
        await saveRunDefaultsQuery(tx, claimed.userId, settings);
      }
      return 'claimed' as const;
    });
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
 * the sentence without the button and can simply press Start again. A PAUSED
 * run with a dial still in flight is refused the same way, before the flip —
 * see `pausedRunWithDialInFlight`.
 *
 * `settings` are the rep's Ready-to-dial choices (spec 2026-09-28). They ride
 * the flip itself — see `claimReadySession` — so they are on the session
 * before the first originate, and only a Start that actually flips the run
 * applies them.
 */
export async function startSession(
  sessionId: string,
  deps: EngineDeps,
  settings: DialerRunSettings | null = null,
): Promise<Awaited<ReturnType<typeof advanceSession>> | { action: Session['status'] | 'idle' } | { action: 'conflict'; activeSessionId: string | null }> {
  // Same `conflict` as the index refusal below, so the confirm block offers to
  // stop the paused run exactly as it would an active one — and stopping it
  // hangs that dial up (stopSession) before this run's first originate.
  const blocker = await pausedRunWithDialInFlight(deps, sessionId);
  if (blocker) return { action: 'conflict', activeSessionId: blocker.id };
  const claim = await claimReadySession(deps, sessionId, settings);
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
      await releaseRepConference(deps, session);
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
    // Contact cadence: the PERSON is the unit, not this run. `daily_cap` is law
    // (fail closed on a broken read); `cooldown` is courtesy (fail open).
    const person = personOf(next);
    const capped = deps.isDailyCapped(next.toNumber);
    // Only the READ may fail open/closed, so the try wraps nothing else: a bug
    // inside the pure `cadenceVerdict` must surface as a crash, not get logged
    // as a failed read and silently converted into a dial.
    let history: Dial[] | null = null;
    try {
      history = await deps.contactHistory(session.orgId, person, new Date(deps.nowUtc.getTime() - DAILY_CAP_WINDOW_MS));
    } catch (err) {
      console.error('[dialer] contact history read failed', { sessionId, itemId: next.id, err: (err as Error).message });
    }
    const verdict: 'ok' | 'cooldown' | 'daily_cap' | 'daily_cap_unverified' = history === null
      ? (capped ? 'daily_cap_unverified' : 'ok')
      : cadenceVerdict(history, deps.nowUtc, { sessionId, capped });
    if (verdict !== 'ok') {
      if (await setItemIfPending(deps, next.id, { status: 'skipped', outcome: verdict })) {
        items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: verdict } : i));
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
    //
    // Captured before the closures below: TypeScript drops the `next.toNumber`
    // narrowing inside a nested function, and it is non-null from the guard above.
    const toE164 = next.toNumber;
    const claimed = await deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
      // Per-PERSON lock + in-flight check, inside the claim: two runs advancing
      // in the same instant on the same person serialise here, and the loser
      // sees the winner's `dialing` row and skips instead of double-dialing.
      // Keying the lock on the dialed NUMBER is enough: the check it guards
      // matches the person by record id AND both their numbers, so a run coming
      // at the same person on their other number is still seen — once that run
      // has committed its claim. Two claims on the person's two DIFFERENT
      // numbers in the very same instant do not serialise on this key.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'dial:' + toE164}))`);
      // `tx`, not `deps.db` — see the dep's doc comment.
      if (await deps.inFlightElsewhere(tx, session.orgId, person, sessionId)) return 'elsewhere' as const;
      const rows = await tx
        .update(schema.dialerQueueItems)
        .set({ status: 'dialing', updatedAt: new Date() })
        .where(and(
          eq(schema.dialerQueueItems.id, next.id),
          eq(schema.dialerQueueItems.status, 'pending'),
          // Re-checked under the per-session lock: a run paused after this
          // advance read `active` (take-callback, Pause, a lost rep leg) must
          // not start a dial — the rep may already have left the room.
          sql`exists (select 1 from dialer_sessions where id = ${sessionId} and status = 'active')`,
        ))
        .returning({ id: schema.dialerQueueItems.id });
      return rows.length > 0;
    });
    // Another live run owns this person right now. Guarded like every other skip
    // in this loop: our claim transaction has already committed and released the
    // per-session lock, so a concurrent advance can have claimed this row in the
    // meantime, and an unconditional UPDATE would overwrite that LIVE dial with
    // 'skipped'.
    if (claimed === 'elsewhere') {
      if (await setItemIfPending(deps, next.id, { status: 'skipped', outcome: 'in_progress_elsewhere' })) {
        items = items.map((i) => (i.id === next.id ? { ...i, status: 'skipped', outcome: 'in_progress_elsewhere' } : i));
        continue;
      }
      const fresh = await reloadAfterLostSkip(deps, sessionId);
      if (!fresh) return { action: 'waiting' };
      items = fresh;
      continue;
    }
    if (!claimed) return { action: 'waiting' };

    let callId: string;
    try {
      ({ callId } = await deps.telephony.originate({
        sessionId, itemId: next.id, fromE164: did.e164, toE164, userId: session.userId,
      }));
    } catch (err) {
      // Roll the item back so a transient originate failure doesn't strand it
      // 'dialing' — but ONLY if it is still exactly that: a take-callback that
      // settled the row (skipped/canceled + requeued) while this originate call
      // was in flight must not be revived, or the person gets dialed twice —
      // once for whatever originate actually did, once more when the run
      // advances onto a resurrected 'pending' row.
      await deps.db
        .update(schema.dialerQueueItems)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, next.id), eq(schema.dialerQueueItems.status, 'dialing')))
        .returning({ id: schema.dialerQueueItems.id });
      throw err;
    }
    // Stamp the dial AND record the attempt in ONE transaction. The attempt row
    // is what the shared per-customer ceiling counts (packages/firewall/src/evaluate.ts's
    // customerAttemptCounts) and the contact history reads (cadence gate, per-day
    // rollover), and it is append-only: nothing that later rewrites the item's
    // own to_number/from_number can erase a dial from the tally. Atomic with the
    // stamp so the ceiling can never disagree with what the queue says was dialed.
    //
    // The callId stamp is a guarded compare-and-swap on the ROW ONLY: `originate`
    // awaited above, and a take-callback, a Skip, a Stop, or a plain PAUSE can
    // all land while it was in flight. Guarding on the session too (round 2's
    // original fix) stranded the row un-stamped on a plain Pause: no sid ever
    // lands on it, Twilio's callbacks then find nothing to settle, and the row
    // sits `dialing` forever — blocking Resume, the reaper, the next Start, and
    // the person org-wide. `callId` must land whenever the row is still exactly
    // the one this advance claimed, whatever the run around it is doing; the
    // session's status is read in the SAME transaction and decided on AFTER the
    // commit instead. The attempt row is inserted regardless: the phone did
    // ring either way.
    const { stamped, sessionStatus } = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.dialerQueueItems)
        .set({ callId, fromNumber: did.e164, updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, next.id), eq(schema.dialerQueueItems.status, 'dialing')))
        .returning({ status: schema.dialerQueueItems.status });
      await tx.insert(schema.dialerDialAttempts).values({
        orgId: session.orgId,
        userId: session.userId,
        sessionId,
        itemId: next.id,
        toNumber: toE164,
        fromNumber: did.e164,
        // The record dialed: the contact-history read matches a person by either
        // number OR record id, so a Lead and the Opportunity it became still
        // read as one person.
        recordId: next.recordId,
      });
      const fresh = await tx.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
      return { stamped: rows.length > 0, sessionStatus: fresh?.status };
    });
    // Not stamped (a take-callback or a Skip already settled the row) OR the
    // session has ended (stopped/done — Stop's own hang-up had nothing to hang
    // up while `callId` was still null; this is that hang-up, now that it
    // exists). A live session (active/paused) with a stamped row is left
    // ringing: a plain Pause keeps the rep in the room exactly as today.
    if (!stamped || sessionStatus === 'stopped' || sessionStatus === 'done') {
      await hangUpUnbridged(deps, callId, next.id);
      return { action: 'waiting' };
    }
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
 * record as attempt 2, and then `advanceSession` would ORIGINATE THE NEXT
 * RECORD after the rep pressed Stop, into a room whose rep leg is already
 * gone. Flipped first, the callback finds a stopped session: the row simply
 * settles as `no_connect` (nothing requeues; the rollover still enqueues when
 * this miss is the owner's second dial of the day — that miss genuinely
 * happened, and the per-day rule ignores run status) and `advanceSession`
 * returns `idle`. Same reasoning as `skipCurrent`'s stamp-then-hang-up, one
 * level up.
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
    await releaseRepConference(deps, session);
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

/**
 * The rep clicking "Next" after finishing a talk: close out the connected
 * item, then advance.
 *
 * ORDER — settle the row BEFORE hanging up, then advance. Hanging up makes
 * Twilio send that call's terminal `completed` status callback, which maps to
 * the `hangup` outcome — the same one `handleDialOutcome`'s connected-hangup
 * stamp reads as "the prospect hung up" and stamps `prospect_ended_at` for.
 * Were the item still `connected` when that callback lands, the rep's own
 * deliberate Next would be mis-stamped as a prospect hang-up. Settled first,
 * the callback finds a `done` row and no-ops — same reasoning as
 * `skipCurrent`'s stamp-then-hang-up.
 */
export async function repNext(sessionId: string, deps: EngineDeps): ReturnType<typeof advanceSession> {
  const items = await loadItems(deps, sessionId);
  const item = inFlightItem(items);
  if (item && item.status === 'connected') {
    await setItem(deps, item.id, { status: 'done' });
    // The prospect's leg must still be hung up — otherwise it stays in the
    // rep's conference (nothing else removes it) and the next prospect gets
    // bridged into the SAME room: the previous caller hears the next
    // conversation and keeps billing.
    if (item.callId) {
      try {
        await deps.telephony.hangup(item.callId);
      } catch (err) {
        console.error('[dialer] next hangup failed', { itemId: item.id, err: (err as Error).message });
      }
    }
  }
  return advanceSession(sessionId, deps);
}

/**
 * Rep-requested redial: the prospect hung up on a CONNECTED item and the rep
 * chose to try them again. Closes that item out and queues a fresh copy of
 * the same person to dial NEXT — sharing the item's ordinal so
 * `nextEligiblePendingItem` picks it before the rest of the queue — dialing
 * the number that just connected (`item.toNumber`), linked back by
 * `redialOf` for the run history.
 *
 * Eligibility, all required:
 *  - The in-flight item is `connected` AND already stamped `prospectEndedAt`
 *    (by `handleDialOutcome`'s hang-up branch). Without the stamp check, a
 *    stale tab pressing Redial while the NEXT record is live would mark that
 *    still-connected call 'done' and queue a copy while the prospect's leg is
 *    still in the rep's conference (fix-round-1 #3).
 *  - The session is `active` OR `paused` — Pause doesn't hang up the
 *    prospect, so a paused run can still have a connected item worth
 *    redialing. A stopped/done/ready session must never gain a new row
 *    (Minor d).
 * Any other case is a no-op: delegates straight to `advanceSession`, which
 * itself no-ops (no insert, no originate) for a non-eligible in-flight item
 * or a non-active session.
 *
 * ATOMIC (Minor): the conditional update — matching the SAME facts just
 * checked in JS — and the copy insert ride in ONE transaction, and the copy
 * is inserted only if the update actually claimed the row. Belt-and-
 * suspenders against a double-submitted Redial (two clicks, a retried
 * request) inserting two copies of the same person. The predicate ALSO
 * re-checks the session is still active/paused via an `exists` subquery
 * (fix-round-2 optional fix): the JS-level session-status check above and
 * this transaction are two separate round-trips, so a Stop landing in that
 * gap must not let a copy slip in for a run that is no longer live.
 *
 * Goes through `advanceSession` at the end regardless, so the redial copy
 * still passes every dial-time gate on an ACTIVE session: the 24-hour legal
 * cap and `in_progress_elsewhere`. It is exempt from the 3-hour cooldown by
 * construction (same session, same live run) — not by any special-casing
 * here. On a PAUSED session `advanceSession` returns `{ action: 'idle' }`
 * without dialing anything — the copy sits `pending` until the rep presses
 * Resume.
 */
export async function redialCurrent(sessionId: string, deps: EngineDeps): ReturnType<typeof advanceSession> {
  const [session, items] = await Promise.all([
    deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) }),
    loadItems(deps, sessionId),
  ]);
  const item = inFlightItem(items);
  if (
    !item || item.status !== 'connected' || item.prospectEndedAt == null ||
    !session || (session.status !== 'active' && session.status !== 'paused')
  ) {
    return advanceSession(sessionId, deps);
  }
  await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.dialerQueueItems)
      .set({ status: 'done', updatedAt: new Date() })
      .where(and(
        eq(schema.dialerQueueItems.id, item.id),
        eq(schema.dialerQueueItems.status, 'connected'),
        isNotNull(schema.dialerQueueItems.prospectEndedAt),
        // Closes the stopped-run gap: without this, a Stop landing between
        // the eligibility read above and this transaction opening could
        // still let a copy in for a run that just ended.
        sql`exists (select 1 from dialer_sessions where id = ${sessionId} and status in ('active', 'paused'))`,
      ))
      .returning({ id: schema.dialerQueueItems.id });
    if (rows.length === 0) return; // lost the race to a double-submit, or the session ended in the gap — nothing to copy
    await tx.insert(schema.dialerQueueItems).values({
      sessionId,
      ordinal: item.ordinal,
      objectType: item.objectType,
      recordId: item.recordId,
      toNumber: item.toNumber,
      fallbackNumber: null,
      primaryNumber: item.primaryNumber,
      secondaryNumber: item.secondaryNumber,
      taskId: item.taskId,
      followupEligible: item.followupEligible,
      displayName: item.displayName,
      listPosition: item.listPosition,
      attempt: item.attempt,
      status: 'pending',
      redialOf: item.id,
    });
  });
  return advanceSession(sessionId, deps);
}

/**
 * Rep-requested End call: hang up the prospect who is still on the line and
 * pause the run — the rep chose to stop rather than Redial or let the queue
 * continue. A no-op (returns the session's current status, originates
 * nothing) on a session that is neither `active` nor `paused` — Pause is
 * available mid-conversation (it doesn't hang up the prospect), so a paused
 * run can still have a connected item and End must work there too
 * (fix-round-1 #2).
 *
 * ORDER — pause the session FIRST, before touching the item or hanging up
 * (mirrors `stopSession`'s "flip first, hang up last"). The OLD order
 * (settle-then-hangup, session flipped last) left the session `active` with
 * nothing yet "in flight" for the length of the item write and the awaited
 * Twilio hangup — the item was already `done`, not `connected`/`dialing` —
 * which is exactly the window the 5-second retry nudge
 * (salesforce/followup-worker.ts `startRetryNudgeLoop` → `nudgeDueRetries` →
 * `advanceSession`) or a concurrent advance could dial the NEXT record into
 * (fix-round-1 #1). Paused first closes it: `advanceSession` no-ops for any
 * non-active session. The pause write is a harmless no-op when the session
 * was already `paused`.
 */
export async function endCurrent(sessionId: string, deps: EngineDeps): Promise<{ action: Session['status'] | 'idle' }> {
  const [session, items] = await Promise.all([
    deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) }),
    loadItems(deps, sessionId),
  ]);
  if (!session) return { action: 'idle' };
  if (session.status !== 'active' && session.status !== 'paused') return { action: session.status };
  await setSession(deps, sessionId, 'paused');
  const item = inFlightItem(items);
  if (item && item.status === 'connected') {
    await setItem(deps, item.id, { status: 'done' });
    if (item.callId) {
      try {
        await deps.telephony.hangup(item.callId);
      } catch (err) {
        console.error('[dialer] end hangup failed', { itemId: item.id, err: (err as Error).message });
      }
    }
  }
  return { action: 'paused' };
}

/** What `takeCallback` did. `connected` — a prospect is on the line — is the
 *  route's 409, and nothing was changed. */
export type TakeCallbackResult =
  | { action: 'paused'; canceledItemId: string | null }
  | { action: 'connected' }
  | { action: 'ready' | 'stopped' | 'done' | 'idle' };

/** Thrown inside takeCallback's transaction to roll it back (the pause too):
 *  the dial it was cancelling connected under it. */
class ProspectConnectedUnderUs extends Error {}

/**
 * The requeued copy of a dial cancelled to take a callback: the same person on
 * the same number, at the SAME ordinal (the run's first-pass total counts
 * ordinals — routes/dialer.ts — so it does not grow) and the same attempt (the
 * cancel is not one of the person's tries), not dialable for RETRY_FLOOR_MS so
 * nobody is rung twice inside five minutes. A cancelled redial copy stays one
 * (`redialOf`), so it still gets no end-of-run retry of its own.
 */
function callbackRequeue(item: DialerItem, now: Date): typeof schema.dialerQueueItems.$inferInsert {
  return {
    sessionId: item.sessionId,
    ordinal: item.ordinal,
    objectType: item.objectType,
    recordId: item.recordId,
    toNumber: item.toNumber,
    fallbackNumber: null,
    primaryNumber: item.primaryNumber,
    secondaryNumber: item.secondaryNumber,
    taskId: item.taskId,
    followupEligible: item.followupEligible,
    displayName: item.displayName,
    listPosition: item.listPosition,
    attempt: item.attempt,
    redialOf: item.redialOf,
    status: 'pending',
    retryNotBefore: new Date(now.getTime() + RETRY_FLOOR_MS),
  };
}

/**
 * Pause & answer: a callback rang while the rep was on this run and they chose
 * to take it (spec docs/superpowers/specs/2026-09-26-callback-waiting-design.md).
 * The softphone leaves the run's room right after this returns, so the run must
 * be left unable to put anyone in that room: paused, with no dial ringing.
 *
 * ONE transaction, holding the same per-session advisory lock as
 * advanceSession's claim: a claim already in progress has committed before we
 * read (its `dialing` row is visible below), and a claim that starts after we
 * pause re-checks the status in its compare-and-swap and backs off.
 *
 * ORDER — pause the session FIRST, before touching the item; settle the row
 * BEFORE hanging up; hang up LAST, after the commit:
 *  1. A prospect on the line (`isTalking`) → `connected`, nothing written.
 *  2. Pause — only a live run: the WHERE refuses to resurrect a Stop that
 *     landed since the read. A harmless re-write on an already-paused run.
 *  3. A ringing dial → `skipped` + `canceled`, compare-and-swapped on
 *     `dialing`, and its person requeued (`callbackRequeue`). That pair is
 *     written by nothing else: the rollover rule already ignores it
 *     (contact-history-live.ts `skipped`), the no-answer Chatter never posts on
 *     it. It STILL COUNTS toward the per-customer ceiling (@cti/firewall
 *     attempts.ts is deliberately unchanged — controller ruling: the person's
 *     phone did ring, so the cancel is one of their attempts) as well as the
 *     state-law cap and the 3 h courtesy. If the swap loses, the dial settled
 *     under us: connected → roll everything back (the pause too) and answer
 *     `connected`; a miss → nothing left to cancel, the run stays paused.
 *  4. After commit, hang the cancelled call up. Its `canceled` status callback
 *     then finds a settled row and `handleDialOutcome` no-ops. A dial whose
 *     originate had not returned yet has no sid to hang up here; if that
 *     person answers, `handleDialOutcome` hangs them up (the row is `skipped`).
 *
 * Idempotent: on a paused run with nothing ringing it writes the same pause
 * and answers `{ action: 'paused', canceledItemId: null }`.
 */
export async function takeCallback(sessionId: string, deps: EngineDeps): Promise<TakeCallbackResult> {
  let outcome: { result: TakeCallbackResult; hangUp: string | null };
  try {
    outcome = await deps.db.transaction(async (tx): Promise<{ result: TakeCallbackResult; hangUp: string | null }> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
      const session = await tx.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
      if (!session) return { result: { action: 'idle' }, hangUp: null };
      if (session.status !== 'active' && session.status !== 'paused') return { result: { action: session.status }, hangUp: null };
      const ofRun = eq(schema.dialerQueueItems.sessionId, sessionId);
      const item = inFlightItem(await tx.query.dialerQueueItems.findMany({ where: ofRun }));
      if (isTalking(item)) return { result: { action: 'connected' }, hangUp: null };
      // Guarded, not a blind write: a Stop takes no advisory lock of its own
      // (it writes the session status directly), so it can land in the gap
      // between our read above and this write. 0 rows means Stop (or
      // whatever else) already moved the session out of active/paused —
      // report its REAL status, and never settle or requeue a dial for a run
      // we did not actually pause.
      const paused = await tx
        .update(schema.dialerSessions)
        .set({ status: 'paused', updatedAt: new Date() })
        .where(and(eq(schema.dialerSessions.id, sessionId), inArray(schema.dialerSessions.status, ['active', 'paused'])))
        .returning({ status: schema.dialerSessions.status });
      if (paused.length === 0) {
        const fresh = await tx.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, sessionId) });
        // The WHERE just refused active/paused, so the real status here is
        // one of the terminal/pre-start ones — the cast is exhaustiveness,
        // not a guess.
        return { result: { action: fresh?.status ?? 'idle' } as TakeCallbackResult, hangUp: null };
      }
      if (!item || item.status !== 'dialing') return { result: { action: 'paused', canceledItemId: null }, hangUp: null };
      const settled = await tx
        .update(schema.dialerQueueItems)
        .set({ status: 'skipped', outcome: 'canceled', updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, item.id), eq(schema.dialerQueueItems.status, 'dialing')))
        .returning({ id: schema.dialerQueueItems.id });
      if (settled.length === 0) {
        if (isTalking(inFlightItem(await tx.query.dialerQueueItems.findMany({ where: ofRun })))) throw new ProspectConnectedUnderUs();
        return { result: { action: 'paused', canceledItemId: null }, hangUp: null };
      }
      await tx.insert(schema.dialerQueueItems).values(callbackRequeue(item, deps.nowUtc));
      return { result: { action: 'paused', canceledItemId: item.id }, hangUp: item.callId };
    });
  } catch (err) {
    if (err instanceof ProspectConnectedUnderUs) return { action: 'connected' };
    throw err;
  }
  if (outcome.hangUp) {
    try {
      await deps.telephony.hangup(outcome.hangUp);
    } catch (err) {
      console.error('[dialer] take-callback hangup failed', { sessionId, err: (err as Error).message });
    }
  }
  return outcome.result;
}

/** Best-effort hang-up of an answered call nobody will be bridged to. Usually
 *  succeeds; "already gone" is the other common answer, so it only warns. */
async function hangUpUnbridged(deps: EngineDeps, callId: string, itemId: string): Promise<void> {
  try {
    await deps.telephony.hangup(callId);
  } catch (err) {
    console.warn('[dialer] unbridged call not hung up (usually already gone)', { itemId, err: (err as Error).message });
  }
}

export async function handleDialOutcome(
  callId: string,
  outcome: DialOutcome,
  deps: EngineDeps,
): Promise<void> {
  const item = await deps.db.query.dialerQueueItems.findFirst({ where: eq(schema.dialerQueueItems.callId, callId) });
  // The prospect's leg ended on a CONNECTED call: the person hung up. Stamp it
  // and stop — the rep chooses Redial or Resume (spec §5). Never advance, never
  // dial. `outcome !== 'connected'` excludes the duplicate async-AMD 'human'
  // re-delivery for the same call, which arrives as `connected`, not a hangup.
  // Only a null stamp is written (JS guard AND the WHERE's `isNull`), so a
  // redelivered terminal callback for an already-stamped item is a no-op.
  if (item?.status === 'connected' && item.prospectEndedAt == null && outcome !== 'connected') {
    await deps.db.update(schema.dialerQueueItems)
      .set({ prospectEndedAt: deps.nowUtc, updatedAt: new Date() })
      .where(and(eq(schema.dialerQueueItems.id, item.id), isNull(schema.dialerQueueItems.prospectEndedAt)));
    return;
  }
  if (!item) return;
  if (item.status !== 'dialing') {
    // A person answered a call whose row a rep action already settled — a Skip,
    // or take-callback while this dial's originate was still in flight, so
    // nothing held its sid to hang up. Nobody will bridge them: hang up rather
    // than leave them listening to the dialer-answer hold.
    if (outcome === 'connected' && item.status === 'skipped') await hangUpUnbridged(deps, callId, item.id);
    return;
  }
  const session = await deps.db.query.dialerSessions.findFirst({ where: eq(schema.dialerSessions.id, item.sessionId) });
  const sessionLive = session?.status === 'active' || session?.status === 'paused';
  if (outcome === 'connected' && !sessionLive) {
    // A person answered a dial of a run that is over (stopped, done, or gone):
    // a Stop that landed while this originate was out had no sid to hang up,
    // or a resume slipped in during stopSession's Twilio calls. The room is
    // rep-scoped, so bridging would put them in whatever the rep is in now, or
    // leave them on the hold. A paused run still bridges below — a plain Pause
    // keeps the rep in the room. Settle the row FIRST, as the Stop's cut it is
    // (`no_connect` + `canceled`: no rollover, no Chatter), compare-and-swapped
    // on this call still `dialing`, and hang up only once that has committed —
    // its `completed` callback then finds a settled row and no-ops. A lost swap
    // means another handler settled the row and owns the call.
    const settled = await deps.db
      .update(schema.dialerQueueItems)
      .set({ status: 'no_connect', outcome: 'canceled', updatedAt: new Date() })
      .where(and(
        eq(schema.dialerQueueItems.id, item.id),
        eq(schema.dialerQueueItems.callId, callId),
        eq(schema.dialerQueueItems.status, 'dialing'),
      ))
      .returning({ id: schema.dialerQueueItems.id });
    if (settled.length > 0) await hangUpUnbridged(deps, callId, item.id);
    return;
  }
  if (!session) return;

  // The number THIS call dialed — what the connect stamp below is scoped to.
  const dialedNumber = item.toNumber;

  if (outcome === 'connected') {
    // Settle the row AND stamp the dial log in one transaction: the stamp is
    // what every later run reads to lead with the number that actually reached
    // this person, so it must never survive (or be lost by) a partial write.
    // The stamp also matches on `dialedNumber`, not just the item id — see
    // stampConnected's doc for why (defensive; one item owns exactly one
    // attempt row today, a retry being a new row on a new item). A row with
    // no number to match is nothing the log could have recorded, so there is
    // nothing to stamp.
    //
    // A compare-and-swap on `dialing` — the read above is not a lock. A Skip or
    // take-callback that settled the row since then owns it, and bridging now
    // would put this person in a room the rep may already have left.
    const claimed = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.dialerQueueItems)
        .set({ status: 'connected', outcome: 'connected', updatedAt: new Date() })
        .where(and(eq(schema.dialerQueueItems.id, item.id), eq(schema.dialerQueueItems.status, 'dialing')))
        .returning({ id: schema.dialerQueueItems.id });
      if (rows.length === 0) return false;
      if (dialedNumber) await stampConnected(tx, item.id, dialedNumber, deps.nowUtc);
      return true;
    });
    if (!claimed) {
      // Someone else's transaction committed first. A Skip or take-callback
      // settled the row to `skipped` — hang up (nobody will bridge them). A
      // duplicate AMD "human" re-delivery for the SAME call may instead have
      // already bridged it (item now `connected`) — that leg is live, so do
      // nothing: hanging it up would drop a prospect the rep is talking to,
      // and re-bridging would double-bridge the same call.
      const fresh = await deps.db.query.dialerQueueItems.findFirst({ where: eq(schema.dialerQueueItems.id, item.id) });
      if (fresh?.status === 'skipped') await hangUpUnbridged(deps, callId, item.id);
      return;
    }
    // The prospect may end the room on its way out — which is what brings the
    // rep's hold music back — only when the rep's leg is KNOWN to carry the
    // rejoin action: the stamp is written by the same join that adds it. A run
    // in flight across that deploy (no stamp) keeps the old standing room;
    // ending it would end the rep's call after this one conversation.
    await deps.telephony.bridgeToRep(callId, session.userId, { repRejoins: !!session.repCallSid });
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

  // Every non-connect outcome is one MISS — no_answer included: there is no
  // immediate Mobile→Phone re-dial any more (voicemail / fax / busy / failed /
  // canceled / hangup / no_answer all settle the row as 'no_connect' with that
  // reason in `outcome`; the decisions below do not read the reason). The
  // other number waits for the end-of-run retry.
  //
  // Two independent questions, decided before the transaction. Both follow the
  // run's Calls per person (`session.passes`, spec 2026-09-28): Twice (2, the
  // default) is exactly the rule below; Once (1) has no end-of-run retry and
  // rolls on the owner's FIRST non-connect of the day.
  //  - requeue: a miss before the run's last pass, in a LIVE run
  //    (active/paused) → an attempt-2 row at the END of the run (5-minute
  //    floor) dialing the record's OTHER number when it has one; the same
  //    number again when it has only one (legacy pre-0024 rows with no pair
  //    retry whatever they were last dialing).
  //  - rollover: the rule is per DAY, per OWNER, not per run. This rep has now
  //    dialed the person `session.passes` times today (any run, any source —
  //    the row for THIS dial is already on the log, written at originate) and
  //    never connected → the follow-up rolls. Whether the run is live or
  //    stopped is irrelevant: a rep who stops after one pass and dials the
  //    person again three hours later rolls it then.
  // Both may happen for one miss: the retry is queued AND the task rolls.
  //
  // Fix-round-1 #4 (controller ruling): a REDIAL copy (`redialOf` set) never
  // gets its own end-of-run retry. It already exists BECAUSE the person hung
  // up on a connected call — requeuing a missed redial would give that same
  // person an automatic THIRD dial, contradicting "a hang-up never
  // auto-redials". The rollover check below is untouched: it reads the day's
  // actual dial history, which already carries the earlier CONNECT, so
  // `rolloverDue`'s "never connected" requirement correctly keeps it from
  // rolling on its own.
  const attempt = item.attempt ?? 1; // a fixture/row missing `attempt` must not silently read as a second miss
  const retryTo = item.secondaryNumber ?? item.primaryNumber ?? item.toNumber;
  const requeue = attempt < session.passes && retryTo != null && sessionLive && item.redialOf == null;
  // Only a follow-up rolls over. Task runs dial whatever the rep's list holds
  // ("Check in", "Send quote"), and completing/copying one of those would
  // rewrite work the rollover rule was never meant to touch. Lead/Opp runs and
  // every pre-0027 row are eligible (the column defaults to true).
  //
  // The history read is on the OUTER db and happens here, before the
  // transaction opens — never inside it: a second pool checkout while the
  // transaction holds a client is the deadlock every `tx` handle in this file
  // exists to avoid. Only the READ may fail closed, so the try wraps nothing
  // else: a bug inside the pure `rolloverDue` must surface as a crash.
  //
  // `outcome !== 'canceled'` (ruling 2026-09-23): a Stop/hangup before answer
  // is not one of the owner's two dials. The history read below happens
  // BEFORE this CAS commits `outcome`, so the current dial's own row still
  // reads back with `skipped: false` (dialsToPerson keys `skipped` off the
  // COMMITTED itemOutcome, which is still null at read time) — without this
  // gate, a rep who presses Stop on the ringing 2nd dial of the day would
  // roll the follow-up exactly like a real miss.
  let enqueue = false;
  if (item.followupEligible && outcome !== 'canceled') {
    let today: Dial[] | null = null;
    try {
      today = await deps.contactHistory(session.orgId, personOf(item), deps.orgDayStart);
    } catch (err) {
      // Fail closed for the courtesy here: a missing rollover is a task that
      // stays open, which the rep sees; a spurious one rewrites their work.
      console.error('[dialer] rollover history read failed', { itemId: item.id, err: (err as Error).message });
    }
    enqueue = today !== null && rolloverDue(today, session.userId, deps.orgDayStart, session.passes);
  }

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
        // One number per pass: the retry dials `retryTo` and nothing else.
        toNumber: retryTo, fallbackNumber: null,
        primaryNumber: item.primaryNumber, secondaryNumber: item.secondaryNumber,
        // Carried forward, not defaulted: without these the attempt-2 row falls
        // back to the column defaults (null / true), so the SECOND miss would
        // roll a "Check in" over as if it were a follow-up, and roll it by
        // search instead of by the task the rep actually dialed.
        taskId: item.taskId, followupEligible: item.followupEligible, displayName: item.displayName,
        attempt: 2, status: 'pending',
        retryNotBefore: new Date(deps.nowUtc.getTime() + RETRY_FLOOR_MS),
      });
    }
    if (enqueue) {
      await deps.enqueueRollover({
        orgId: session.orgId, userId: session.userId, sfOwnerId: session.sfOwnerId, sessionId: session.id,
        recordId: item.recordId, objectType: item.objectType, fromDate: deps.todayIso,
        sourceTaskId: item.taskId ?? null,
        businessDays: session.rolloverBusinessDays,
      }, tx);
    }
    return true;
  });
  if (!claimed) return; // duplicate/redelivered webhook lost the race
  await advanceSession(item.sessionId, deps);
}

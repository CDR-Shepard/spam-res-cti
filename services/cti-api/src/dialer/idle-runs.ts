/**
 * Hang up idle power-dial lines (idle-cutoff spec,
 * docs/superpowers/specs/2026-10-06-dialer-idle-cutoff-design.md §2). A rep once
 * left a line open on hold music for 7.5 hours with zero dials. Every 30 s, find
 * runs that are `active` or `paused` AND still have an open rep leg, where
 * nothing has happened for DIALER_IDLE_MS, and STOP them through engine.ts
 * `stopIdleSession`: it marks the run `stopped` (stop_reason = 'idle', so the
 * softphone can say why) BEFORE it hangs up the line, and only if the run is
 * still active or paused when it gets there.
 *
 * STOP, never pause, and flip BEFORE releasing: the softphone's drop recovery
 * (cti-web dialer-leg.ts recoverDroppedLeg) waits 1.5 s after its leg drops,
 * then rejoins a run that reads `active` or `paused`, and the release outlasts
 * 1.5 s. Only a run already stopped keeps the line down; the rep starts a new
 * one from the list, which continues from the shared list position. (This is
 * the reverse of `stopSession`'s order, which a rep-initiated Stop needs; see
 * both docblocks.)
 *
 * Idle = no live dial AND the newest change is at least DIALER_IDLE_MS old. A
 * ringing dial or a live conversation is never cut, however long it runs — the
 * same "a live dial is presence" rule as engine.ts `isTalking` and the
 * abandoned-run reaper (salesforce/followup-worker.ts expireAbandonedSessions).
 * A run parked while the rep takes a callback has already dropped its leg, so
 * the open-leg join leaves it alone.
 *
 * Two guards against acting on a stale picture. (1) A tick snapshots the
 * candidates once, then stops them one by one, and each stop takes several
 * Twilio calls, so a later candidate's snapshot can be seconds old when its
 * turn comes: the tick re-reads that one run right before cutting it and
 * re-applies `isIdleRun`. (2) Twilio ends any call at 4 hours, so an item still
 * `dialing`, or `connected` with no prospect end, after MAX_CONVERSATION_MS is a
 * lost callback, not a live call; such an item no longer counts as `live`, or one
 * lost callback would leave the line open for hours, the very symptom this fixes.
 *
 * Accepted race: a rep who presses Next in the same instant as the cut sees the
 * run stop; they had been idle for 15 minutes.
 *
 * Kill switch: DIALER_IDLE_STOP=off never starts the loop (config.ts).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@cti/db';
import type { AppConfig } from '../config.js';
import { MAX_CONVERSATION_MS } from '../reports/talk-time.js';
import { stopIdleSession } from './engine.js';
import { DIALER_IDLE_MS } from './idle.js';
import { buildEngineDeps } from './live-deps.js';

export const IDLE_CHECK_INTERVAL_MS = 30_000;

export interface IdleCandidate {
  sessionId: string;
  userId: string;
  /** Newest of the run's own change, an open leg's join, and any item's change. */
  lastActivityAt: Date;
  /** A dial is ringing, or a conversation is still going (prospect on the line). */
  live: boolean;
}

/** PURE. Never idle with a live dial; an unreadable time is never idle either. */
export function isIdleRun(c: Pick<IdleCandidate, 'live' | 'lastActivityAt'>, now: Date): boolean {
  return !c.live && now.getTime() - c.lastActivityAt.getTime() >= DIALER_IDLE_MS;
}

/**
 * The candidate statement — one per tick, plus one per idle candidate for the
 * re-check (`sessionId` adds `and s.id = <id>`). The 15 minutes is applied by
 * `isIdleRun`, so that constant lives in one place; the only bound time is the
 * `live` floor. `live` counts an item the rep is still on: dialing, or connected
 * with the prospect not yet gone, AND touched within MAX_CONVERSATION_MS of
 * `now`. Twilio ends any call at 4 hours, so an item still "ringing" or
 * "talking" after that is a lost callback, not a live call.
 */
export function idleRunCandidatesStatement(now: Date, sessionId?: string): SQL {
  const liveFloor = new Date(now.getTime() - MAX_CONVERSATION_MS).toISOString();
  const onlySession = sessionId === undefined ? sql`` : sql` and s.id = ${sessionId}`;
  return sql`
    select s.id as session_id, s.user_id,
           greatest(s.updated_at, max(l.joined_at), max(i.updated_at)) as last_activity_at,
           coalesce(bool_or((i.status = 'dialing' or (i.status = 'connected' and i.prospect_ended_at is null)) and i.updated_at > ${liveFloor}::timestamptz), false) as live
    from dialer_sessions s
    join dialer_rep_legs l on l.session_id = s.id and l.ended_at is null
    left join dialer_queue_items i on i.session_id = s.id
    where s.status in ('active', 'paused')${onlySession}
    group by s.id, s.user_id, s.updated_at`;
}

interface IdleRowRaw {
  session_id: string;
  user_id: string;
  last_activity_at: Date | string;
  live: unknown;
}

/**
 * PURE row mapper. Raw `db.execute` rows skip drizzle's column decoding, so a
 * timestamptz can arrive as a Date or a string and a boolean as a boolean or
 * 't'/'f'. Anything unclear fails SAFE: an unrecognised `live` reads as live,
 * and an unparseable time is never idle (isIdleRun) — a bad row is never cut.
 */
export function toCandidate(raw: IdleRowRaw): IdleCandidate {
  const live = !(raw.live === false || raw.live === 'f' || raw.live === 'false');
  return {
    sessionId: raw.session_id,
    userId: raw.user_id,
    lastActivityAt: raw.last_activity_at instanceof Date ? raw.last_activity_at : new Date(raw.last_activity_at),
    live,
  };
}

export interface IdleRunDeps {
  /** Every candidate run; given a session id, just that run (empty when it is no
   *  longer a candidate). The tick uses the second form to re-check before cutting. */
  candidates: (sessionId?: string) => Promise<IdleCandidate[]>;
  now: () => Date;
  /** Stop one run (engine.ts stopIdleSession). `skipped` = it had already ended
   *  since the candidate snapshot. Injected so the tick is testable without Twilio. */
  stop: (sessionId: string) => Promise<{ action: 'stopped' | 'skipped' }>;
}

/** One pass; returns how many runs it stopped. Each candidate idle in the
 *  snapshot is re-read by id, with a fresh clock, right before its stop; one
 *  that is no longer idle, or no longer a candidate, is skipped silently. A run
 *  that had already ended (`skipped`) is silent and not counted. A failed stop
 *  (or re-check) is logged and the next idle run is still stopped. */
export async function stopIdleRunsTick(deps: IdleRunDeps): Promise<number> {
  const candidates = await deps.candidates();
  const now = deps.now();
  let stopped = 0;
  for (const snapshot of candidates) {
    if (!isIdleRun(snapshot, now)) continue;
    try {
      const recheckAt = deps.now();
      const fresh = (await deps.candidates(snapshot.sessionId)).find((c) => c.sessionId === snapshot.sessionId);
      if (!fresh || !isIdleRun(fresh, recheckAt)) continue;
      const result = await deps.stop(fresh.sessionId);
      if (result.action !== 'stopped') continue;
      stopped += 1;
      console.info('[dialer] idle run stopped', {
        sessionId: fresh.sessionId,
        userId: fresh.userId,
        idleMinutes: Math.floor((recheckAt.getTime() - fresh.lastActivityAt.getTime()) / 60_000),
      });
    } catch (err) {
      console.error('[dialer] idle run stop failed', { sessionId: snapshot.sessionId, err: (err as Error).message });
    }
  }
  return stopped;
}

/** Nothing is built at import: the db handle and the engine deps (which stamp
 *  their own clock) are made inside each call. */
export const liveIdleRunDeps: IdleRunDeps = {
  candidates: async (sessionId) => {
    const result = await getDb().execute(idleRunCandidatesStatement(new Date(), sessionId));
    return (result as unknown as { rows: IdleRowRaw[] }).rows.map(toCandidate);
  },
  now: () => new Date(),
  stop: (sessionId) => stopIdleSession(sessionId, buildEngineDeps()),
};

/** Single-flight: a slow tick is never overlapped. `deps` is a test seam. */
export function startIdleRunLoop(
  intervalMs: number = IDLE_CHECK_INTERVAL_MS,
  deps: IdleRunDeps = liveIdleRunDeps,
): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    stopIdleRunsTick(deps)
      .catch((err) => console.error('[dialer] idle run tick failed', { err: (err as Error).message }))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}

/** The kill switch (config.ts DIALER_IDLE_STOP). `start` is a test seam. */
export function maybeStartIdleRunLoop(
  cfg: Pick<AppConfig, 'DIALER_IDLE_STOP'>,
  start: (intervalMs: number) => NodeJS.Timeout = startIdleRunLoop,
): NodeJS.Timeout | null {
  return cfg.DIALER_IDLE_STOP === 'on' ? start(IDLE_CHECK_INTERVAL_MS) : null;
}

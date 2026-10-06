/**
 * Hang up idle power-dial lines (idle-cutoff spec,
 * docs/superpowers/specs/2026-10-06-dialer-idle-cutoff-design.md §2). A rep once
 * left a line open on hold music for 7.5 hours with zero dials. Every 30 s, find
 * runs that are `active` or `paused` AND still have an open rep leg, where
 * nothing has happened for DIALER_IDLE_MS, and STOP them through the same
 * `stopSession` the rep's Stop uses (leg hung up, run `stopped`), recording
 * stop_reason = 'idle' so the softphone can say why.
 *
 * STOP, never pause: the softphone's drop recovery (cti-web dialer-leg.ts
 * recoverDroppedLeg) rejoins a run that reads `active` or `paused`. Only a
 * stopped run keeps the line down; the rep starts a new one from the list,
 * which continues from the shared list position.
 *
 * Idle = no live dial AND the newest change is at least DIALER_IDLE_MS old. A
 * ringing dial or a live conversation is never cut, however long it runs — the
 * same "a live dial is presence" rule as engine.ts `isTalking` and the
 * abandoned-run reaper (salesforce/followup-worker.ts expireAbandonedSessions).
 * A run parked while the rep takes a callback has already dropped its leg, so
 * the open-leg join leaves it alone.
 *
 * Accepted race: a rep who presses Next in the same instant as the cut sees the
 * run stop; they had been idle for 15 minutes.
 *
 * Kill switch: DIALER_IDLE_STOP=off never starts the loop (config.ts).
 */
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '@cti/db';
import type { AppConfig } from '../config.js';
import { stopSession } from './engine.js';
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
 * One statement per tick, no parameters — the 15 minutes is applied by
 * `isIdleRun`, so the constant lives in one place. `live` counts an item the
 * rep is still on: dialing, or connected with the prospect not yet gone.
 */
export function idleRunCandidatesStatement(): SQL {
  return sql`
    select s.id as session_id, s.user_id,
           greatest(s.updated_at, max(l.joined_at), max(i.updated_at)) as last_activity_at,
           coalesce(bool_or(i.status = 'dialing' or (i.status = 'connected' and i.prospect_ended_at is null)), false) as live
    from dialer_sessions s
    join dialer_rep_legs l on l.session_id = s.id and l.ended_at is null
    left join dialer_queue_items i on i.session_id = s.id
    where s.status in ('active', 'paused')
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
  candidates: () => Promise<IdleCandidate[]>;
  now: () => Date;
  /** Stop one run (engine.ts stopSession, reason 'idle'). Injected so the tick is testable without Twilio. */
  stop: (sessionId: string) => Promise<unknown>;
}

/** One pass. A failed stop is logged and the next idle run is still stopped. */
export async function stopIdleRunsTick(deps: IdleRunDeps): Promise<number> {
  const candidates = await deps.candidates();
  const now = deps.now();
  let stopped = 0;
  for (const c of candidates) {
    if (!isIdleRun(c, now)) continue;
    try {
      await deps.stop(c.sessionId);
      stopped += 1;
      console.info('[dialer] idle run stopped', {
        sessionId: c.sessionId,
        userId: c.userId,
        idleMinutes: Math.floor((now.getTime() - c.lastActivityAt.getTime()) / 60_000),
      });
    } catch (err) {
      console.error('[dialer] idle run stop failed', { sessionId: c.sessionId, err: (err as Error).message });
    }
  }
  return stopped;
}

/** Nothing is built at import: the db handle and the engine deps (which stamp
 *  their own clock) are made inside each call. */
const liveIdleRunDeps: IdleRunDeps = {
  candidates: async () => {
    const result = await getDb().execute(idleRunCandidatesStatement());
    return (result as unknown as { rows: IdleRowRaw[] }).rows.map(toCandidate);
  },
  now: () => new Date(),
  stop: (sessionId) => stopSession(sessionId, buildEngineDeps(), { reason: 'idle' }),
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

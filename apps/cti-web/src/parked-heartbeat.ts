/**
 * The heartbeat for a run parked while the rep takes a callback (spec
 * 2026-09-26 decision 7). The Power Dial panel — the run's usual poller — is
 * off screen during the call, and the reaper (services/cti-api
 * salesforce/followup-worker.ts `expireAbandonedSessions`) stops a paused run
 * nobody has polled for ten minutes. A GET of the session is the poll that
 * counts (it stamps `last_polled_at`).
 */
import { ApiError } from './api';
import type { DialerSession } from './dialer-api';

export const PARKED_HEARTBEAT_MS = 60_000;
/** Consecutive failed beats before the rep is told: five minutes of silence is
 *  half the reaper's window. */
export const HEARTBEAT_FAILURES_BEFORE_WARNING = 5;
export const HEARTBEAT_UNREACHABLE_TEXT = "Can't reach the server — your paused Power Dial run may be stopped if this goes on. Check your connection.";

export interface ParkedHeartbeatDeps {
  poll: (sessionId: string) => Promise<{ session: Pick<DialerSession, 'status'> }>;
  /** The run reads as done or stopped, or the server says it is gone (404) or
   *  not the rep's (403): release it (App's dropConferenceLeg). */
  onRunOver: () => void;
  /** HEARTBEAT_FAILURES_BEFORE_WARNING beats in a row failed — once per streak. */
  onUnreachable: () => void;
}

/** What App does when the heartbeat's run reads as over. */
export type ParkedRunOverAction = 'release' | 'unpark' | 'ignore';

/**
 * The run this heartbeat keeps alive (`heartbeatRunId`) reads as over. Release
 * it — drop the leg and unlock the nav — only while it is still the run parked
 * here (`parkedRunId`) and no leg is live. With a leg live (Resume re-joined)
 * just stop beating: that leg is not this heartbeat's to drop. A run no longer
 * parked here is none of its business.
 */
export function parkedRunOverAction(heartbeatRunId: string, parkedRunId: string | null, legLive: boolean): ParkedRunOverAction {
  if (parkedRunId !== heartbeatRunId) return 'ignore';
  return legLive ? 'unpark' : 'release';
}

/** Beat every PARKED_HEARTBEAT_MS until the returned stop() is called or the
 *  run reads as over. A single failed beat is retried by the next one. */
export function startParkedHeartbeat(sessionId: string, deps: ParkedHeartbeatDeps): () => void {
  let stopped = false;
  let failures = 0;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const beat = async (): Promise<void> => {
    try {
      const view = await deps.poll(sessionId);
      failures = 0;
      if (stopped) return;
      if (view.session.status === 'done' || view.session.status === 'stopped') {
        stop();
        deps.onRunOver();
      }
    } catch (e) {
      // 404 (gone) / 403 (no longer the rep's run): a retry never heals these,
      // and beating on would keep the phone locked on a dead run.
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        if (stopped) return;
        stop();
        deps.onRunOver();
        return;
      }
      failures++;
      if (!stopped && failures === HEARTBEAT_FAILURES_BEFORE_WARNING) deps.onUnreachable();
    }
  };
  const timer = setInterval(() => { void beat(); }, PARKED_HEARTBEAT_MS);
  return stop;
}

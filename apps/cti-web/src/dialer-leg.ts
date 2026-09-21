/**
 * The rep's power-dialer conference leg, seen from the softphone: what to send
 * when joining, how to notice the leg dying, and what to do about it.
 *
 * Why this exists. The leg is one long-lived call across a whole run. Since the
 * hold-music fix (services/cti-api dialer/twilio-telephony.ts `bridgeTwiml`) it
 * survives each prospect leaving only because Twilio asks the API's rejoin route
 * what to do next — so every conversation now ends with a server round trip that
 * can fail (a deploy cutover, a slow database, a dropped webhook). When it does,
 * the leg ends while the run stays `active`, and the engine keeps bridging humans
 * into a room with no rep in it. Nothing told the softphone: it had no
 * `disconnect` listener on this connection at all. The same hole existed before
 * for a plain network drop; this closes both.
 *
 * Pure apart from the injected deps, so App.tsx only wires it up.
 */
import type { DialerSession } from './dialer-api';

/**
 * `device.connect()` params for the conference leg. `DialerSessionId` lets the
 * server record this call's sid on THIS run — including one that came up
 * `paused` (no numbers free), which its "the rep's one active run" fallback
 * cannot see. The run-end cleanup hangs up the leg by that sid.
 */
export function dialerJoinParams(sessionId: string | null): Record<string, string> {
  return sessionId ? { DialerConference: '1', DialerSessionId: sessionId } : { DialerConference: '1' };
}

/**
 * Call `onDropped` when this leg disconnects and we did not ask it to. `isOurs`
 * is "the ref still points at this connection": Stop / run-complete clear the
 * ref BEFORE they disconnect, so their own hang-ups are ignored here.
 */
export function watchDialerLeg(connection: unknown, opts: { isOurs: () => boolean; onDropped: () => void }): void {
  const on = (connection as { on?: (event: string, cb: () => void) => void } | null)?.on;
  if (typeof on !== 'function') return;
  on.call(connection, 'disconnect', () => {
    if (opts.isOurs()) opts.onDropped();
  });
}

/** The server hangs the leg up BEFORE flipping a finished run out of `active`
 *  (dialer/engine.ts `releaseRepConference`); look too soon and a run that is
 *  over still reads as live. */
export const LEG_RECOVERY_DELAY_MS = 1500;
/** A leg that keeps dying is not going to be fixed by a fourth attempt. */
export const MAX_LEG_RECOVERIES = 3;

export interface LegRecoveryDeps {
  /** False once a Stop or a newer run superseded the run whose leg dropped. */
  isCurrent: () => boolean;
  wait: (ms: number) => Promise<void>;
  fetchStatus: () => Promise<DialerSession['status']>;
  /** Re-join the conference; resolves false when superseded mid-join. */
  rejoin: () => Promise<boolean>;
  stop: () => Promise<void>;
}

export type LegRecovery = 'superseded' | 'run-over' | 'rejoined' | 'stopped';

/**
 * The leg dropped on its own. Get the rep back into the room if the run is still
 * live; if that cannot be done, STOP the run — a live run with no rep leg bridges
 * every human who answers into an empty room. Never throws.
 */
export async function recoverDroppedLeg(deps: LegRecoveryDeps, recoveriesSoFar: number): Promise<LegRecovery> {
  await deps.wait(LEG_RECOVERY_DELAY_MS);
  if (!deps.isCurrent()) return 'superseded';

  // Unreadable = assume live: trying to rejoin a finished run is harmless (the
  // poll tears it down), assuming a live run is over leaves it dialing unattended.
  let status: DialerSession['status'] | null = null;
  try { status = await deps.fetchStatus(); } catch { /* treated as live below */ }
  if (status !== null && status !== 'active' && status !== 'paused') return 'run-over';

  const stop = async (): Promise<'stopped'> => {
    try { await deps.stop(); } catch { /* the poll shows whatever state the run is in */ }
    return 'stopped';
  };
  if (recoveriesSoFar >= MAX_LEG_RECOVERIES) return stop();
  try {
    return (await deps.rejoin()) ? 'rejoined' : 'superseded';
  } catch {
    return stop();
  }
}

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
 *  (dialer/engine.ts `releaseRepConference`), and that teardown is up to five
 *  sequential Twilio REST calls; look too soon and a run that is over still
 *  reads as live. Too-soon self-heals (the poll drops the rejoined leg), so this
 *  buys a quiet run end, not correctness. */
export const LEG_RECOVERY_DELAY_MS = 1500;
/** A leg that keeps dying is not going to be fixed by a fourth attempt… */
export const MAX_LEG_RECOVERIES = 3;
/** …within ten minutes. Three drops across a four-hour shift mean nothing. */
export const LEG_RECOVERY_WINDOW_MS = 10 * 60_000;
/** Waits between attempts to stop a run whose leg could not be brought back. The
 *  usual cause is the network being down, which fails the stop as well. */
export const STOP_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10_000, 20_000];

/** How many of these rejoin times still count against the cap at `now`. */
export function recentRejoins(rejoinedAt: readonly number[], now: number): number {
  return rejoinedAt.filter((t) => now - t < LEG_RECOVERY_WINDOW_MS).length;
}

export interface LegRecoveryDeps {
  /** False once a Stop or a newer run superseded the run whose leg dropped. */
  isCurrent: () => boolean;
  wait: (ms: number) => Promise<void>;
  fetchStatus: () => Promise<DialerSession['status']>;
  /** Re-join the conference; resolves false when superseded mid-join. */
  rejoin: () => Promise<boolean>;
  stop: () => Promise<void>;
  /**
   * Asked right before the rejoin. `device.connect()` silently ignore()s a call
   * still ringing on the Device (voice-sdk device.ts `connect`, no event), so a
   * callback waiting for the rep must be dealt with first (spec 2026-09-26
   * decision 9). Resolves true when it was — the run is parked, or the
   * callback's own sequence now owns the leg — and the leg must NOT be
   * re-joined; false to rejoin as usual. Never rejects.
   */
  handOffCallback?: () => Promise<boolean>;
}

/** `stop-failed` is NOT `stopped`: the run may still be active on the server.
 *  `handed-off`: a waiting callback took the rejoin's place (see handOffCallback). */
export type LegRecovery = 'superseded' | 'run-over' | 'rejoined' | 'handed-off' | 'stopped' | 'stop-failed';

/**
 * The leg dropped on its own. Get the rep back into the room if the run is still
 * live; if that cannot be done, STOP the run — a live run with no rep leg bridges
 * every human who answers into an empty room. `recentRejoinCount` is
 * `recentRejoins(...)`. Never throws.
 */
export async function recoverDroppedLeg(deps: LegRecoveryDeps, recentRejoinCount: number): Promise<LegRecovery> {
  await deps.wait(LEG_RECOVERY_DELAY_MS);
  if (!deps.isCurrent()) return 'superseded';

  // Unreadable = assume live: trying to rejoin a finished run is harmless (the
  // poll tears it down), assuming a live run is over leaves it dialing unattended.
  let status: DialerSession['status'] | null = null;
  try { status = await deps.fetchStatus(); } catch { /* treated as live below */ }
  // That read was a round trip; a Stop may have landed while it was out.
  if (!deps.isCurrent()) return 'superseded';
  if (status !== null && status !== 'active' && status !== 'paused') return 'run-over';

  if (recentRejoinCount < MAX_LEG_RECOVERIES) {
    if (deps.handOffCallback) {
      if (await deps.handOffCallback()) return 'handed-off';
      // The hand-off can be a round trip too.
      if (!deps.isCurrent()) return 'superseded';
    }
    try {
      return (await deps.rejoin()) ? 'rejoined' : 'superseded';
    } catch { /* fall through: the run must not keep dialing */ }
  }
  return stopForCertain(deps);
}

/** One failed stop is not the end of it: whatever broke the rejoin (usually the
 *  network) breaks the stop too, and giving up leaves the run ACTIVE with nobody
 *  in the room. Retry on a backoff; report honestly if it never lands. */
async function stopForCertain(deps: LegRecoveryDeps): Promise<LegRecovery> {
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.stop();
      return 'stopped';
    } catch { /* retried below */ }
    if (!deps.isCurrent()) return 'superseded'; // the rep pressed Stop, or started another run
    const delay = STOP_RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return 'stop-failed';
    await deps.wait(delay);
    if (!deps.isCurrent()) return 'superseded';
  }
}

/** What to tell the rep. `stop-failed` must never read as "stopped". */
export function legRecoveryToast(outcome: LegRecovery): { text: string; type: 'success' | 'error' } | null {
  switch (outcome) {
    case 'rejoined':
      return { type: 'success', text: 'Power Dial audio reconnected. If the run shows Paused, press Resume.' };
    case 'stopped':
      return { type: 'error', text: 'Power Dial lost its audio connection, so the run was stopped. Start it again to continue.' };
    case 'stop-failed':
      return { type: 'error', text: 'Power Dial lost its audio connection and the run could not be stopped. Press Stop as soon as you are back online.' };
    default:
      return null;
  }
}

/** How long a re-join may take to be answered before it counts as failed. */
export const LEG_ACCEPT_TIMEOUT_MS = 10_000;
/** Twilio ended the re-join unanswered — the API's /voice guard answers a join
 *  of a run that is not the rep's newest live one with <Reject/>. */
export const LEG_REFUSED_MESSAGE = "Couldn't rejoin the run — if another power-dial run of yours is live, stop it first.";
/** No answer in time, or an error on the leg: the rep's connection or mic. */
export const LEG_JOIN_FAILED_MESSAGE = "Couldn't reconnect you to the run — check your connection and microphone, then press Resume again.";

/** Why a re-join was not answered. */
export type LegJoinFailure = 'refused' | 'failed';

export class LegJoinError extends Error {
  constructor(readonly reason: LegJoinFailure) {
    super(reason === 'refused' ? LEG_REFUSED_MESSAGE : LEG_JOIN_FAILED_MESSAGE);
    this.name = 'LegJoinError';
  }
}

/** SIP decline / busy / unavailable: how a TwiML <Reject/> reaches a call the
 *  client placed (voice-sdk call.ts `_onHangup`). With the SDK's default
 *  signalling precision they arrive wrapped in a 31005 ConnectionError whose
 *  `originalError` carries the code. */
const DECLINE_CODES: ReadonlySet<number> = new Set([31480, 31486, 31603]);

function isDecline(err: unknown): boolean {
  const e = err as { code?: unknown; originalError?: { code?: unknown } } | null | undefined;
  const code = typeof e?.code === 'number' && DECLINE_CODES.has(e.code) ? e.code : e?.originalError?.code;
  return typeof code === 'number' && DECLINE_CODES.has(code);
}

/**
 * Resolves once Twilio has ANSWERED this leg (`accept`) — the room is really
 * joined. Resume after a callback waits on this before it POSTs resume (spec
 * 2026-09-26 decision 6): the server must not start dialing a paused run until
 * its rep is back in the room. Otherwise rejects with a LegJoinError:
 *  - `refused`: the leg ended unanswered (`disconnect`/`cancel`/`reject`, or an
 *    `error` carrying a SIP decline) — the /voice guard's <Reject/>; or it was
 *    answered and closed in the same tick, so there is no live leg to adopt;
 *  - `failed`: any other `error` on the leg, or no answer within `timeoutMs`.
 */
export function legAccepted(connection: unknown, timeoutMs: number = LEG_ACCEPT_TIMEOUT_MS): Promise<void> {
  const conn = connection as { on?: (event: string, cb: (arg?: unknown) => void) => void; status?: () => string } | null;
  const on = conn?.on;
  if (typeof on !== 'function') return Promise.reject(new LegJoinError('failed'));
  const answered = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (failure: LegJoinFailure | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(new LegJoinError(failure));
      else resolve();
    };
    const timer = setTimeout(() => settle('failed'), timeoutMs);
    on.call(connection, 'accept', () => settle(null));
    for (const event of ['disconnect', 'cancel', 'reject']) on.call(connection, event, () => settle('refused'));
    on.call(connection, 'error', (err) => settle(isDecline(err) ? 'refused' : 'failed'));
  });
  // Answered and hung up in the same tick (Task 3 review, minor 4): by the time
  // anyone could adopt the leg it is closed, and its 'disconnect' has already
  // gone unheard — adopting it would strand the run with a dead leg.
  return answered.then(() => {
    if (conn?.status?.() === 'closed') throw new LegJoinError('refused');
  });
}

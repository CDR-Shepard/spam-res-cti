/**
 * Callback waiting during a power-dial run — the softphone's decisions (spec
 * docs/superpowers/specs/2026-09-26-callback-waiting-design.md).
 *
 * WHY: the rep's conference leg is an active call, so a callback to their own
 * numbers used to be dropped by the SDK in 0 s while they power dialed. The
 * Device now takes calls while busy (App.tsx ensureDevice); this module decides
 * what each one does, and runs the Pause & answer sequence. Pure apart from the
 * injected deps, so App.tsx only wires it.
 */
import { ApiError } from './api';
import type { DialerSession, DialerSessionView } from './dialer-api';
import { formatE164 } from './format';
import { getIncomingCallerInfo, type IncomingCallLike } from './incoming-accept';

/** App's toast, as a value. */
export type ToastSpec = { text: string; type: 'info' | 'error' | 'success' };

export const CALLER_HUNG_UP_TEXT = 'The caller hung up before you answered.';
export const PARKED_AFTER_DROP_TEXT = 'Power Dial lost its audio connection, so the run is paused. Press Resume to continue.';

/** The slice of DialerPanel's latest poll App keeps (spec decision 3). */
export interface RunSnapshot {
  sessionId: string;
  sessionStatus: DialerSession['status'];
  /** The in-flight item's status (dialing / connected), or null between dials. */
  itemStatus: string | null;
  prospectEndedAt: string | null;
}

export function runSnapshotOf(view: DialerSessionView): RunSnapshot {
  return {
    sessionId: view.session.id,
    sessionStatus: view.session.status,
    itemStatus: view.currentItem?.status ?? null,
    prospectEndedAt: view.currentItem?.prospectEndedAt ?? null,
  };
}

/** Talking = the current item is connected and the prospect has not hung up
 *  (decision 3) — the same rule the server's take-callback 409s on. */
export function isTalking(s: RunSnapshot | null): boolean {
  return s?.itemStatus === 'connected' && !s.prospectEndedAt;
}

/**
 * Where an incoming call goes:
 *  - `ring`   — today's ring screen;
 *  - `wait`   — the Power Dial banner (Pause & answer / Ignore);
 *  - `reject` — forward or voicemail, silently, as a busy rep's callback always went;
 *  - `reject-talking` — the same, plus a toast saying so.
 */
export type IncomingRoute = 'ring' | 'wait' | 'reject' | 'reject-talking';

export interface IncomingContext {
  /** An outbound dial is being placed (App's placingRef). */
  placing: boolean;
  /** App's phase: idle | preflight | ringing | active | wrapup. */
  phase: string;
  /** This tab holds a dialer conference leg (App's dialerConnRef). */
  legLive: boolean;
  /** The run that leg belongs to. */
  legSessionId: string | null;
  /** A callback is already waiting on the banner. */
  waiting: boolean;
  /** DialerPanel's latest poll, lifted to App. */
  snapshot: RunSnapshot | null;
}

export function routeIncoming(c: IncomingContext): IncomingRoute {
  // Today's busy rule, first and unchanged: a manual call up, ringing, in
  // wrap-up, or being placed.
  if (c.placing || (c.phase !== 'idle' && c.phase !== 'preflight')) return 'reject';
  // No run on the line: exactly today's ring screen.
  if (!c.legLive) return 'ring';
  // One callback at a time.
  if (c.waiting) return 'reject';
  // A snapshot of another run (the Salesforce handoff seam can swap the
  // panel's run mid-run), or none yet, is unknown: show the banner and let
  // take-callback's 409 decide.
  const snap = c.snapshot && c.snapshot.sessionId === c.legSessionId ? c.snapshot : null;
  return isTalking(snap) ? 'reject-talking' : 'wait';
}

/** A callback on the banner. */
export interface WaitingCallback<C extends IncomingCallLike = IncomingCallLike> {
  /** Stable per call (the CallSid) — keys the banner, so each callback chimes once. */
  id: string;
  call: C;
  /** The matched Salesforce name, else the formatted number. */
  callerLabel: string;
  recordType?: string;
}

export function callerLabelOf(call: IncomingCallLike): string {
  const info = getIncomingCallerInfo(call);
  return info.callerName?.trim() || formatE164(info.from) || 'Unknown caller';
}

export type MissedReason = 'on-call' | 'not-paused';

/** The toast for a callback the softphone rejected. It went where a busy
 *  rep's callback always went: the Settings forward, else voicemail. */
export function missedCallbackToast(callerLabel: string, forwardE164: string | null, reason: MissedReason = 'on-call'): ToastSpec {
  const where = forwardE164 ? 'your cell' : 'voicemail';
  const why = reason === 'on-call' ? 'you were on a call' : "Power Dial couldn't pause your run";
  return { text: `Missed callback from ${callerLabel} — ${why}. It went to ${where}.`, type: 'info' };
}

/** take-callback's 409 contract: `{ reason: 'connected' }` means a prospect is
 *  on the line (and the server changed nothing). Anything else is a failure. */
export function takeCallbackRefusal(e: unknown): 'talking' | 'failed' {
  if (e instanceof ApiError && e.status === 409 && (e.data as { reason?: unknown } | null)?.reason === 'connected') return 'talking';
  return 'failed';
}

function failureText(e: unknown): string {
  if (e instanceof ApiError) {
    const msg = (e.data as { error?: unknown } | null)?.error;
    if (typeof msg === 'string') return msg;
  }
  return e instanceof Error ? e.message : 'unknown error';
}

export interface PauseAndAnswerDeps {
  /** POST take-callback for the run the leg belongs to. */
  takeCallback: () => Promise<unknown>;
  /** The waiting callback is still this call, and still ringing. */
  stillRinging: () => boolean;
  /** Clear the dialer ref, then disconnect the leg; park the run. */
  leaveRoom: () => void;
  /** Take the banner down without touching the call. */
  clear: () => void;
  /** Reject the callback (forward/voicemail) and take the banner down. */
  reject: () => void;
  /** Answer through the normal inbound path (App's acceptCall). */
  accept: () => void;
  toast: (t: ToastSpec) => void;
  missedToast: () => ToastSpec;
  /** A Stop, the run ending, or a newer run landed while take-callback was
   *  out — the callback has been handed to the ring screen already. */
  superseded: () => boolean;
}

export type PauseAndAnswerOutcome = 'answered' | 'talking' | 'caller-gone' | 'failed' | 'superseded';

/**
 * Pause & answer, in this order and no other (spec decisions 4-5):
 *  1. the server pauses the run FIRST (and cancels a dial still ringing);
 *  2. only then does the rep leave the room — the ref cleared before
 *     disconnect(), so the leg's drop recovery never fires;
 *  3. only then is the callback answered, through the normal inbound path.
 * A 409 means a prospect answered in the race: the rep is talking, so the
 * callback is rejected with the toast and the leg is never touched. Any other
 * failure touches nothing and says why; the banner stays up. A caller who hung
 * up during the round trip leaves the rep in the room of the now-paused run.
 * Superseded during the round trip (a Stop, the run ended): whatever the
 * server said, touch nothing and say nothing — the callback is on the ring
 * screen now, and is the rep's to answer there.
 */
export async function runPauseAndAnswer(deps: PauseAndAnswerDeps): Promise<PauseAndAnswerOutcome> {
  try {
    await deps.takeCallback();
  } catch (e) {
    if (deps.superseded()) return 'superseded';
    if (takeCallbackRefusal(e) === 'talking') {
      deps.reject();
      deps.toast(deps.missedToast());
      return 'talking';
    }
    deps.toast({ text: `Couldn't pause the run to answer: ${failureText(e)}`, type: 'error' });
    return 'failed';
  }
  if (deps.superseded()) return 'superseded';
  if (!deps.stillRinging()) {
    deps.clear();
    deps.toast({ text: CALLER_HUNG_UP_TEXT, type: 'info' });
    return 'caller-gone';
  }
  deps.leaveRoom();
  deps.clear();
  deps.accept();
  return 'answered';
}

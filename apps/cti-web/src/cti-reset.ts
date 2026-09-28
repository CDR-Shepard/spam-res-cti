/**
 * Reset CTI, the web softphone's side (design:
 * docs/superpowers/specs/2026-09-28-cti-reset-design.md). These are the pure
 * pieces, so what counts as "busy" and the ORDER of a reset are pinned by unit
 * tests. use-cti-reset.ts wires them to the browser, App and the coordinator.
 *
 * isBusyForReset follows controller ruling R1 (overrides the design doc's
 * decision 5 in two places): an old pendingDisposition that is NOT the open
 * wrap-up form does not block a reset, and neither does a dialer run's
 * dialerSessionId once the run is terminal (stopped/done) — its summary
 * screen. Only the run's latest snapshot status (active/paused) counts.
 */
import { SESSION_KEY } from './api';
import { AUDIO_INPUT_KEY, AUDIO_OUTPUT_KEY, browserStorage, type StorageLike } from './audio-devices';

/** The rep's typed display name (App.tsx `customDisplayName`). */
export const DISPLAY_NAME_KEY = 'cti.displayName';
/** Written after a reset's wipe: the sign-in screen says why. Cleared by signing in. */
export const RESET_NOTICE_KEY = 'cti.reset.notice';
/** Written after a reset's wipe: the sound check runs after sign-in. Cleared by "Looks good". */
export const SOUND_CHECK_DUE_KEY = 'cti.soundCheck.due';
/** Every key the softphone keeps; a reset removes all of them (spec decision 4, step 5). */
export const RESET_WIPE_KEYS: readonly string[] = [SESSION_KEY, DISPLAY_NAME_KEY, AUDIO_INPUT_KEY, AUDIO_OUTPUT_KEY];
/** The sign-in screen's line after a reset (spec, exact). */
export const RESET_NOTICE_TEXT = 'Your admin reset your phone. Sign in again to reconnect.';

/** What App knows, read from its refs at the moment of asking. */
export interface ResetBusySnapshot {
  phase: string;
  /** An outstanding disposition banner (App's pendingDisp). Per controller
   *  ruling R1 this does NOT block a reset by itself — only `phase ===
   *  'wrapup'` (the open wrap-up form) does. Kept on the snapshot so the type
   *  documents the decision rather than silently dropping the field. */
  pendingDisposition: boolean;
  placing: boolean;
  takingCallback: boolean;
  incoming: boolean;
  /** connectionRef outlives the call, so only a LIVE one counts. */
  connection: { status?: () => string } | null;
  dialerConn: boolean;
  dialerLive: boolean;
  /** The run whose confirm or summary screen may still be showing (App's
   *  dialerSessionIdRef). Per R1 this alone never blocks a reset — see
   *  `dialerRunStatus`. */
  dialerSessionId: string | null;
  /** The dialer run's latest snapshot status (App's runSnapshotRef,
   *  `sessionStatus`), or null when there is no run. Controller ruling R1:
   *  only 'active' or 'paused' block a reset. A terminal 'stopped' or 'done'
   *  run — its summary screen — does not, even with a `dialerSessionId`. */
  dialerRunStatus: string | null;
  callbackWaiting: boolean;
  parkedRunId: string | null;
}

/**
 * Would a reset interrupt something? (spec decision 5, as overridden by
 * controller ruling R1). Wider than the election's "busy": wrap-up, placing a
 * call, taking a callback, a live dialer leg or run, a parked run and a
 * waiting callback all count, so a reset never lands on any of them. An old
 * pending disposition and a terminal run's summary screen do NOT count — the
 * reset waits only for genuinely live telephony.
 */
export function isBusyForReset(s: ResetBusySnapshot): boolean {
  if (s.phase === 'ringing' || s.phase === 'active' || s.phase === 'wrapup') return true;
  if (s.placing || s.takingCallback || s.incoming) return true;
  if (s.connection && s.connection.status?.() !== 'closed') return true;
  if (s.dialerConn || s.dialerLive) return true;
  if (s.dialerRunStatus === 'active' || s.dialerRunStatus === 'paused') return true;
  if (s.parkedRunId !== null) return true;
  return s.callbackWaiting;
}

/** The token of the session in storage, or null when there is none or it is unreadable. */
export function storedSessionToken(storage: StorageLike | null = browserStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    const token = (JSON.parse(raw) as { token?: unknown }).token;
    return typeof token === 'string' ? token : null;
  } catch {
    return null; // unreadable (blocked storage or not JSON): no session we can name
  }
}

/**
 * Steps 5 and 6 of a reset. Remove every softphone key, THEN write the two
 * flags. Because they're written after the wipe, they survive it into the
 * reloaded page. This is a compare-and-delete: when storage holds a DIFFERENT
 * session (the rep signed in again on another tab while this one waited out a
 * call), nothing is touched, so a late tab can never sign the rep out of
 * their new session. Returns true when it wiped. Never throws.
 */
export function wipeForReset(pageToken: string | null, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    // Read directly rather than through storedSessionToken: that helper
    // treats "the value isn't valid JSON" and "storage itself threw" the same
    // (both → null), but here they must not be. A malformed value still
    // counts as ours (fall through and wipe); a storage that throws on read
    // is genuinely broken and must abort — caught below, never wiped.
    const raw = storage.getItem(SESSION_KEY);
    let current: string | null = null;
    if (raw) {
      try {
        const token = (JSON.parse(raw) as { token?: unknown }).token;
        current = typeof token === 'string' ? token : null;
      } catch {
        current = null; // unreadable value: count as ours
      }
    }
    if (current !== null && current !== pageToken) return false;
    for (const key of RESET_WIPE_KEYS) storage.removeItem(key);
    storage.setItem(SOUND_CHECK_DUE_KEY, '1');
    storage.setItem(RESET_NOTICE_KEY, '1');
    return true;
  } catch {
    return false; // blocked storage: there is nothing of ours in it to wipe
  }
}

/** Is a flag set ('1')? False when storage is missing or blocked. */
export function readFlag(key: string, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** Clear a flag. Blocked storage is harmless: a flag that can't be read is never shown. */
export function clearFlag(key: string, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Blocked storage: readFlag reads false there too, so nothing shows.
  }
}

export interface PerformResetDeps {
  teardownDevice: () => void;
  /** Storage still holds this tab's session (not a newer one, not none). */
  sessionIsOurs: () => boolean;
  postResetComplete: () => Promise<void>;
  broadcastReset: () => void;
  /** wipeForReset for this tab's session. */
  wipe: () => boolean;
  reload: () => void;
  warn: (message: string, err: unknown) => void;
}

/**
 * A reset, in the spec's order (decision 4). The caller runs the idle check
 * (this tab AND its peers) synchronously just before: see reset-poller.ts.
 *  2. teardownDevice: releases a pinned mic and unregisters from Twilio.
 *  3. POST /auth/reset-complete: stamps done and revokes THIS session.
 *  4. broadcast {type:'reset'}: peer tabs finish too.
 *     3 and 4 are for the tab that starts the reset, and only while storage
 *     still holds its session. A stale tab just reloads.
 *  5-6. wipe the keys, then write the notice and sound-check flags.
 *  7. reload: keeps ?sf=, and inside Salesforce only the softphone iframe reloads.
 * A failed POST does not stop the reset: the token leaves storage, and the
 * next sign-in's session is newer than the request, which is what ends it.
 */
export async function performReset(deps: PerformResetDeps, initiator: boolean): Promise<void> {
  deps.teardownDevice();
  if (initiator && deps.sessionIsOurs()) {
    try {
      await deps.postResetComplete();
    } catch (err) {
      deps.warn('[cti-reset] reset-complete failed; wiping and reloading anyway', err);
    }
    try {
      deps.broadcastReset();
    } catch (err) {
      deps.warn('[cti-reset] could not tell the other tabs; each finishes when it next leads', err);
    }
  }
  deps.wipe();
  deps.reload();
}

/** window.location.reload behind an object tests can spy on (jsdom's location is not configurable). */
export const pageReloader = {
  reload(): void {
    window.location.reload();
  },
};

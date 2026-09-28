/**
 * Wires Reset CTI into App: one reset poller per signed-in page, driven by the
 * softphone coordinator (leadership, peers' busy flags, the reset broadcast).
 * Only the softphone LEADER starts a reset, with the POST and the broadcast.
 * Every other tab waits for its {type:'reset'} and then finishes without
 * POSTing. So two tabs that learn "due" together never both act, and all of
 * them reload.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { api } from './api';
import { pageReloader, performReset, storedSessionToken, wipeForReset, type PerformResetDeps } from './cti-reset';
import { createResetPoller, type ResetPoller } from './reset-poller';
import type { SoftphoneCoordinator } from './softphone-coordinator';

/** The Device is already down when this POST goes out. A hung request must
 *  not leave the rep unable to take calls for long. */
export const RESET_COMPLETE_TIMEOUT_MS = 5_000;

/** GET /auth/reset-signal. Rejects on any failure; the poller ignores it. */
export async function fetchResetDue(): Promise<boolean> {
  const r = await api<{ resetDue?: unknown } | null>('/auth/reset-signal');
  return r?.resetDue === true;
}

/** POST /auth/reset-complete, aborted after `timeoutMs`. */
export async function postResetComplete(timeoutMs: number = RESET_COMPLETE_TIMEOUT_MS): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await api('/auth/reset-complete', { method: 'POST', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface UseCtiResetOptions {
  /** Signed in and /auth/me loaded, so the coordinator exists. */
  enabled: boolean;
  coordinatorRef: MutableRefObject<SoftphoneCoordinator | null>;
  /** isBusyForReset over App's refs, for THIS tab. */
  isBusy: () => boolean;
  teardownDevice: () => void;
}

export function useCtiReset(opts: UseCtiResetOptions): { onPeerReset: () => void } {
  const pollerRef = useRef<ResetPoller | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const { enabled } = opts;

  useEffect(() => {
    if (!enabled) return;
    // The session this page runs on. A reset only ever wipes THIS one.
    const pageToken = storedSessionToken();
    const resetDeps = (): PerformResetDeps => ({
      teardownDevice: () => latest.current.teardownDevice(),
      sessionIsOurs: () => storedSessionToken() === pageToken,
      postResetComplete: () => postResetComplete(),
      broadcastReset: () => latest.current.coordinatorRef.current?.broadcastReset(),
      wipe: () => wipeForReset(pageToken),
      reload: () => pageReloader.reload(),
      warn: (message, err) => console.warn(message, err),
    });
    const poller = createResetPoller({
      fetchResetDue,
      canInitiate: () => {
        const c = latest.current.coordinatorRef.current;
        return !!c && c.isLeader() && c.settled() && !c.peersBusyForReset() && !latest.current.isBusy();
      },
      isSelfBusy: () => latest.current.isBusy(),
      initiate: () => performReset(resetDeps(), true),
      finishForPeer: () => performReset(resetDeps(), false),
      scheduleInterval: (cb, ms) => {
        const id = window.setInterval(cb, ms);
        return () => window.clearInterval(id);
      },
      onVisible: (cb) => {
        const onChange = (): void => { if (document.visibilityState === 'visible') cb(); };
        document.addEventListener('visibilitychange', onChange);
        return () => document.removeEventListener('visibilitychange', onChange);
      },
    });
    pollerRef.current = poller;
    poller.start();
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [enabled]);

  const onPeerReset = useCallback((): void => { pollerRef.current?.peerReset(); }, []);
  return { onPeerReset };
}

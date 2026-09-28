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
import { createResetPoller, RESET_IDLE_CHECK_MS, type ResetPoller } from './reset-poller';
import type { SoftphoneCoordinator } from './softphone-coordinator';

/** The Device is already down when this POST goes out. A hung request must
 *  not leave the rep unable to take calls for long. */
export const RESET_COMPLETE_TIMEOUT_MS = 5_000;
/** A reload normally ends this page at once. Still here this long after
 *  reload()? It did not happen: unlatch and try again (M4). */
export const RESET_RELOAD_GRACE_MS = 10_000;

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
  /** App's resetting latch. true: synchronously, right before the Device goes
   *  down — from then on nothing may build a Device, place a call or join a
   *  run. false: the reset did not finish here (the hook went away first). */
  setResetting: (on: boolean) => void;
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
    // Every timer this effect starts, so its cleanup can cancel them all.
    const cancels = new Set<() => void>();
    const scheduleInterval = (cb: () => void, ms: number): (() => void) => {
      const id = window.setInterval(cb, ms);
      const cancel = (): void => { window.clearInterval(id); cancels.delete(cancel); };
      cancels.add(cancel);
      return cancel;
    };
    const delay = (ms: number): Promise<void> => new Promise<void>((resolve) => {
      const id = window.setTimeout(() => { cancels.delete(cancel); resolve(); }, ms);
      const cancel = (): void => { window.clearTimeout(id); cancels.delete(cancel); };
      cancels.add(cancel);
    });
    // Set while this effect holds App's latch, so a cleanup that runs before
    // the reload (a sign-out mid-reset) never leaves the rep latched.
    let latched = false;
    const unlatch = (): void => {
      if (!latched) return;
      latched = false;
      latest.current.setResetting(false);
    };
    // A reset ends with reload(), which ends this page. Surviving the grace
    // period means it did not happen: reject, so the poller recovers (M4).
    const untilUnload = async (reset: Promise<void>): Promise<void> => {
      await reset;
      await delay(RESET_RELOAD_GRACE_MS);
      throw new Error(`the page did not reload within ${RESET_RELOAD_GRACE_MS} ms`);
    };
    const resetDeps = (): PerformResetDeps => ({
      beginResetting: () => { latched = true; latest.current.setResetting(true); },
      teardownDevice: () => latest.current.teardownDevice(),
      sessionIsOurs: () => storedSessionToken() === pageToken,
      postResetComplete: () => postResetComplete(),
      isBusy: () => latest.current.isBusy(),
      whenIdle: () => new Promise<void>((resolve) => {
        const cancel = scheduleInterval(() => {
          if (latest.current.isBusy()) return;
          cancel();
          resolve();
        }, RESET_IDLE_CHECK_MS);
      }),
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
      // Another tab changed storage under this page (M3).
      sessionIsStale: () => storedSessionToken() !== pageToken,
      initiate: () => untilUnload(performReset(resetDeps(), true)),
      finishForPeer: () => untilUnload(performReset(resetDeps(), false)),
      // Whatever storage holds now is another tab's doing (a reset's wipe, a
      // sign-out, a new sign-in): leave it exactly as it is.
      finishStale: () => untilUnload(performReset({ ...resetDeps(), wipe: () => false }, false)),
      onFailed: (err) => {
        console.warn('[cti-reset] the reset did not finish; the softphone is back and will try again', err);
        unlatch();
      },
      scheduleInterval,
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
      for (const cancel of [...cancels]) cancel();
      unlatch();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [enabled]);

  const onPeerReset = useCallback((): void => { pollerRef.current?.peerReset(); }, []);
  return { onPeerReset };
}

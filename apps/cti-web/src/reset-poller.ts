/**
 * When a reset happens (spec decisions 3-4). Every signed-in softphone tab
 * runs one.
 *  - It polls GET /auth/reset-signal on start, every 20 s, and whenever the
 *    tab becomes visible. A failed poll, a 401 included, is ignored: the
 *    existing bootstrap and token-refresh paths own an expired session, and
 *    a reset is never delivered as a 401 (a refresh 401 tears the Device
 *    down mid-call).
 *  - Once due, it stops polling, because a session never stops being due.
 *    Every 2 s it then checks, locally, whether it may start the reset
 *    (`canInitiate`: leader, settled, this tab and every peer idle). It acts
 *    only on the SECOND yes in a row. Two checks 2 s apart span a 1 s
 *    presence beat, so a peer that just picked up a call has said so.
 *  - A peer's {type:'reset'} makes it finish the reset (no POST) as soon as
 *    THIS tab is idle.
 * Timers and visibility are injected so tests drive them by hand.
 */
export const RESET_POLL_MS = 20_000;
export const RESET_IDLE_CHECK_MS = 2_000;
/** Consecutive yes-checks before a tab starts a reset. */
export const RESET_SETTLE_CHECKS = 2;

export interface ResetPollerDeps {
  fetchResetDue: () => Promise<boolean>;
  /** This tab may start the reset now: softphone leader, coordinator settled,
   *  this tab idle and no peer busy. */
  canInitiate: () => boolean;
  isSelfBusy: () => boolean;
  /** performReset as the tab that starts it. */
  initiate: () => Promise<void>;
  /** performReset as a peer (no POST, no broadcast). */
  finishForPeer: () => Promise<void>;
  scheduleInterval: (cb: () => void, ms: number) => () => void;
  /** Subscribe to the tab becoming visible; returns the unsubscribe. */
  onVisible: (cb: () => void) => () => void;
}

export interface ResetPoller {
  start(): void;
  stop(): void;
  /** A peer tab reset the CTI. */
  peerReset(): void;
}

export function createResetPoller(deps: ResetPollerDeps): ResetPoller {
  let running = false;
  let due = false;
  let peerAsked = false;
  let acting = false;
  let streak = 0;
  let cancelPoll: (() => void) | null = null;
  let cancelVisible: (() => void) | null = null;
  let cancelChecks: (() => void) | null = null;

  const stopPolling = (): void => {
    cancelPoll?.();
    cancelPoll = null;
    cancelVisible?.();
    cancelVisible = null;
  };
  const stopChecks = (): void => {
    cancelChecks?.();
    cancelChecks = null;
  };

  const begin = (run: () => Promise<void>): void => {
    acting = true;
    stopPolling();
    stopChecks();
    void run();
  };

  const check = (): void => {
    if (!running || acting) return;
    if (peerAsked) {
      if (!deps.isSelfBusy()) begin(deps.finishForPeer);
      return;
    }
    if (!due) return;
    streak = deps.canInitiate() ? streak + 1 : 0;
    if (streak >= RESET_SETTLE_CHECKS) begin(deps.initiate);
  };

  const startChecks = (): void => {
    if (!cancelChecks) cancelChecks = deps.scheduleInterval(check, RESET_IDLE_CHECK_MS);
  };

  const poll = async (): Promise<void> => {
    if (!running || due || acting) return;
    let isDue: boolean;
    try {
      isDue = await deps.fetchResetDue();
    } catch {
      return; // 401, offline, 5xx: never a reset and never a sign-out; the next poll retries
    }
    if (!running || due || acting || !isDue) return;
    due = true;
    stopPolling();
    check();
    startChecks();
  };

  return {
    start() {
      if (running) return;
      running = true;
      cancelPoll = deps.scheduleInterval(() => { void poll(); }, RESET_POLL_MS);
      cancelVisible = deps.onVisible(() => { void poll(); });
      void poll();
    },
    stop() {
      running = false;
      stopPolling();
      stopChecks();
    },
    peerReset() {
      if (!running || acting) return;
      peerAsked = true;
      stopPolling();
      check();
      if (!acting) startChecks();
    },
  };
}

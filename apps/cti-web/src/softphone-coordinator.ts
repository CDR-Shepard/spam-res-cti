import { shouldBeLeader, type Peer } from './leader-election';

export const HEARTBEAT_MS = 1000;
export const STALE_MS = 3000;
/** How long a peer's last "resetBusy=true" holds a reset back after the peer
 *  goes quiet. Chrome throttles a tab hidden 5+ minutes to about one timer a
 *  minute, so its heartbeat looks stale and the election prunes it — while its
 *  wrap-up form may still be open. Only `leaving`, a later resetBusy:false from
 *  that peer, or this cap (a tab that crashed while busy) clears it. */
export const RESET_BUSY_MEMORY_MS = 10 * 60_000;

export interface CoordinatorDeps {
  now: () => number;
  postMessage: (m: unknown) => void;
  subscribe: (cb: (m: unknown) => void) => () => void;
  getVisible: () => boolean;
  /** Is this instance holding live telephony (call / ring / dialer run)? A busy
   *  instance wins the election so the phone never moves off an active call. */
  getBusy: () => boolean;
  /** Would a CTI reset interrupt something here (cti-reset.ts isBusyForReset)?
   *  Wider than getBusy — wrap-up, a pending disposition, a parked run — and it
   *  never touches the election. Peers read it to hold a reset back. Defaults
   *  to getBusy. */
  getResetBusy?: () => boolean;
  onVisibilityChange: (cb: () => void) => void;
  /** Schedule a repeating callback every `ms`; returns a canceller. */
  scheduleInterval: (cb: () => void, ms: number) => () => void;
  randomId: () => string;
}

export interface CoordinatorState {
  isLeader: boolean;
  peerCount: number;
}

export interface SoftphoneCoordinator {
  start(): void;
  stop(): void;
  onLeadershipChange(cb: (isLeader: boolean) => void): void;
  onStateChange(cb: (s: CoordinatorState) => void): void;
  /** Mark self a live, preferred candidate now (user acted in this tab). */
  promoteSelf(): void;
  /** Synchronous leadership read (used to decide whether to re-register a dropped Device). */
  isLeader(): boolean;
  /** True while any peer would be interrupted by a reset — or runs a build
   *  from before resets, whose presence carries no `resetBusy` and falls back
   *  to its legacy election `busy` flag instead (R4: never always-busy). A peer
   *  that last said busy still counts after it goes stale, for up to
   *  RESET_BUSY_MEMORY_MS (a hidden, throttled tab in wrap-up). */
  peersBusyForReset(): boolean;
  /** True once this instance has listened for a full STALE_MS since start():
   *  every live peer (1 s heartbeat) has announced itself by then. */
  settled(): boolean;
  /** Tell every peer tab to finish a CTI reset. */
  broadcastReset(): void;
  /** A peer tab reset the CTI. */
  onReset(cb: () => void): void;
}

type Msg =
  | { type: 'presence'; id: string; visible: boolean; busy: boolean; resetBusy?: boolean }
  | { type: 'leaving'; id: string }
  | { type: 'reset'; id: string };

interface PeerState { visible: boolean; busy: boolean; lastSeen: number }

export function createSoftphoneCoordinator(deps: CoordinatorDeps): SoftphoneCoordinator {
  const selfId = deps.randomId();
  const getResetBusy = deps.getResetBusy ?? deps.getBusy;
  const peers = new Map<string, PeerState>();
  // Kept apart from `peers`, which the election prunes on staleness: when each
  // peer last said a reset would interrupt it (RESET_BUSY_MEMORY_MS).
  const lastResetBusyAt = new Map<string, number>();
  let isLeader = false;
  let started = false;
  let stopped = false;
  let startedAt = 0;
  let cancelInterval: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let leadershipCb: ((v: boolean) => void) | null = null;
  let stateCb: ((s: CoordinatorState) => void) | null = null;
  let resetCb: (() => void) | null = null;

  const peerList = (): Peer[] => [...peers].map(([id, p]) => ({ id, visible: p.visible, busy: p.busy, lastSeen: p.lastSeen }));

  const recompute = (): void => {
    const now = deps.now();
    // prune stale peers so peerCount and election stay honest
    for (const [id, p] of peers) if (p.lastSeen <= now - STALE_MS) peers.delete(id);
    for (const [id, at] of lastResetBusyAt) if (at <= now - RESET_BUSY_MEMORY_MS) lastResetBusyAt.delete(id);
    const nextLeader = shouldBeLeader({ selfId, selfVisible: deps.getVisible(), selfBusy: deps.getBusy(), peers: peerList(), now, staleMs: STALE_MS });
    if (nextLeader !== isLeader) {
      isLeader = nextLeader;
      leadershipCb?.(isLeader);
    }
    stateCb?.({ isLeader, peerCount: peers.size });
  };

  const onMessage = (raw: unknown): void => {
    if (stopped) return;
    const m = raw as Msg;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'presence' && m.id !== selfId) {
      const busy = !!m.busy;
      const now = deps.now();
      peers.set(m.id, { visible: m.visible, busy, lastSeen: now });
      // R4 (controller ruling): a build from before resets doesn't report
      // resetBusy — fall back to its legacy election busy flag. It must
      // never count as always-busy just because it's silent on the field.
      const resetBusy = typeof m.resetBusy === 'boolean' ? m.resetBusy : busy;
      if (resetBusy) lastResetBusyAt.set(m.id, now);
      else lastResetBusyAt.delete(m.id);
      recompute();
    } else if (m.type === 'leaving' && m.id !== selfId) {
      peers.delete(m.id);
      lastResetBusyAt.delete(m.id);
      recompute();
    } else if (m.type === 'reset' && m.id !== selfId) {
      resetCb?.();
    }
  };

  const beat = (): void => {
    if (stopped) return;
    deps.postMessage({ type: 'presence', id: selfId, visible: deps.getVisible(), busy: deps.getBusy(), resetBusy: getResetBusy() } satisfies Msg);
    recompute();
  };

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
      startedAt = deps.now();
      unsubscribe = deps.subscribe(onMessage);
      deps.onVisibilityChange(beat);
      cancelInterval = deps.scheduleInterval(beat, HEARTBEAT_MS);
      beat();
    },
    stop() {
      if (!started) return;
      started = false;
      stopped = true;
      deps.postMessage({ type: 'leaving', id: selfId } satisfies Msg);
      unsubscribe?.();
      unsubscribe = null;
      cancelInterval?.();
      cancelInterval = null;
    },
    onLeadershipChange(cb) { leadershipCb = cb; },
    onStateChange(cb) { stateCb = cb; },
    promoteSelf() { beat(); },
    isLeader() { return isLeader; },
    peersBusyForReset() {
      // Not `peers`: a busy peer that went stale (hidden and throttled) still
      // counts until it leaves, says it's free, or the cap passes.
      const cutoff = deps.now() - RESET_BUSY_MEMORY_MS;
      for (const at of lastResetBusyAt.values()) if (at > cutoff) return true;
      return false;
    },
    settled() { return started && deps.now() - startedAt >= STALE_MS; },
    broadcastReset() {
      if (!started) return;
      deps.postMessage({ type: 'reset', id: selfId } satisfies Msg);
    },
    onReset(cb) { resetCb = cb; },
  };
}

/**
 * Real-browser dependencies. Thin + untested: if `BroadcastChannel` is missing
 * (very old browser) every hook is a no-op, so the coordinator sees no peers and
 * stays leader — i.e. today's behavior, no regression.
 */
export function browserCoordinatorDeps(userId: string, getBusy: () => boolean, getResetBusy?: () => boolean): CoordinatorDeps {
  const supported = typeof BroadcastChannel !== 'undefined';
  const channel = supported ? new BroadcastChannel(`cti-softphone-${userId}`) : null;
  return {
    now: () => Date.now(),
    postMessage: (m) => channel?.postMessage(m),
    subscribe: (cb) => {
      if (!channel) return () => {};
      channel.onmessage = (e: MessageEvent) => cb(e.data);
      return () => { channel.onmessage = null; channel.close(); };
    },
    getVisible: () => (typeof document === 'undefined' ? true : document.visibilityState === 'visible'),
    getBusy,
    ...(getResetBusy ? { getResetBusy } : {}),
    onVisibilityChange: (cb) => { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb); },
    scheduleInterval: (cb, ms) => { const id = window.setInterval(cb, ms); return () => window.clearInterval(id); },
    randomId: () => `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  };
}

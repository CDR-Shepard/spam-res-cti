import { shouldBeLeader, type Peer } from './leader-election';

export const HEARTBEAT_MS = 1000;
export const STALE_MS = 3000;

export interface CoordinatorDeps {
  now: () => number;
  postMessage: (m: unknown) => void;
  subscribe: (cb: (m: unknown) => void) => () => void;
  getVisible: () => boolean;
  /** Is this instance holding live telephony (call / ring / dialer run)? A busy
   *  instance wins the election so the phone never moves off an active call. */
  getBusy: () => boolean;
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
}

type Msg = { type: 'presence'; id: string; visible: boolean; busy: boolean } | { type: 'leaving'; id: string };

export function createSoftphoneCoordinator(deps: CoordinatorDeps): SoftphoneCoordinator {
  const selfId = deps.randomId();
  const peers = new Map<string, { visible: boolean; busy: boolean; lastSeen: number }>();
  let isLeader = false;
  let started = false;
  let stopped = false;
  let cancelInterval: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let leadershipCb: ((v: boolean) => void) | null = null;
  let stateCb: ((s: CoordinatorState) => void) | null = null;

  const peerList = (): Peer[] => [...peers].map(([id, p]) => ({ id, visible: p.visible, busy: p.busy, lastSeen: p.lastSeen }));

  const recompute = (): void => {
    const now = deps.now();
    // prune stale peers so peerCount and election stay honest
    for (const [id, p] of peers) if (p.lastSeen <= now - STALE_MS) peers.delete(id);
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
      peers.set(m.id, { visible: m.visible, busy: !!m.busy, lastSeen: deps.now() });
      recompute();
    } else if (m.type === 'leaving' && m.id !== selfId) {
      peers.delete(m.id);
      recompute();
    }
  };

  const beat = (): void => {
    if (stopped) return;
    deps.postMessage({ type: 'presence', id: selfId, visible: deps.getVisible(), busy: deps.getBusy() } satisfies Msg);
    recompute();
  };

  return {
    start() {
      if (started) return;
      started = true;
      stopped = false;
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
  };
}

/**
 * Real-browser dependencies. Thin + untested: if `BroadcastChannel` is missing
 * (very old browser) every hook is a no-op, so the coordinator sees no peers and
 * stays leader — i.e. today's behavior, no regression.
 */
export function browserCoordinatorDeps(userId: string, getBusy: () => boolean): CoordinatorDeps {
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
    onVisibilityChange: (cb) => { if (typeof document !== 'undefined') document.addEventListener('visibilitychange', cb); },
    scheduleInterval: (cb, ms) => { const id = window.setInterval(cb, ms); return () => window.clearInterval(id); },
    randomId: () => `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  };
}

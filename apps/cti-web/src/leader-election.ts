/**
 * Deterministic, coordinator-free leader election across a rep's softphone
 * instances. Every instance runs this same pure function over ~the same alive
 * set (self + non-stale peers) and converges on one leader, so exactly one tab
 * holds the Twilio registration and Twilio has a single place to ring.
 *
 * Winner: a VISIBLE instance always beats a hidden one (so the ring lands where
 * the rep is looking); among equally-visible instances the lexicographically
 * smallest id wins (a stable tie-break). All instances see the same set
 * (same-origin BroadcastChannel), so there is no split-brain once presence has
 * propagated.
 */
export interface Peer {
  id: string;
  visible: boolean;
  lastSeen: number;
}

export interface ElectionInput {
  selfId: string;
  selfVisible: boolean;
  peers: readonly Peer[];
  now: number;
  /** A peer last seen before `now - staleMs` is treated as gone. */
  staleMs: number;
}

export function electLeader(input: ElectionInput): string {
  const alive: Array<{ id: string; visible: boolean }> = [{ id: input.selfId, visible: input.selfVisible }];
  for (const p of input.peers) {
    if (p.lastSeen > input.now - input.staleMs) alive.push({ id: p.id, visible: p.visible });
  }
  alive.sort((a, b) => {
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return alive[0]!.id;
}

export function shouldBeLeader(input: ElectionInput): boolean {
  return electLeader(input) === input.selfId;
}

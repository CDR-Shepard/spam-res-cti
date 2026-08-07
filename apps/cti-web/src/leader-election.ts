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
  /** This instance is holding live telephony (a call, a ring, or a dialer run). */
  busy: boolean;
}

export interface ElectionInput {
  selfId: string;
  selfVisible: boolean;
  selfBusy: boolean;
  peers: readonly Peer[];
  now: number;
  /** A peer last seen before `now - staleMs` is treated as gone. */
  staleMs: number;
}

/**
 * Priority: BUSY, then VISIBLE, then smallest id.
 *
 * Busy outranks visible because reps read the record while they talk — switching
 * Salesforce tabs mid-call must NOT move the phone. If it did, the new tab would
 * register a second Device on the same identity and the live call would stall
 * (reps described it as "it puts my call on hold"). A busy tab keeps the phone
 * until its call ends; staleness still applies, so a crashed tab can't pin it.
 */
export function electLeader(input: ElectionInput): string {
  const alive: Array<{ id: string; visible: boolean; busy: boolean }> = [
    { id: input.selfId, visible: input.selfVisible, busy: input.selfBusy },
  ];
  for (const p of input.peers) {
    if (p.lastSeen > input.now - input.staleMs) alive.push({ id: p.id, visible: p.visible, busy: p.busy });
  }
  alive.sort((a, b) => {
    if (a.busy !== b.busy) return a.busy ? -1 : 1;
    if (a.visible !== b.visible) return a.visible ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return alive[0]!.id;
}

export function shouldBeLeader(input: ElectionInput): boolean {
  return electLeader(input) === input.selfId;
}

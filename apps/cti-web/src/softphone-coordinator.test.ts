import { describe, expect, it } from 'vitest';
import { createSoftphoneCoordinator, RESET_BUSY_MEMORY_MS, STALE_MS, type CoordinatorDeps } from './softphone-coordinator';

// A shared in-memory bus so two coordinators can "see" each other, plus a
// controllable clock and a manual interval pump — no DOM needed.
function harness() {
  const subscribers: Array<(m: unknown) => void> = [];
  const intervals: Array<() => void> = [];
  let now = 1000;
  const bus = { post: (m: unknown) => subscribers.forEach((s) => s(m)) };
  const tick = (ms: number) => { now += ms; intervals.forEach((fn) => fn()); };
  const makeDeps = (id: string, visible: boolean, busy = false, resetBusy?: () => boolean): CoordinatorDeps => ({
    now: () => now,
    postMessage: (m) => bus.post(m),
    subscribe: (cb) => { subscribers.push(cb); return () => { const i = subscribers.indexOf(cb); if (i >= 0) subscribers.splice(i, 1); }; },
    getVisible: () => visible,
    getBusy: () => busy,
    ...(resetBusy ? { getResetBusy: resetBusy } : {}),
    onVisibilityChange: () => {},
    scheduleInterval: (cb) => { intervals.push(cb); return () => { const i = intervals.indexOf(cb); if (i >= 0) intervals.splice(i, 1); }; },
    randomId: () => id,
  });
  /** Put a raw message on the bus, as another (maybe older) build would. */
  const post = (m: unknown) => bus.post(m);
  /** Hear every message on the bus. */
  const listen = (cb: (m: unknown) => void) => { subscribers.push(cb); };
  return { tick, makeDeps, post, listen };
}

describe('createSoftphoneCoordinator', () => {
  it('a single instance becomes leader on start', () => {
    const h = harness();
    const c = createSoftphoneCoordinator(h.makeDeps('a', true));
    let leader = false;
    c.onLeadershipChange((v) => { leader = v; });
    c.start();
    h.tick(1000);
    expect(leader).toBe(true);
    expect(c.isLeader()).toBe(true);
  });

  it('two instances converge on exactly one leader (visible beats hidden)', () => {
    const h = harness();
    const visible = createSoftphoneCoordinator(h.makeDeps('z', true));   // hidden-id-larger but visible
    const hidden = createSoftphoneCoordinator(h.makeDeps('a', false));   // smaller id but hidden
    let vLead = false, hLead = true;
    visible.onLeadershipChange((v) => { vLead = v; });
    hidden.onLeadershipChange((v) => { hLead = v; });
    visible.start(); hidden.start();
    h.tick(1000); // exchange presence
    h.tick(1000); // recompute with peers known
    expect(vLead).toBe(true);
    expect(hLead).toBe(false);
  });

  it('when the leader leaves, the other re-elects immediately (no stale wait)', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    let bLead = false;
    b.onLeadershipChange((v) => { bLead = v; });
    a.start(); b.start();
    h.tick(1000); h.tick(1000);   // 'a' wins (smaller id, both visible)
    expect(bLead).toBe(false);
    a.stop();                     // broadcasts 'leaving'
    h.tick(0);                    // b recomputes on the leaving message (no time passes)
    expect(bLead).toBe(true);
  });

  it('a tab on a call keeps leadership when the rep focuses another tab', () => {
    // The exact rep complaint: "if I switch tabs while on a call it puts it on
    // hold". The busy tab must NOT hand the phone to the newly-visible tab.
    const h = harness();
    const onCall = createSoftphoneCoordinator(h.makeDeps('a-oncall', false, true)); // hidden but BUSY
    const browsing = createSoftphoneCoordinator(h.makeDeps('b-browsing', true, false)); // visible, idle
    let callLead = false, browseLead = false;
    onCall.onLeadershipChange((v) => { callLead = v; });
    browsing.onLeadershipChange((v) => { browseLead = v; });
    onCall.start(); browsing.start();
    h.tick(1000); h.tick(1000);
    expect(callLead).toBe(true);
    expect(browseLead).toBe(false);
  });

  it('reports peerCount via onStateChange', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    let state = { isLeader: false, peerCount: -1 };
    a.onStateChange((s) => { state = s; });
    a.start(); b.start();
    h.tick(1000); h.tick(1000);
    expect(state.peerCount).toBe(1);
  });

  it("after stop(), a peer's later presence/leaving does not flip the stopped instance's leadership or fire its callbacks", () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    let leadershipCalls = 0;
    let stateCalls = 0;
    a.onLeadershipChange(() => { leadershipCalls += 1; });
    a.onStateChange(() => { stateCalls += 1; });
    a.start(); b.start();
    h.tick(1000); h.tick(1000); // 'a' wins (smaller id, both visible)
    expect(a.isLeader()).toBe(true);

    const leadershipCallsAtStop = leadershipCalls;
    const stateCallsAtStop = stateCalls;
    const leaderAtStop = a.isLeader();

    a.stop(); // a is torn down; caller believes it is fully inert

    // 'the other' tab keeps broadcasting/leaving after a has stopped.
    b.promoteSelf(); // presence broadcast
    h.tick(1000);    // b's own heartbeat fires too
    b.stop();        // leaving broadcast

    expect(a.isLeader()).toBe(leaderAtStop);
    expect(leadershipCalls).toBe(leadershipCallsAtStop);
    // recompute() must never run on a stopped instance, even if the value doesn't change.
    expect(stateCalls).toBe(stateCallsAtStop);
  });
});

describe('createSoftphoneCoordinator — Reset CTI support', () => {
  it('presence carries resetBusy beside (not instead of) the election busy flag', () => {
    const h = harness();
    const seen: unknown[] = [];
    h.listen((m) => seen.push(m));
    createSoftphoneCoordinator(h.makeDeps('a', true, false, () => true)).start();
    expect(seen).toContainEqual({ type: 'presence', id: 'a', visible: true, busy: false, resetBusy: true });
  });

  it('without getResetBusy a tab reports its election busy flag — never less cautious', () => {
    const h = harness();
    const seen: unknown[] = [];
    h.listen((m) => seen.push(m));
    createSoftphoneCoordinator(h.makeDeps('a', true, true)).start();
    expect(seen).toContainEqual({ type: 'presence', id: 'a', visible: true, busy: true, resetBusy: true });
  });

  it('alone, no peer is busy', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    a.start();
    h.tick(1000);
    expect(a.peersBusyForReset()).toBe(false);
  });

  it('peersBusyForReset follows a peer in wrap-up — and wrap-up never moves the phone', () => {
    const h = harness();
    let wrapUp = true;
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true, false, () => wrapUp));
    a.start(); b.start();
    h.tick(1000); h.tick(1000);
    // Smaller id, both visible: wrap-up is not "busy" for the election. Assert
    // BOTH sides — the wrap-up tab must not elect ITSELF on its reset flag
    // either (that would register a second Device beside a's).
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(a.peersBusyForReset()).toBe(true);
    wrapUp = false;
    h.tick(1000);
    expect(a.peersBusyForReset()).toBe(false);
  });

  // R1/R4 (controller ruling, overrides the brief): a peer from a build before
  // resets carries no `resetBusy` in its presence. It falls back to its legacy
  // `busy` flag — it must never count as always-busy regardless of that flag.
  it('a legacy peer (no resetBusy in its presence) with busy=false lets the reset proceed', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    a.start();
    h.post({ type: 'presence', id: 'old-tab', visible: false, busy: false });
    expect(a.peersBusyForReset()).toBe(false);
  });

  it('a legacy peer (no resetBusy in its presence) with busy=true defers the reset', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    a.start();
    h.post({ type: 'presence', id: 'old-tab', visible: false, busy: true });
    expect(a.peersBusyForReset()).toBe(true);
  });

  it('a peer that went silent (closed or crashed) while idle stops counting after STALE_MS', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    a.start();
    h.post({ type: 'presence', id: 'ghost', visible: false, busy: false, resetBusy: false });
    expect(a.peersBusyForReset()).toBe(false);
    h.tick(STALE_MS);
    expect(a.peersBusyForReset()).toBe(false);
  });
});

// Follow-up 1 (final review): Chrome throttles a tab hidden 5+ minutes to about
// one timer a minute, so its 1 s heartbeat goes stale and it is pruned — yet
// its wrap-up form is still open. What it last said about a reset outlives the
// staleness: only `leaving`, a later resetBusy:false, or the cap clears it.
describe('createSoftphoneCoordinator — a busy peer is remembered past staleness', () => {
  /** Tab a (leader) hears a hidden peer say resetBusy=true, then nothing more. */
  function hiddenBusyPeer() {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    let peers = -1;
    a.onStateChange((s) => { peers = s.peerCount; });
    a.start();
    h.post({ type: 'presence', id: 'hidden-wrapup', visible: false, busy: false, resetBusy: true });
    return { h, a, peerCount: () => peers };
  }

  it('a peer that said busy and then went stale still blocks — and stays out of the election', () => {
    const { h, a, peerCount } = hiddenBusyPeer();
    h.tick(STALE_MS + 5_000);
    expect(peerCount()).toBe(0); // pruned: the election forgot it…
    expect(a.isLeader()).toBe(true);
    expect(a.peersBusyForReset()).toBe(true); // …the reset did not
    h.tick(RESET_BUSY_MEMORY_MS - STALE_MS - 5_000 - 1);
    expect(a.peersBusyForReset()).toBe(true);
  });

  it('a throttled peer that keeps saying busy (once a minute) keeps blocking past the cap', () => {
    const { h, a } = hiddenBusyPeer();
    for (let m = 0; m < 15; m++) {
      h.tick(60_000);
      h.post({ type: 'presence', id: 'hidden-wrapup', visible: false, busy: false, resetBusy: true });
    }
    h.tick(59_000);
    expect(a.peersBusyForReset()).toBe(true);
  });

  it('a stale busy peer that sends `leaving` no longer blocks', () => {
    const { h, a } = hiddenBusyPeer();
    h.tick(STALE_MS + 5_000);
    h.post({ type: 'leaving', id: 'hidden-wrapup' });
    expect(a.peersBusyForReset()).toBe(false);
  });

  it('a stale busy peer that later says resetBusy:false no longer blocks — even once it goes stale again', () => {
    const { h, a } = hiddenBusyPeer();
    h.tick(STALE_MS + 5_000);
    h.post({ type: 'presence', id: 'hidden-wrapup', visible: false, busy: false, resetBusy: false });
    expect(a.peersBusyForReset()).toBe(false);
    h.tick(STALE_MS + 5_000);
    expect(a.peersBusyForReset()).toBe(false);
  });

  it('past the cap, a busy peer that never spoke again (crashed) no longer blocks', () => {
    const { h, a } = hiddenBusyPeer();
    h.tick(RESET_BUSY_MEMORY_MS);
    expect(a.peersBusyForReset()).toBe(false);
  });

  it("one peer's leaving never clears another's busy memory", () => {
    const { h, a } = hiddenBusyPeer();
    h.post({ type: 'presence', id: 'other', visible: false, busy: false, resetBusy: false });
    h.tick(STALE_MS + 5_000);
    h.post({ type: 'leaving', id: 'other' });
    expect(a.peersBusyForReset()).toBe(true);
  });

  it('a legacy peer (no resetBusy) whose busy=true went stale is remembered the same way (R4 fallback)', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    a.start();
    h.post({ type: 'presence', id: 'old-tab', visible: false, busy: true });
    h.tick(STALE_MS + 5_000);
    expect(a.peersBusyForReset()).toBe(true);
    h.post({ type: 'presence', id: 'old-tab', visible: false, busy: false });
    expect(a.peersBusyForReset()).toBe(false);
  });

  it('settled() only once it has listened for a full STALE_MS, and not after stop()', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    expect(a.settled()).toBe(false);
    a.start();
    expect(a.settled()).toBe(false);
    h.tick(STALE_MS - 1);
    expect(a.settled()).toBe(false);
    h.tick(1);
    expect(a.settled()).toBe(true);
    a.stop();
    expect(a.settled()).toBe(false);
  });

  it("broadcastReset reaches every peer's onReset — never the sender's own", () => {
    const h = harness();
    const got: string[] = [];
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    const c = createSoftphoneCoordinator(h.makeDeps('c', false));
    a.onReset(() => got.push('a'));
    b.onReset(() => got.push('b'));
    c.onReset(() => got.push('c'));
    a.start(); b.start(); c.start();
    a.broadcastReset();
    expect(got.sort()).toEqual(['b', 'c']);
  });

  it('a stopped coordinator neither hears nor sends a reset', () => {
    const h = harness();
    const a = createSoftphoneCoordinator(h.makeDeps('a', true));
    const b = createSoftphoneCoordinator(h.makeDeps('b', true));
    let heard = 0;
    b.onReset(() => { heard += 1; });
    a.start(); b.start();
    b.stop();
    a.broadcastReset();
    expect(heard).toBe(0);
    a.stop();
    const seen: unknown[] = [];
    h.listen((m) => seen.push(m));
    a.broadcastReset();
    expect(seen).toEqual([]);
  });
});

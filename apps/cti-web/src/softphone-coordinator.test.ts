import { describe, expect, it } from 'vitest';
import { createSoftphoneCoordinator, type CoordinatorDeps } from './softphone-coordinator';

// A shared in-memory bus so two coordinators can "see" each other, plus a
// controllable clock and a manual interval pump — no DOM needed.
function harness() {
  const subscribers: Array<(m: unknown) => void> = [];
  const intervals: Array<() => void> = [];
  let now = 1000;
  const bus = { post: (m: unknown) => subscribers.forEach((s) => s(m)) };
  const tick = (ms: number) => { now += ms; intervals.forEach((fn) => fn()); };
  const makeDeps = (id: string, visible: boolean): CoordinatorDeps => ({
    now: () => now,
    postMessage: (m) => bus.post(m),
    subscribe: (cb) => { subscribers.push(cb); return () => { const i = subscribers.indexOf(cb); if (i >= 0) subscribers.splice(i, 1); }; },
    getVisible: () => visible,
    onVisibilityChange: () => {},
    scheduleInterval: (cb) => { intervals.push(cb); return () => { const i = intervals.indexOf(cb); if (i >= 0) intervals.splice(i, 1); }; },
    randomId: () => id,
  });
  return { tick, makeDeps };
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

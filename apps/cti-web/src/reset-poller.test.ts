import { describe, expect, it, vi } from 'vitest';
import { createResetPoller, RESET_IDLE_CHECK_MS, RESET_POLL_MS, type ResetPollerDeps } from './reset-poller';

/** Hand-driven timers, visibility and answers — no DOM, no real time. */
function harness(over: Partial<ResetPollerDeps> = {}) {
  const timers: Array<{ cb: () => void; ms: number }> = [];
  let visibleCb: (() => void) | null = null;
  const s = { due: false as boolean | Error, canInitiate: true, selfBusy: false, stale: false };
  const deps: ResetPollerDeps = {
    fetchResetDue: vi.fn(async () => { if (s.due instanceof Error) throw s.due; return s.due; }),
    canInitiate: vi.fn(() => s.canInitiate),
    isSelfBusy: vi.fn(() => s.selfBusy),
    sessionIsStale: vi.fn(() => s.stale),
    initiate: vi.fn(async () => {}),
    finishForPeer: vi.fn(async () => {}),
    finishStale: vi.fn(async () => {}),
    onFailed: vi.fn(),
    scheduleInterval: (cb, ms) => {
      const t = { cb, ms };
      timers.push(t);
      return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
    },
    onVisible: (cb) => { visibleCb = cb; return () => { visibleCb = null; }; },
    ...over,
  };
  const fire = (ms: number): void => { for (const t of [...timers]) if (t.ms === ms) t.cb(); };
  const settle = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    deps, s, timers, fire, settle,
    becomeVisible: (): void => { visibleCb?.(); },
    hasVisibleListener: (): boolean => visibleCb !== null,
  };
}

describe('createResetPoller — polling', () => {
  it('polls once on start, every 20 s, and when the tab becomes visible', async () => {
    const h = harness();
    createResetPoller(h.deps).start();
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(1);
    h.fire(RESET_POLL_MS);
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(2);
    h.becomeVisible();
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(3);
  });

  it('not due: never checks idle and never acts — only the 20 s poll runs', async () => {
    const h = harness();
    createResetPoller(h.deps).start();
    await h.settle();
    h.fire(RESET_POLL_MS);
    await h.settle();
    expect(h.timers.map((t) => t.ms)).toEqual([RESET_POLL_MS]);
    expect(h.deps.canInitiate).not.toHaveBeenCalled();
    expect(h.deps.initiate).not.toHaveBeenCalled();
    expect(h.deps.finishForPeer).not.toHaveBeenCalled();
  });

  it('a failed poll (a 401, offline) is ignored — never a reset — and the next poll tries again', async () => {
    const h = harness();
    h.s.due = Object.assign(new Error('API 401'), { status: 401 });
    createResetPoller(h.deps).start();
    await h.settle();
    expect(h.deps.initiate).not.toHaveBeenCalled();
    expect(h.timers.map((t) => t.ms)).toEqual([RESET_POLL_MS]);
    h.s.due = false;
    h.fire(RESET_POLL_MS);
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(2);
  });
});

describe('createResetPoller — starting a reset', () => {
  it('due and free: starts on the SECOND yes-check in a row, exactly once, and stops polling', async () => {
    const h = harness();
    h.s.due = true;
    createResetPoller(h.deps).start();
    await h.settle();
    expect(h.deps.initiate).not.toHaveBeenCalled(); // one yes so far
    expect(h.timers.map((t) => t.ms)).toEqual([RESET_IDLE_CHECK_MS]); // the 20 s poll is gone
    expect(h.hasVisibleListener()).toBe(false);
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.initiate).toHaveBeenCalledTimes(1);
    expect(h.timers).toEqual([]);
    h.fire(RESET_IDLE_CHECK_MS);
    h.fire(RESET_POLL_MS);
    await h.settle();
    expect(h.deps.initiate).toHaveBeenCalledTimes(1);
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(1);
  });

  it('due but busy (this tab, a peer, not leader, not settled): waits, and one "no" restarts the count', async () => {
    const h = harness();
    h.s.due = true;
    h.s.canInitiate = false;
    createResetPoller(h.deps).start();
    await h.settle();
    h.fire(RESET_IDLE_CHECK_MS);
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.initiate).not.toHaveBeenCalled();
    h.s.canInitiate = true;
    h.fire(RESET_IDLE_CHECK_MS); // yes (1)
    h.s.canInitiate = false;
    h.fire(RESET_IDLE_CHECK_MS); // no — back to 0
    h.s.canInitiate = true;
    h.fire(RESET_IDLE_CHECK_MS); // yes (1)
    expect(h.deps.initiate).not.toHaveBeenCalled();
    h.fire(RESET_IDLE_CHECK_MS); // yes (2)
    expect(h.deps.initiate).toHaveBeenCalledTimes(1);
    expect(h.deps.finishForPeer).not.toHaveBeenCalled();
  });
});

describe("createResetPoller — a peer's reset", () => {
  it('finishes at once when this tab is idle, without the POST path', async () => {
    const h = harness();
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    p.peerReset();
    expect(h.deps.finishForPeer).toHaveBeenCalledTimes(1);
    expect(h.deps.initiate).not.toHaveBeenCalled();
    expect(h.timers).toEqual([]);
  });

  it('while this tab is on a call: waits until it is idle', async () => {
    const h = harness();
    h.s.selfBusy = true;
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    p.peerReset();
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.finishForPeer).not.toHaveBeenCalled();
    h.s.selfBusy = false;
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.finishForPeer).toHaveBeenCalledTimes(1);
  });

  it('is ignored once this tab has started its own reset', async () => {
    const h = harness();
    h.s.due = true;
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    h.fire(RESET_IDLE_CHECK_MS);
    p.peerReset();
    expect(h.deps.initiate).toHaveBeenCalledTimes(1);
    expect(h.deps.finishForPeer).not.toHaveBeenCalled();
  });
});

describe('createResetPoller — stop()', () => {
  it('cancels every timer and ignores a poll answer that arrives late', async () => {
    let answer: (v: boolean) => void = () => {};
    const h = harness({ fetchResetDue: vi.fn(() => new Promise<boolean>((r) => { answer = r; })) });
    const p = createResetPoller(h.deps);
    p.start();
    p.stop();
    expect(h.timers).toEqual([]);
    expect(h.hasVisibleListener()).toBe(false);
    answer(true);
    await h.settle();
    expect(h.timers).toEqual([]);
    expect(h.deps.canInitiate).not.toHaveBeenCalled();
    expect(h.deps.initiate).not.toHaveBeenCalled();
    p.peerReset();
    expect(h.deps.finishForPeer).not.toHaveBeenCalled();
  });
});

// M3: storage no longer holds this page's session — another tab reset (or
// signed out, or signed in again) and this tab missed the broadcast.
describe('createResetPoller — a session that went stale under this tab', () => {
  it('a poll that finds it stale finishes without asking the server — as a stale finish, never a peer wipe', async () => {
    const h = harness();
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(1);
    h.s.stale = true;
    h.fire(RESET_POLL_MS);
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(1);
    expect(h.deps.finishStale).toHaveBeenCalledTimes(1);
    expect(h.deps.finishForPeer).not.toHaveBeenCalled();
    expect(h.deps.initiate).not.toHaveBeenCalled();
    expect(h.timers).toEqual([]);
  });

  it('while this tab is on a call: waits until it is idle', async () => {
    const h = harness();
    h.s.stale = true;
    h.s.selfBusy = true;
    createResetPoller(h.deps).start();
    await h.settle();
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.finishStale).not.toHaveBeenCalled();
    h.s.selfBusy = false;
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.finishStale).toHaveBeenCalledTimes(1);
  });

  it("a peer's broadcast while it waits outranks the stale guess: it finishes as the peer", async () => {
    const h = harness();
    h.s.stale = true;
    h.s.selfBusy = true;
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    p.peerReset();
    h.s.selfBusy = false;
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.finishForPeer).toHaveBeenCalledTimes(1);
    expect(h.deps.finishStale).not.toHaveBeenCalled();
  });
});

// M4: performReset rejected, or the page never reloaded. The rep must not be
// left with a latched, Device-less tab: say so in the log, and try again.
describe('createResetPoller — a reset that did not finish', () => {
  it('reports it once and re-arms: the 20 s poll and the visible poll come back, and a later poll can reset again', async () => {
    const h = harness();
    const boom = new Error('reload blocked');
    vi.mocked(h.deps.initiate).mockRejectedValueOnce(boom);
    h.s.due = true;
    createResetPoller(h.deps).start();
    await h.settle();
    h.fire(RESET_IDLE_CHECK_MS); // second yes: initiate — which rejects
    await h.settle();
    expect(h.deps.initiate).toHaveBeenCalledTimes(1);
    expect(h.deps.onFailed).toHaveBeenCalledTimes(1);
    expect(h.deps.onFailed).toHaveBeenCalledWith(boom);
    expect(h.timers.map((t) => t.ms)).toEqual([RESET_POLL_MS]);
    expect(h.hasVisibleListener()).toBe(true);

    h.fire(RESET_POLL_MS); // still due: two yes-checks again, then a second attempt
    await h.settle();
    expect(h.deps.fetchResetDue).toHaveBeenCalledTimes(2);
    h.fire(RESET_IDLE_CHECK_MS);
    expect(h.deps.initiate).toHaveBeenCalledTimes(2);
  });

  it('a peer finish that rejects re-arms too', async () => {
    const h = harness();
    vi.mocked(h.deps.finishForPeer).mockRejectedValueOnce(new Error('reload blocked'));
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    p.peerReset();
    await h.settle();
    expect(h.deps.onFailed).toHaveBeenCalledTimes(1);
    expect(h.timers.map((t) => t.ms)).toEqual([RESET_POLL_MS]);
    p.peerReset();
    expect(h.deps.finishForPeer).toHaveBeenCalledTimes(2);
  });

  it('stopped meanwhile: no report and no re-arm', async () => {
    const h = harness();
    let fail: (e: Error) => void = () => {};
    vi.mocked(h.deps.initiate).mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    h.s.due = true;
    const p = createResetPoller(h.deps);
    p.start();
    await h.settle();
    h.fire(RESET_IDLE_CHECK_MS);
    p.stop();
    fail(new Error('late'));
    await h.settle();
    expect(h.deps.onFailed).not.toHaveBeenCalled();
    expect(h.timers).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEARTBEAT_FAILURES_BEFORE_WARNING, PARKED_HEARTBEAT_MS, startParkedHeartbeat, type ParkedHeartbeatDeps } from './parked-heartbeat';
import type { DialerSession } from './dialer-api';

type Status = DialerSession['status'];
const ok = (status: Status) => async () => ({ session: { status } });

function deps(poll: ParkedHeartbeatDeps['poll']) {
  return { poll: vi.fn(poll), onRunOver: vi.fn(), onUnreachable: vi.fn() };
}

describe('startParkedHeartbeat — keeps a run parked for a callback from being reaped', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("polls the parked run once a minute — well inside the reaper's ten", async () => {
    expect(PARKED_HEARTBEAT_MS).toBe(60_000);
    const d = deps(ok('paused'));
    const stop = startParkedHeartbeat('sess-1', d);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS - 1);
    expect(d.poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(d.poll).toHaveBeenCalledWith('sess-1');
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS);
    expect(d.poll).toHaveBeenCalledTimes(2);
    stop();
  });

  it('stops — and hands the run back to be released — the first time the run reads as over', async () => {
    for (const status of ['done', 'stopped'] as const) {
      const d = deps(ok(status));
      startParkedHeartbeat('sess-1', d);
      await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 3);
      expect(d.poll).toHaveBeenCalledTimes(1);
      expect(d.onRunOver).toHaveBeenCalledTimes(1);
    }
  });

  it('stop() ends it', async () => {
    const d = deps(ok('paused'));
    startParkedHeartbeat('sess-1', d)();
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 2);
    expect(d.poll).not.toHaveBeenCalled();
  });

  it('tells the rep ONCE after five straight failures (half the reaper window); a success resets the count', async () => {
    expect(HEARTBEAT_FAILURES_BEFORE_WARNING).toBe(5);
    const d = deps(async () => { throw new Error('offline'); });
    startParkedHeartbeat('sess-1', d);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 4);
    expect(d.onUnreachable).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS);
    expect(d.onUnreachable).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 3);
    expect(d.onUnreachable).toHaveBeenCalledTimes(1);

    let fail = true;
    let n = 0;
    const d2 = deps(async () => { n++; if (n === 5) fail = false; else fail = true; if (fail) throw new Error('offline'); return { session: { status: 'paused' as Status } }; });
    startParkedHeartbeat('sess-2', d2);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS * 9); // fail ×4, ok, fail ×4
    expect(d2.onUnreachable).not.toHaveBeenCalled();
  });

  it('a beat still in flight when stop() is called does nothing when it lands', async () => {
    let land: (v: { session: { status: Status } }) => void = () => {};
    const d = deps(() => new Promise((r) => { land = r; }));
    const stop = startParkedHeartbeat('sess-1', d);
    await vi.advanceTimersByTimeAsync(PARKED_HEARTBEAT_MS);
    stop();
    land({ session: { status: 'done' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(d.onRunOver).not.toHaveBeenCalled();
  });
});

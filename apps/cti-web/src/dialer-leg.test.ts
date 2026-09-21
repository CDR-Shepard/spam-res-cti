import { describe, expect, it, vi } from 'vitest';
import {
  dialerJoinParams,
  LEG_RECOVERY_DELAY_MS,
  LEG_RECOVERY_WINDOW_MS,
  legRecoveryToast,
  MAX_LEG_RECOVERIES,
  recentRejoins,
  recoverDroppedLeg,
  STOP_RETRY_DELAYS_MS,
  watchDialerLeg,
  type LegRecoveryDeps,
} from './dialer-leg';

describe('dialerJoinParams', () => {
  it('names the run, so the server records THIS leg on THIS run — even one that started paused', () => {
    expect(dialerJoinParams('sess-1')).toEqual({ DialerConference: '1', DialerSessionId: 'sess-1' });
  });
  it('omits the run when there is none, rather than sending an empty string', () => {
    expect(dialerJoinParams(null)).toEqual({ DialerConference: '1' });
    expect(dialerJoinParams('')).toEqual({ DialerConference: '1' });
  });
});

describe('watchDialerLeg', () => {
  const conn = () => {
    const handlers = new Map<string, () => void>();
    return { on: vi.fn((ev: string, cb: () => void) => { handlers.set(ev, cb); }), fire: (ev: string) => handlers.get(ev)?.() };
  };
  it('reports a disconnect of a leg we still hold — nobody asked for it, so the run has lost its audio', () => {
    const c = conn(); const onDropped = vi.fn();
    watchDialerLeg(c, { isOurs: () => true, onDropped });
    expect(c.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
    c.fire('disconnect');
    expect(onDropped).toHaveBeenCalledTimes(1);
  });
  it('ignores the disconnect we caused ourselves (Stop / run complete clears the ref first)', () => {
    const c = conn(); const onDropped = vi.fn();
    watchDialerLeg(c, { isOurs: () => false, onDropped });
    c.fire('disconnect');
    expect(onDropped).not.toHaveBeenCalled();
  });
  it('tolerates a connection object with no event API', () => {
    expect(() => watchDialerLeg({}, { isOurs: () => true, onDropped: vi.fn() })).not.toThrow();
    expect(() => watchDialerLeg(null, { isOurs: () => true, onDropped: vi.fn() })).not.toThrow();
  });
});

describe('recoverDroppedLeg', () => {
  const deps = (over: Partial<LegRecoveryDeps> = {}): LegRecoveryDeps => ({
    isCurrent: () => true,
    wait: vi.fn(async () => {}),
    fetchStatus: vi.fn(async () => 'active' as const),
    rejoin: vi.fn(async () => true),
    stop: vi.fn(async () => {}),
    ...over,
  });

  // The server hangs the leg up BEFORE it flips a finished run out of `active`.
  // Asking straight away would see `active` and rejoin a run that is over.
  it('waits before looking, then rejoins a run that is still live', async () => {
    const order: string[] = [];
    const d = deps({
      wait: vi.fn(async (ms: number) => { order.push(`wait:${ms}`); }),
      fetchStatus: vi.fn(async () => { order.push('status'); return 'active' as const; }),
      rejoin: vi.fn(async () => { order.push('rejoin'); return true; }),
    });
    expect(await recoverDroppedLeg(d, 0)).toBe('rejoined');
    expect(order).toEqual([`wait:${LEG_RECOVERY_DELAY_MS}`, 'status', 'rejoin']);
    expect(d.stop).not.toHaveBeenCalled();
  });

  // Run end costs the server up to five sequential Twilio REST calls between
  // hanging the leg up and flipping the status. Shorter than this and a finished
  // run reads as live.
  it('the wait is long enough to outlast the server\'s run-end teardown', () => {
    expect(LEG_RECOVERY_DELAY_MS).toBeGreaterThanOrEqual(1500);
  });

  it('a paused run keeps its rep in the room too', async () => {
    const d = deps({ fetchStatus: vi.fn(async () => 'paused' as const) });
    expect(await recoverDroppedLeg(d, 0)).toBe('rejoined');
  });

  it('does nothing for a run that is over — that disconnect was the server tidying up', async () => {
    for (const status of ['done', 'stopped', 'ready'] as const) {
      const d = deps({ fetchStatus: vi.fn(async () => status) });
      expect(await recoverDroppedLeg(d, 0)).toBe('run-over');
      expect(d.rejoin).not.toHaveBeenCalled();
      expect(d.stop).not.toHaveBeenCalled();
    }
  });

  it('does nothing once a Stop or a newer run superseded it — checked AFTER the wait', async () => {
    let current = true;
    const d = deps({ isCurrent: () => current, wait: vi.fn(async () => { current = false; }) });
    expect(await recoverDroppedLeg(d, 0)).toBe('superseded');
    expect(d.fetchStatus).not.toHaveBeenCalled();
    expect(d.rejoin).not.toHaveBeenCalled();
  });

  // The status read is a network round trip: a Stop can land while it is out.
  it('…and checked AGAIN after the status read, so a run stopped meanwhile is not rejoined', async () => {
    let current = true;
    const d = deps({ isCurrent: () => current, fetchStatus: vi.fn(async () => { current = false; return 'active' as const; }) });
    expect(await recoverDroppedLeg(d, 0)).toBe('superseded');
    expect(d.rejoin).not.toHaveBeenCalled();
    expect(d.stop).not.toHaveBeenCalled();
  });

  // A live run with no rep leg bridges every human who answers into an empty
  // room. If the leg cannot be brought back, the run must not keep dialing.
  it('stops the run when the rejoin fails', async () => {
    const d = deps({ rejoin: vi.fn(async () => { throw new Error('device error'); }) });
    expect(await recoverDroppedLeg(d, 0)).toBe('stopped');
    expect(d.stop).toHaveBeenCalledTimes(1);
  });

  it('stops the run instead of rejoining for ever when the leg keeps dropping', async () => {
    const d = deps();
    expect(await recoverDroppedLeg(d, MAX_LEG_RECOVERIES)).toBe('stopped');
    expect(d.rejoin).not.toHaveBeenCalled();
    expect(d.stop).toHaveBeenCalledTimes(1);
    expect(await recoverDroppedLeg(deps(), MAX_LEG_RECOVERIES - 1)).toBe('rejoined');
  });

  it('a status it cannot read is treated as live: try to get the rep back rather than assume the run is over', async () => {
    const d = deps({ fetchStatus: vi.fn(async () => { throw new Error('offline'); }) });
    expect(await recoverDroppedLeg(d, 0)).toBe('rejoined');
  });

  it('a rejoin that was itself superseded (resolves false) is not a failure — no stop', async () => {
    const d = deps({ rejoin: vi.fn(async () => false) });
    expect(await recoverDroppedLeg(d, 0)).toBe('superseded');
    expect(d.stop).not.toHaveBeenCalled();
  });

  // The usual reason a rejoin fails is that the network is down — and then the
  // stop fails too. One attempt would leave the run ACTIVE with no rep leg while
  // telling the rep it had been stopped.
  it('keeps trying to stop, on a backoff, until it lands', async () => {
    const waits: number[] = [];
    let calls = 0;
    const d = deps({
      rejoin: vi.fn(async () => { throw new Error('offline'); }),
      wait: vi.fn(async (ms: number) => { waits.push(ms); }),
      stop: vi.fn(async () => { if (++calls < 3) throw new Error('offline'); }),
    });
    expect(await recoverDroppedLeg(d, 0)).toBe('stopped');
    expect(d.stop).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([LEG_RECOVERY_DELAY_MS, STOP_RETRY_DELAYS_MS[0], STOP_RETRY_DELAYS_MS[1]]);
  });

  it('says so — never "stopped" — when the run could not be stopped, and never throws', async () => {
    const d = deps({ rejoin: vi.fn(async () => { throw new Error('x'); }), stop: vi.fn(async () => { throw new Error('y'); }) });
    expect(await recoverDroppedLeg(d, 0)).toBe('stop-failed');
    expect(d.stop).toHaveBeenCalledTimes(STOP_RETRY_DELAYS_MS.length + 1);
  });

  it('gives up retrying the stop once the rep has dealt with it themselves', async () => {
    let current = true;
    const d = deps({
      isCurrent: () => current,
      rejoin: vi.fn(async () => { throw new Error('x'); }),
      stop: vi.fn(async () => { current = false; throw new Error('y'); }),
    });
    expect(await recoverDroppedLeg(d, 0)).toBe('superseded');
    expect(d.stop).toHaveBeenCalledTimes(1);
  });
});

describe('recentRejoins — the cap decays', () => {
  // Three drops in a bad ten minutes means the connection is not coming back.
  // Three drops across a four-hour shift means nothing.
  it('counts only the rejoins inside the window', () => {
    const now = 10_000_000;
    expect(recentRejoins([], now)).toBe(0);
    expect(recentRejoins([now - 1, now - LEG_RECOVERY_WINDOW_MS + 1], now)).toBe(2);
    expect(recentRejoins([now - LEG_RECOVERY_WINDOW_MS, now - LEG_RECOVERY_WINDOW_MS - 1], now)).toBe(0);
  });
});

describe('legRecoveryToast', () => {
  it('is honest about what happened', () => {
    expect(legRecoveryToast('rejoined')).toEqual({ type: 'success', text: expect.stringContaining('reconnected') });
    expect(legRecoveryToast('stopped')).toEqual({ type: 'error', text: expect.stringContaining('was stopped') });
    const failed = legRecoveryToast('stop-failed');
    expect(failed?.type).toBe('error');
    expect(failed?.text).toContain('could not be stopped');
    expect(failed?.text).not.toContain('was stopped');
  });
  it('says nothing when there is nothing to tell', () => {
    expect(legRecoveryToast('superseded')).toBeNull();
    expect(legRecoveryToast('run-over')).toBeNull();
  });
});

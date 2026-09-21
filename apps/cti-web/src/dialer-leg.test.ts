import { describe, expect, it, vi } from 'vitest';
import {
  dialerJoinParams,
  LEG_RECOVERY_DELAY_MS,
  MAX_LEG_RECOVERIES,
  recoverDroppedLeg,
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

  it('never throws, even when the stop fails as well', async () => {
    const d = deps({ rejoin: vi.fn(async () => { throw new Error('x'); }), stop: vi.fn(async () => { throw new Error('y'); }) });
    expect(await recoverDroppedLeg(d, 0)).toBe('stopped');
  });
});

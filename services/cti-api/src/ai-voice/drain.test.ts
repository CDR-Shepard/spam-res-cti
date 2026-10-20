import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { afterCallWorkCount, drainLiveCalls, gracefulClose, isDraining, liveStreamCount, resetDrainForTests, trackAfterCallWork, trackLiveStream } from './drain.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const OPTS = { maxWaitMs: 60_000, settleMs: 5_000, log };

/** A media stream socket: 'close' is all the drain listens for. */
const stream = (): EventEmitter => {
  const socket = new EventEmitter();
  trackLiveStream(socket);
  return socket;
};

beforeEach(() => {
  vi.useFakeTimers();
  resetDrainForTests();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('trackLiveStream', () => {
  it('counts a stream until its socket closes, once however often it closes', () => {
    const a = stream();
    const b = stream();
    expect(liveStreamCount()).toBe(2);
    a.emit('close');
    a.emit('close');
    expect(liveStreamCount()).toBe(1);
    b.emit('close');
    expect(liveStreamCount()).toBe(0);
  });
});

describe('trackAfterCallWork', () => {
  it('counts the work until it settles, resolved or rejected, and hands back the same promise', async () => {
    let ok: () => void = () => {};
    const resolved = new Promise<void>((resolve) => (ok = resolve));
    const failing = Promise.reject(new Error('finalize failed'));
    expect(trackAfterCallWork(resolved)).toBe(resolved);
    const tracked = trackAfterCallWork(failing);
    expect(afterCallWorkCount()).toBe(2);
    await expect(tracked).rejects.toThrow('finalize failed');
    expect(afterCallWorkCount()).toBe(1);
    ok();
    await resolved;
    await Promise.resolve();
    expect(afterCallWorkCount()).toBe(0);
  });
});

describe('drainLiveCalls', () => {
  it('with no live call it ends at once, with no settle wait, and says it is draining from the start', async () => {
    expect(isDraining()).toBe(false);
    await expect(drainLiveCalls(OPTS)).resolves.toBe('drained');
    expect(isDraining()).toBe(true);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('waits for every live call to end, then lets the after-call work settle', async () => {
    const a = stream();
    const b = stream();
    let result: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (result = r));
    expect(log.info).toHaveBeenCalledWith({ live: 2, finishing: 0, maxWaitMs: 60_000 }, 'ai-voice: draining live calls before shutdown');
    await vi.advanceTimersByTimeAsync(30_000);
    a.emit('close');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result).toBeNull();
    b.emit('close');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('drained');
    expect(log.info).toHaveBeenLastCalledWith({}, 'ai-voice: live calls drained');
  });

  it('a call that starts while draining is waited for too', async () => {
    const a = stream();
    let result: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (result = r));
    const late = stream();
    a.emit('close');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result).toBeNull();
    late.emit('close');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBe('drained');
  });

  it('a call that starts during the settle is waited for too, then settled again, all within the deadline', async () => {
    const a = stream();
    let result: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(10_000);
    a.emit('close');
    await vi.advanceTimersByTimeAsync(2_000);
    const late = stream();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(result).toBeNull();
    late.emit('close');
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('drained');

    resetDrainForTests();
    const b = stream();
    let capped: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (capped = r));
    await vi.advanceTimersByTimeAsync(58_000);
    b.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    stream();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(capped).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(capped).toBe('deadline');
    expect(log.warn).toHaveBeenCalledWith({ live: 1, finishing: 0 }, 'ai-voice: drain deadline reached; closing the calls still live');
  });

  it("waits for a call's after-call work too, started when its stream closes, then settles", async () => {
    const a = stream();
    let finish: () => void = () => {};
    let result: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (result = r));
    a.emit('close');
    void trackAfterCallWork(new Promise<void>((resolve) => (finish = resolve)));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result).toBeNull();
    finish();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('drained');
  });

  it('after-call work alone (its stream already closed) is waited for, and named in the log', async () => {
    let finish: () => void = () => {};
    void trackAfterCallWork(new Promise<void>((resolve) => (finish = resolve)));
    let result: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (result = r));
    expect(log.info).toHaveBeenCalledWith({ live: 0, finishing: 1, maxWaitMs: 60_000 }, 'ai-voice: draining live calls before shutdown');
    finish();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result).toBe('drained');
  });

  it('gives up at the deadline and says how many calls are still live', async () => {
    stream();
    let result: string | null = null;
    void drainLiveCalls(OPTS).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe('deadline');
    expect(log.warn).toHaveBeenCalledWith({ live: 1, finishing: 0 }, 'ai-voice: drain deadline reached; closing the calls still live');
  });

  it('a second signal stops the wait at once, during the calls or the settle', async () => {
    stream();
    const force = new AbortController();
    const waiting = drainLiveCalls({ ...OPTS, signal: force.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    force.abort();
    await expect(waiting).resolves.toBe('forced');
    expect(log.warn).toHaveBeenCalledWith({ live: 1, finishing: 0 }, 'ai-voice: shutdown forced; closing the calls still live');

    resetDrainForTests();
    const s = stream();
    const again = new AbortController();
    const settling = drainLiveCalls({ ...OPTS, signal: again.signal });
    s.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    again.abort();
    await expect(settling).resolves.toBe('forced');
  });

  it('an already aborted signal does not wait at all', async () => {
    stream();
    const force = new AbortController();
    force.abort();
    await expect(drainLiveCalls({ ...OPTS, signal: force.signal })).resolves.toBe('forced');
  });
});

describe('gracefulClose', () => {
  const parts = () => {
    const order: string[] = [];
    let drainSignal: AbortSignal | null = null;
    let endDrain: (r: 'drained' | 'forced') => void = () => {};
    return {
      order,
      signal: () => drainSignal,
      endDrain: (r: 'drained' | 'forced') => endDrain(r),
      stopTimers: vi.fn(() => void order.push('timers')),
      drain: vi.fn((signal: AbortSignal) => {
        order.push('drain');
        drainSignal = signal;
        return new Promise<'drained' | 'forced'>((resolve) => (endDrain = resolve));
      }),
      closeServer: vi.fn(async () => void order.push('server')),
      setExitCode: vi.fn(),
      log,
    };
  };

  it('the first signal stops the timers, drains the live calls, then closes the server', async () => {
    const p = parts();
    const closing = gracefulClose(p)();
    expect(p.order).toEqual(['timers', 'drain']);
    expect(p.closeServer).not.toHaveBeenCalled();
    p.endDrain('drained');
    await closing;
    expect(p.order).toEqual(['timers', 'drain', 'server']);
    expect(p.signal()?.aborted).toBe(false);
    expect(p.setExitCode).not.toHaveBeenCalled();
  });

  it('a second signal stops the drain, and the shutdown runs only once', async () => {
    const p = parts();
    const close = gracefulClose(p);
    const first = close();
    const second = close();
    expect(second).toBe(first);
    expect(p.signal()?.aborted).toBe(true);
    p.endDrain('forced');
    await first;
    expect(p.stopTimers).toHaveBeenCalledTimes(1);
    expect(p.drain).toHaveBeenCalledTimes(1);
    expect(p.closeServer).toHaveBeenCalledTimes(1);
  });

  it('a server that fails to close is logged and leaves exit code 1; the handler never rejects', async () => {
    const p = parts();
    p.closeServer.mockRejectedValueOnce(new Error('close failed'));
    const closing = gracefulClose(p)();
    p.endDrain('drained');
    await expect(closing).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledWith({ err: 'close failed' }, 'cti-api: server close failed');
    expect(p.setExitCode).toHaveBeenCalledWith(1);
  });
});

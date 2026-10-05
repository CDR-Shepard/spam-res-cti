import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  claimClose,
  clearActiveCalls,
  closeActiveCall,
  dropActiveCall,
  getActiveCall,
  registerActiveCall,
  updateActiveCall,
} from './registry.js';
import { activeEntry as entry } from './testing.js';

afterEach(() => {
  clearActiveCalls();
  vi.useRealTimers();
});

describe('AI call registry', () => {
  it('registers, replaces fields without mutating, and drops', () => {
    const e = entry();
    registerActiveCall(e);
    const next = updateActiveCall('a1', { callSid: 'CA1' });
    expect(next?.callSid).toBe('CA1');
    expect(e.callSid).toBeNull();
    expect(getActiveCall('a1')?.callSid).toBe('CA1');
    expect(dropActiveCall('a1')?.aiCallId).toBe('a1');
    expect(getActiveCall('a1')).toBeNull();
    expect(updateActiveCall('a1', { callSid: 'x' })).toBeNull();
  });

  it('lets exactly one caller claim the close', () => {
    registerActiveCall(entry());
    expect(claimClose('a1')).toBe(true);
    expect(claimClose('a1')).toBe(false);
    expect(claimClose('missing')).toBe(false);
  });

  it('closeActiveCall stops the bridge and closes the transcript, once', async () => {
    const bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(), stop: vi.fn() };
    const transcript = { close: vi.fn(async () => {}) };
    registerActiveCall(entry({ bridge, transcript: transcript as never }));
    await closeActiveCall('a1');
    await closeActiveCall('a1');
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(transcript.close).toHaveBeenCalledTimes(1);
    expect(getActiveCall('a1')).toBeNull();
  });

  it('an entry expires on its own after its TTL', () => {
    vi.useFakeTimers();
    const bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(), stop: vi.fn() };
    registerActiveCall(entry({ bridge }), 5_000);
    vi.advanceTimersByTime(4_999);
    expect(getActiveCall('a1')).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(getActiveCall('a1')).toBeNull();
    expect(bridge.stop).toHaveBeenCalled();
  });
});

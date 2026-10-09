import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackTracker, base64Bytes } from './bridge-playback.js';

/** Base64 μ-law audio lasting `ms` milliseconds (8 bytes per ms at 8 kHz). */
const audio = (ms: number): string => Buffer.alloc(ms * 8).toString('base64');

describe('base64Bytes', () => {
  it('counts decoded bytes without decoding, honouring padding', () => {
    expect(base64Bytes('')).toBe(0);
    expect(base64Bytes(Buffer.alloc(1).toString('base64'))).toBe(1);
    expect(base64Bytes(Buffer.alloc(2).toString('base64'))).toBe(2);
    expect(base64Bytes(Buffer.alloc(3).toString('base64'))).toBe(3);
    expect(base64Bytes(audio(160))).toBe(1280);
  });
});

describe('PlaybackTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names one mark per chunk and is playing until every mark is acked', () => {
    const p = new PlaybackTracker();
    expect(p.playing).toBe(false);
    const a = p.onAudioDelta('item_1', audio(20));
    const b = p.onAudioDelta('item_1', audio(20));
    expect(a).not.toBe(b);
    expect(p.playing).toBe(true);
    p.onMark(a);
    expect(p.playing).toBe(true);
    p.onMark(b);
    expect(p.playing).toBe(false);
  });

  it('a later mark acks every earlier one; unknown marks are ignored', () => {
    const p = new PlaybackTracker();
    p.onAudioDelta('item_1', audio(20));
    const b = p.onAudioDelta('item_1', audio(20));
    p.onMark('stale');
    expect(p.playing).toBe(true);
    p.onMark(b);
    expect(p.playing).toBe(false);
  });

  it('interrupt cuts the item at the inbound-media time elapsed since its first chunk', () => {
    const p = new PlaybackTracker();
    p.onInboundMedia(1000);
    p.onAudioDelta('item_1', audio(1000));
    p.onInboundMedia(1600);
    expect(p.interrupt()).toEqual({ itemId: 'item_1', audioEndMs: 600 });
    // tracking is reset
    expect(p.playing).toBe(false);
    expect(p.interrupt()).toBeNull();
  });

  it('clamps the cut to the audio generated so far and never below zero', () => {
    const p = new PlaybackTracker();
    p.onInboundMedia(1000);
    p.onAudioDelta('item_1', audio(200));
    p.onInboundMedia(5000);
    expect(p.interrupt()).toEqual({ itemId: 'item_1', audioEndMs: 200 });

    const q = new PlaybackTracker();
    q.onInboundMedia(1000);
    q.onAudioDelta('item_2', audio(200));
    q.onInboundMedia(900); // out-of-order timestamp is ignored
    expect(q.interrupt()).toEqual({ itemId: 'item_2', audioEndMs: 0 });
  });

  it('restarts the clock for each new assistant item', () => {
    const p = new PlaybackTracker();
    p.onInboundMedia(1000);
    const m = p.onAudioDelta('item_1', audio(500));
    p.onMark(m);
    p.onInboundMedia(4000);
    p.onAudioDelta('item_2', audio(500));
    p.onInboundMedia(4300);
    expect(p.interrupt()).toEqual({ itemId: 'item_2', audioEndMs: 300 });
  });

  it('interrupt returns null when nothing is playing', () => {
    const p = new PlaybackTracker();
    const m = p.onAudioDelta('item_1', audio(100));
    p.onMark(m);
    expect(p.interrupt()).toBeNull();
  });

  it('waitForDrain resolves once the audio is done and every mark has played', async () => {
    const p = new PlaybackTracker();
    const m = p.onAudioDelta('item_1', audio(100));
    let done = false;
    void p.waitForDrain(8000).then(() => {
      done = true;
    });
    p.onMark(m);
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false); // audio still streaming
    p.onAudioDone();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('waitForDrain resolves after maxMs when marks never come back', async () => {
    const p = new PlaybackTracker();
    p.onAudioDelta('item_1', audio(100));
    p.onAudioDone();
    let done = false;
    void p.waitForDrain(8000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(7999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('waitForDrain resolves at once when idle, and on reset/releaseAll', async () => {
    const p = new PlaybackTracker();
    await expect(p.waitForDrain(8000)).resolves.toBeUndefined();

    p.onAudioDelta('item_1', audio(100));
    const w1 = p.waitForDrain(8000);
    p.reset();
    await expect(w1).resolves.toBeUndefined();

    p.onAudioDelta('item_2', audio(100));
    const w2 = p.waitForDrain(8000);
    p.releaseAll();
    await expect(w2).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a finished response counts as audio done', async () => {
    const p = new PlaybackTracker();
    const m = p.onAudioDelta('item_1', audio(100));
    const w = p.waitForDrain(8000);
    p.onResponseDone();
    p.onMark(m);
    await expect(w).resolves.toBeUndefined();
  });
});

describe('drained listener, current item and audio left', () => {
  const b64 = (ms: number) => Buffer.alloc(ms * 8).toString('base64');

  it('calls onDrained once the last mark plays after audio done, not on interrupt', () => {
    const onDrained = vi.fn();
    const p = new PlaybackTracker({ onDrained });
    const m1 = p.onAudioDelta('item_1', b64(100));
    p.onAudioDone();
    expect(onDrained).not.toHaveBeenCalled();
    p.onMark(m1);
    expect(onDrained).toHaveBeenCalledTimes(1);

    p.onAudioDelta('item_2', b64(100));
    p.interrupt();
    expect(onDrained).toHaveBeenCalledTimes(1);
  });

  it('does not call onDrained for a response with no audio', () => {
    const onDrained = vi.fn();
    const p = new PlaybackTracker({ onDrained });
    p.onResponseDone();
    expect(onDrained).not.toHaveBeenCalled();
  });

  it('reports the current item and the audio left to play', () => {
    const p = new PlaybackTracker();
    expect(p.currentItemId).toBeNull();
    expect(p.remainingMs()).toBe(0);
    p.onInboundMedia(1000);
    p.onAudioDelta('item_1', b64(3000));
    expect(p.currentItemId).toBe('item_1');
    expect(p.remainingMs()).toBe(Number.POSITIVE_INFINITY); // still streaming
    p.onAudioDone();
    p.onInboundMedia(2500);
    expect(p.remainingMs()).toBe(1500);
    p.onInboundMedia(9000);
    expect(p.remainingMs()).toBe(0);
  });

  it('reports Infinity while the response streams even when every mark has echoed', () => {
    const p = new PlaybackTracker();
    const m = p.onAudioDelta('item_1', Buffer.alloc(800).toString('base64'));
    p.onMark(m);
    expect(p.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });
});

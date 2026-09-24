/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetYouTubeApiForTests, loadYouTubeApi, playerOptionsFor } from './youtube-api';
import type { YTNamespace } from './youtube-api';

describe('playerOptionsFor', () => {
  it('a playlist', () => {
    expect(playerOptionsFor({ listId: 'PLx1234567', videoId: null })).toEqual({
      playerVars: { listType: 'playlist', list: 'PLx1234567', playsinline: 1, rel: 0 },
    });
  });

  it('a video in a playlist starts on that video', () => {
    expect(playerOptionsFor({ listId: 'PLx1234567', videoId: 'dQw4w9WgXcQ' })).toEqual({
      videoId: 'dQw4w9WgXcQ',
      playerVars: { list: 'PLx1234567', playsinline: 1, rel: 0 },
    });
  });

  it('a single video loops (YouTube needs playlist=<id> for that)', () => {
    expect(playerOptionsFor({ listId: null, videoId: 'dQw4w9WgXcQ' })).toEqual({
      videoId: 'dQw4w9WgXcQ',
      playerVars: { loop: 1, playlist: 'dQw4w9WgXcQ', playsinline: 1, rel: 0 },
    });
  });
});

describe('loadYouTubeApi', () => {
  beforeEach(() => {
    _resetYouTubeApiForTests();
    document.head.innerHTML = '';
    delete (window as unknown as { YT?: unknown }).YT;
    delete (window as unknown as { onYouTubeIframeAPIReady?: unknown }).onYouTubeIframeAPIReady;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects the script once and resolves with window.YT when YouTube calls back', async () => {
    const fakeNs = { Player: class {} } as unknown as YTNamespace;
    const promise = loadYouTubeApi();
    const promise2 = loadYouTubeApi();

    const scripts = document.head.querySelectorAll('script[src="https://www.youtube.com/iframe_api"]');
    expect(scripts.length).toBe(1);

    (window as unknown as { YT?: YTNamespace }).YT = fakeNs;
    (window as unknown as { onYouTubeIframeAPIReady: () => void }).onYouTubeIframeAPIReady();

    await expect(promise).resolves.toBe(fakeNs);
    // A second call before resolution reuses the same in-flight promise.
    expect(promise2).toBe(promise);
  });

  it('rejects after the timeout when YouTube never calls back', async () => {
    vi.useFakeTimers();
    const promise = loadYouTubeApi(15_000);
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  // M8 — a timed-out load must not wedge every future attempt behind its
  // dead promise: the cache is cleared on timeout (see loadYouTubeApi), so a
  // retry gets its own promise and its own script tag.
  it('after a timeout rejection, a second call returns a NEW promise and injects the script again', async () => {
    vi.useFakeTimers();
    const first = loadYouTubeApi(15_000);
    const firstRejection = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    await firstRejection;

    const second = loadYouTubeApi(15_000);
    expect(second).not.toBe(first);
    expect(document.head.querySelectorAll('script[src="https://www.youtube.com/iframe_api"]').length).toBe(2);

    // Let it resolve so this test doesn't leak a pending timer of its own.
    const fakeNs = { Player: class {} } as unknown as YTNamespace;
    (window as unknown as { YT?: YTNamespace }).YT = fakeNs;
    (window as unknown as { onYouTubeIframeAPIReady: () => void }).onYouTubeIframeAPIReady();
    await expect(second).resolves.toBe(fakeNs);
  });

  // X2 — a page can only have one onYouTubeIframeAPIReady global; a second
  // consumer of the API (however unlikely today) must not silently break the
  // first one that was already waiting on it.
  it('chains a pre-existing window.onYouTubeIframeAPIReady instead of replacing it', async () => {
    const previous = vi.fn();
    (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = previous;

    const fakeNs = { Player: class {} } as unknown as YTNamespace;
    const promise = loadYouTubeApi();
    (window as unknown as { YT?: YTNamespace }).YT = fakeNs;
    (window as unknown as { onYouTubeIframeAPIReady: () => void }).onYouTubeIframeAPIReady();

    await expect(promise).resolves.toBe(fakeNs);
    expect(previous).toHaveBeenCalledTimes(1);
  });

  // A throwing previous handler is still someone else's bug, not a reason to
  // strand our own promise forever.
  it('does not let a throwing previous handler stop our own resolution', async () => {
    (window as unknown as { onYouTubeIframeAPIReady?: () => void }).onYouTubeIframeAPIReady = () => {
      throw new Error('boom');
    };
    const fakeNs = { Player: class {} } as unknown as YTNamespace;
    const promise = loadYouTubeApi();
    (window as unknown as { YT?: YTNamespace }).YT = fakeNs;

    expect(() => (window as unknown as { onYouTubeIframeAPIReady: () => void }).onYouTubeIframeAPIReady()).not.toThrow();
    await expect(promise).resolves.toBe(fakeNs);
  });

  // X3 — a second run on the same page (or a fast rep starting a second dial
  // session) finds the API already loaded; re-injecting the script would be
  // wasteful and pointless.
  it('resolves immediately with no script injected when window.YT.Player already exists', async () => {
    const fakeNs = { Player: class {} } as unknown as YTNamespace;
    (window as unknown as { YT?: YTNamespace }).YT = fakeNs;

    await expect(loadYouTubeApi()).resolves.toBe(fakeNs);
    expect(document.head.querySelectorAll('script[src="https://www.youtube.com/iframe_api"]').length).toBe(0);
  });

  // Minor: a script that fails to load outright (network error, CSP block)
  // should reject promptly instead of making every caller wait out the full
  // 15s timeout, and must clear the cache so a retry is possible.
  it('rejects promptly and clears the cache when the script itself fails to load', async () => {
    const promise = loadYouTubeApi(15_000);
    const rejection = expect(promise).rejects.toThrow();
    const script = document.head.querySelector('script[src="https://www.youtube.com/iframe_api"]') as HTMLScriptElement;
    script.dispatchEvent(new Event('error'));
    await rejection;

    const second = loadYouTubeApi();
    expect(second).not.toBe(promise);
  });
});

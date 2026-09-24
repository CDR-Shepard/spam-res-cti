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
});

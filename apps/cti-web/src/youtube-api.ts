/**
 * The YouTube IFrame Player API — the only compliant way to play a rep's
 * YouTube music (YouTube forbids separating the audio from its own player,
 * and the player must stay visible). Loaded once, on demand, the first time a
 * run with YouTube hold music starts.
 */
import type { YouTubeRef } from '@cti/contracts';

export const YT_PLAYING = 1;
export const YT_BUFFERING = 3;

export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  setShuffle(on: boolean): void;
  setLoop(on: boolean): void;
  getPlayerState(): number;
  destroy(): void;
}

export interface YTPlayerOptions {
  height: string;
  width: string;
  host: string;
  videoId?: string;
  playerVars: Record<string, string | number>;
  events: {
    onReady?: (e: { target: YTPlayer }) => void;
    onStateChange?: (e: { data: number }) => void;
    onError?: (e: { data: number }) => void;
  };
}

export interface YTNamespace {
  Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer;
}

/**
 * The `playerVars` YouTube needs for a given choice — a playlist, a single
 * video, or a video that starts inside a playlist. A lone video needs the
 * `playlist=<id>` trick because YouTube's `loop` param otherwise does nothing
 * for a single video.
 */
export function playerOptionsFor(ref: YouTubeRef): Pick<YTPlayerOptions, 'videoId' | 'playerVars'> {
  const base = { playsinline: 1, rel: 0 };
  if (ref.listId && ref.videoId) return { videoId: ref.videoId, playerVars: { list: ref.listId, ...base } };
  if (ref.listId) return { playerVars: { listType: 'playlist', list: ref.listId, ...base } };
  return { videoId: ref.videoId ?? '', playerVars: { loop: 1, playlist: ref.videoId ?? '', ...base } };
}

/** The in-flight (or already-resolved) load, shared across every caller so the
 *  script tag and `onYouTubeIframeAPIReady` are only ever set up once. */
let loading: Promise<YTNamespace> | null = null;

/** Clears the cached load so a later call can retry — used by tests, and by a
 *  timed-out load so the NEXT attempt isn't stuck reusing a dead promise. */
export function _resetYouTubeApiForTests(): void {
  loading = null;
}

/**
 * Injects YouTube's `iframe_api` script (once) and resolves with the global
 * `YT` namespace once it calls back. Rejects if that never happens within
 * `timeoutMs`, clearing the cached promise so a later call can retry.
 */
export function loadYouTubeApi(timeoutMs = 15_000): Promise<YTNamespace> {
  if (loading) return loading;
  const w = window as unknown as { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void };
  loading = new Promise<YTNamespace>((resolve, reject) => {
    if (w.YT?.Player) {
      resolve(w.YT);
      return;
    }
    const timer = setTimeout(() => {
      loading = null;
      reject(new Error('YouTube player API did not load'));
    }, timeoutMs);
    // A page can only ever have one `onYouTubeIframeAPIReady` — chain any
    // pre-existing one so a second consumer of the API doesn't clobber the first.
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      try {
        previous?.();
      } catch {
        // Someone else's handler misbehaving must not strand OUR promise.
      }
      if (w.YT) resolve(w.YT);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    // A network error or CSP block never calls onYouTubeIframeAPIReady —
    // without this, every caller would wait out the full timeout for a load
    // that was never going to happen.
    script.onerror = () => {
      clearTimeout(timer);
      loading = null;
      reject(new Error('Failed to load the YouTube player script'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** @vitest-environment jsdom */
/**
 * Fake YouTube IFrame API (no network, no real player) — pins the controller
 * logic in YouTubeHoldPlayer: one player per mount, the pause/resume triggers,
 * the caption precedence, and that a misbehaving player (blocked autoplay, a
 * throwing call, a rejected load) can never crash the panel or leak timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { YouTubeRef } from '@cti/contracts';
import type { DialerCurrentItem } from '../dialer-api';
import { createLineAudio } from '../line-audio';
import { YT_PLAYING, type YTNamespace, type YTPlayer, type YTPlayerOptions } from '../youtube-api';
import { YouTubeHoldPlayer, type YouTubeHoldPlayerProps } from './YouTubeHoldPlayer';

const CAPTION_NORMAL = 'Pauses automatically when someone answers.';
const CAPTION_FIRST_TIME = 'Press play once — after that it pauses and resumes by itself.';
const CAPTION_STUCK = 'Press play to resume';
const CAPTION_ERROR = "Couldn't load your YouTube playlist";

type CurrentItem = Pick<DialerCurrentItem, 'status' | 'prospectEndedAt'>;

const item = (status: string, prospectEndedAt: string | null = null): CurrentItem => ({ status, prospectEndedAt });

/** A pure playlist (no starting video) — the case that also gets shuffle+loop. */
const PLAYLIST_REF: YouTubeRef = { listId: 'PLx1234567', videoId: null };

/** From the brief: a fake `YT` namespace whose `Player` records every call it
 *  gets and, unless `blockAutoplay`, actually flips state + fires events —
 *  close enough to the real IFrame API to pin our controller, not YouTube's. */
function fakeYT(opts: { blockAutoplay?: boolean } = {}) {
  const created: Array<{ opts: YTPlayerOptions; player: YTPlayer & { state: number; calls: string[] } }> = [];
  class Player {
    state = -1;
    calls: string[] = [];
    private o: YTPlayerOptions;
    constructor(_el: HTMLElement, o: YTPlayerOptions) {
      this.o = o;
      created.push({ opts: o, player: this as never });
      queueMicrotask(() => o.events.onReady?.({ target: this as never }));
    }
    playVideo() {
      this.calls.push('play');
      if (!opts.blockAutoplay) {
        this.state = 1;
        this.o.events.onStateChange?.({ data: 1 });
      }
    }
    pauseVideo() {
      this.calls.push('pause');
      this.state = 2;
      this.o.events.onStateChange?.({ data: 2 });
    }
    setShuffle() {
      this.calls.push('shuffle');
    }
    setLoop() {
      this.calls.push('loop');
    }
    getPlayerState() {
      return this.state;
    }
    destroy() {
      this.calls.push('destroy');
    }
  }
  return { ns: { Player } as unknown as YTNamespace, created };
}

/** Default props for a run that's actively ringing the next number with a
 *  quiet line — i.e. `shouldPlay` is true. */
function baseProps(overrides: Partial<YouTubeHoldPlayerProps>, ns: YTNamespace): YouTubeHoldPlayerProps {
  return {
    youtube: PLAYLIST_REF,
    sessionStatus: 'active',
    currentItem: item('dialing'),
    loadApi: () => Promise.resolve(ns),
    ...overrides,
  };
}

/** Flushes the `loadApi` promise chain and the fake Player's `queueMicrotask`
 *  `onReady` callback — both are real microtasks even under fake timers, and
 *  `advanceTimersByTimeAsync(0)` is vitest's documented way to drain them. */
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

describe('YouTubeHoldPlayer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates exactly one player across re-renders, with the right options; a pure playlist gets shuffle+loop on ready', async () => {
    const { ns, created } = fakeYT();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing') }, ns)} />);
    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing') }, ns)} />);
    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing') }, ns)} />);

    expect(created.length).toBe(1);
    expect(created[0]?.opts).toMatchObject({
      height: '200',
      width: '100%',
      host: 'https://www.youtube-nocookie.com',
      playerVars: { listType: 'playlist', list: 'PLx1234567', playsinline: 1, rel: 0 },
    });
    expect(created[0]?.player.calls).toContain('shuffle');
    expect(created[0]?.player.calls).toContain('loop');
  });

  it('plays when shouldPlay is true (active, dialing, quiet line); shows the normal caption once PLAYING', async () => {
    const { ns, created } = fakeYT();
    render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    expect(created[0]?.player.calls).toContain('play');
    expect(screen.getByText(CAPTION_NORMAL)).toBeTruthy();
  });

  it('two consecutive loud line samples pause immediately (no timer advance needed); one alone does not', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    act(() => { lineAudio.push(0.05); });
    expect(player.calls.filter((c) => c === 'pause')).toHaveLength(0);

    act(() => { lineAudio.push(0.05); });
    expect(player.calls).toContain('pause');
  });

  it('pauses the instant currentItem becomes connected', async () => {
    const { ns, created } = fakeYT();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('connected') }, ns)} />);
    expect(player.calls.at(-1)).toBe('pause');
  });

  it('stays paused through a session pause and only resumes once quiet for 1.5s after returning to dialing', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    // Rep hits Pause — must stop right away.
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, sessionStatus: 'paused' }, ns)} />);
    expect(player.calls.at(-1)).toBe('pause');
    const callsAfterPause = player.calls.length;

    // Still paused through a 500ms re-evaluation tick — no new calls.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(player.calls.length).toBe(callsAfterPause);

    // Back to active/dialing, but the line just went loud — must not resume
    // before the 1.5s quiet window passes even though the session is active.
    act(() => { lineAudio.push(0.05); });
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, sessionStatus: 'active' }, ns)} />);
    expect(player.calls.length).toBe(callsAfterPause);

    // Advance past the quiet window — the periodic tick resumes it.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(player.calls.at(-1)).toBe('play');
  });

  it('shows the first-time caption until the player actually reports PLAYING once, even though playVideo() was called', async () => {
    const { ns, created } = fakeYT({ blockAutoplay: true });
    render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    expect(created[0]?.player.calls).toContain('play');
    expect(screen.getByText(CAPTION_FIRST_TIME)).toBeTruthy();

    // The rep pressed play on the embedded iframe itself — YouTube reports it
    // out of band via onStateChange, independent of our blocked playVideo().
    act(() => { created[0]?.opts.events.onStateChange?.({ data: YT_PLAYING }); });
    expect(screen.getByText(CAPTION_NORMAL)).toBeTruthy();
  });

  it('shows "Press play to resume" when a post-first-play resume never reaches PLAYING within 2s', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const entry = created[0]!;
    expect(entry.player.calls).toContain('play');
    expect(screen.getByText(CAPTION_NORMAL)).toBeTruthy();

    // Pause it (connected), then block the resume the way a real browser
    // might silently refuse a programmatic play() outside a user gesture.
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, currentItem: item('connected') }, ns)} />);
    expect(entry.player.calls.at(-1)).toBe('pause');
    entry.player.playVideo = () => { entry.player.calls.push('play'); };

    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, currentItem: item('dialing') }, ns)} />);
    expect(entry.player.calls.at(-1)).toBe('play');
    expect(screen.getByText(CAPTION_NORMAL)).toBeTruthy(); // not stuck yet

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText(CAPTION_STUCK)).toBeTruthy();
  });

  it('shows the load-error caption when loadApi rejects, and never throws', async () => {
    const loadApi = () => Promise.reject(new Error('network down'));
    expect(() => render(
      <YouTubeHoldPlayer youtube={PLAYLIST_REF} sessionStatus="active" currentItem={item('dialing')} loadApi={loadApi} />,
    )).not.toThrow();
    await flush();
    expect(screen.getByText(CAPTION_ERROR)).toBeTruthy();
  });

  it('shows the load-error caption when the player reports onError, and never throws', async () => {
    const { ns, created } = fakeYT();
    render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    expect(() => act(() => { created[0]?.opts.events.onError?.({ data: 2 }); })).not.toThrow();
    expect(screen.getByText(CAPTION_ERROR)).toBeTruthy();
  });

  it('destroys the player on unmount', async () => {
    const { ns, created } = fakeYT();
    const { unmount } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    unmount();
    expect(created[0]?.player.calls).toContain('destroy');
  });

  it('leaves no pending timers after unmount — the 500ms interval and a pending stuck timer are both cleared', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    const { rerender, unmount } = render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const entry = created[0]!;

    // Get a stuck timer pending too, not just the interval: pause, then block
    // the resume so evaluate() arms the 2000ms stuck timeout.
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, currentItem: item('connected') }, ns)} />);
    entry.player.playVideo = () => { entry.player.calls.push('play'); };
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, currentItem: item('dialing') }, ns)} />);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not update state or throw when loadApi resolves after unmount', async () => {
    let resolveApi: (ns: YTNamespace) => void = () => {};
    const loadApi = () => new Promise<YTNamespace>((resolve) => { resolveApi = resolve; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = render(
      <YouTubeHoldPlayer youtube={PLAYLIST_REF} sessionStatus="active" currentItem={item('dialing')} loadApi={loadApi} />,
    );
    unmount();

    const { ns } = fakeYT();
    expect(() => resolveApi(ns)).not.toThrow();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('wraps playVideo in try/catch so a YouTube internal error cannot crash the panel', async () => {
    const { ns, created } = fakeYT();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();
    const entry = created[0]!;
    expect(entry.player.calls).toContain('play');

    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('connected') }, ns)} />);
    entry.player.playVideo = () => { throw new Error('YT internal error'); };

    expect(() => {
      rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing') }, ns)} />);
    }).not.toThrow();
  });
});

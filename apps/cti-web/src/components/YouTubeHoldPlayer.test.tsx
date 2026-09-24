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
import { YT_BUFFERING, YT_PLAYING, type YTNamespace, type YTPlayer, type YTPlayerOptions } from '../youtube-api';
import { YouTubeHoldPlayer, type YouTubeHoldPlayerProps } from './YouTubeHoldPlayer';

const CAPTION_NORMAL = 'Pauses automatically when someone answers.';
const CAPTION_FIRST_TIME = 'Press play once — after that it pauses and resumes by itself.';
const CAPTION_STUCK = 'Press play to resume';
const CAPTION_ERROR = "Couldn't load your YouTube playlist";

type CurrentItem = Pick<DialerCurrentItem, 'id' | 'status' | 'prospectEndedAt'>;

// `id` defaults to a stable value so most call sites (which don't care about
// it) don't need to pass one; the heard-latch tests pass a distinct id.
const item = (status: string, prospectEndedAt: string | null = null, id = 'item-1'): CurrentItem => ({
  id,
  status,
  prospectEndedAt,
});

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
    // Flush again: if a mutant re-ran the mount effect on a prop change, its
    // async `loadApi().then(...)` might not have resolved yet at this point —
    // checking `created.length` without this would miss it.
    await flush();

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

  // Fix round 2, item 1 — while the prospect talks, Twilio fires ~19 volume
  // samples/sec, and every one of them satisfies heardSomeone (recentLevels
  // stays "loud"). Calling pauseVideo() on every single one is pause spam
  // into the iframe; it should only ever call it while the player is
  // actually PLAYING or BUFFERING.
  it('does not call pauseVideo on every loud sample while the player is already paused', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, currentItem: item('connected') }, ns)} />);
    expect(player.calls.at(-1)).toBe('pause'); // genuinely paused now (state = 2)
    const pauseCallsBefore = player.calls.filter((c) => c === 'pause').length;

    // ~1s of continuous loud audio while already paused.
    act(() => {
      for (let i = 0; i < 20; i++) lineAudio.push(0.05);
    });

    expect(player.calls.filter((c) => c === 'pause').length).toBe(pauseCallsBefore);
  });

  it('pauses exactly once for the first pair of loud samples while actually playing', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play'); // state is YT_PLAYING (autoplay allowed)

    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); });
    expect(player.calls.filter((c) => c === 'pause').length).toBe(1);
  });

  it('pauses when the player is BUFFERING, not only when fully PLAYING', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    player.state = YT_BUFFERING; // simulate buffering rather than fully playing
    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); });
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

  // M4 — the stuck timer must only ever be armed after the FIRST PLAYING
  // (see `evaluate()`'s `everPlayedLocal` guard). Before that, no amount of
  // waiting should ever produce the stuck caption — only the first-time one.
  it('never shows the stuck caption before the first PLAYING, no matter how long playback is blocked', async () => {
    const { ns, created } = fakeYT({ blockAutoplay: true });
    render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();
    expect(created[0]?.player.calls).toContain('play');
    expect(screen.getByText(CAPTION_FIRST_TIME)).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(2500); }); // > STUCK_AFTER_MS
    expect(screen.getByText(CAPTION_FIRST_TIME)).toBeTruthy();
    expect(screen.queryByText(CAPTION_STUCK)).toBeNull();
  });

  // X6 — a prospectEndedAt-only change (no status/id change) must still
  // re-evaluate immediately via the prop-change effect, not wait for the
  // 500ms tick.
  it('a prospectEndedAt change alone pauses immediately, before any timer tick', async () => {
    const { ns, created } = fakeYT();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing', '2026-01-01T00:00:00Z') }, ns)} />);
    expect(player.calls.at(-1)).toBe('pause');
  });

  // The brief's missing case: prospectEndedAt set from the very start (the
  // rep hasn't chosen Redial/Resume yet) must never play at all, even though
  // status is still 'dialing'.
  it('stays paused for as long as prospectEndedAt is set, even though status is dialing', async () => {
    const { ns, created } = fakeYT();
    render(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing', '2026-01-01T00:00:00Z') }, ns)} />);
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(created[0]?.player.calls).not.toContain('play');
  });

  // Issue #2 — a heard-latch: once the line-audio signal has heard someone,
  // a merely-quiet line must not resume music while the poll still reports
  // the SAME ringing item — a real conversation could easily still be going,
  // and the poll (up to POLL_TIMEOUT_MS + POLL_INTERVAL_MS behind) simply
  // hasn't caught up yet.
  // A real Twilio call keeps sending 'volume' events continuously, not just
  // when something is loud — so "quiet" in practice means new LOW samples
  // keep arriving, which is what actually slides `heardSomeone`'s window back
  // to false. Pushing these (rather than merely advancing the clock) isolates
  // the heard-LATCH as the thing under test, instead of conflating it with
  // `recentLevels` simply never having been refreshed.
  const settleQuiet = (lineAudio: ReturnType<typeof createLineAudio>): void => {
    act(() => { lineAudio.push(0); lineAudio.push(0); });
  };

  it('does not resume from quiet alone while the poll still reports the same item it did when someone was heard', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />); // item-1, dialing
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); }); // latches item-1/dialing
    expect(player.calls.at(-1)).toBe('pause');
    const callsAfterHeard = player.calls.length;
    settleQuiet(lineAudio);

    // Well past the 1.5s quiet window — but the poll hasn't moved on, so the
    // latch alone must still block a resume.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(player.calls.length).toBe(callsAfterHeard);
  });

  it('resumes once the poll moves to a NEW item — the latch, not the quiet window, was blocking it', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />); // item-1, dialing
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); }); // latches item-1/dialing
    expect(player.calls.at(-1)).toBe('pause');
    const callsAfterHeard = player.calls.length;
    settleQuiet(lineAudio);

    // Plenty quiet now (well past 1.5s) but the poll still reports item-1 —
    // still latched (this alone repeats the previous test's guarantee).
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(player.calls.length).toBe(callsAfterHeard);

    // The poll finally reports a brand-new item, still dialing, line already
    // quiet — the latch no longer applies, so it resumes right away (the
    // id is in the re-evaluate effect's deps, so no need to wait for a tick).
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, currentItem: item('dialing', null, 'item-2') }, ns)} />);
    expect(player.calls.at(-1)).toBe('play');
  });

  it('the heard-latch expires on its own after 12s even if the poll never confirms anything changed', async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />); // item-1, dialing
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); }); // latches
    expect(player.calls.at(-1)).toBe('pause');
    const callsAfterHeard = player.calls.length;
    settleQuiet(lineAudio);

    // Short of the 12s cap — still latched.
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(player.calls.length).toBe(callsAfterHeard);

    // Past the 12s cap — the latch releases on its own (the line has been
    // quiet the whole time, so it resumes as soon as it's released).
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(player.calls.at(-1)).toBe('play');
  });

  // Fix round 2, item 2 — pins the latch's session clause (a prior mutation
  // that dropped `sessionStatus !== 'active'` from the "poll moved on" check
  // survived review). A session pause-then-resume, with the SAME item id and
  // status throughout, must still release the latch: otherwise a rep who
  // pauses and resumes the run mid-latch would stay silently stuck.
  it("a session pause-then-resume releases the heard-latch even with the same item id and status", async () => {
    const { ns, created } = fakeYT();
    const lineAudio = createLineAudio();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />); // item-1, dialing, active
    await flush();
    const player = created[0]!.player;
    expect(player.calls).toContain('play');

    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); }); // latches item-1/dialing
    expect(player.calls.at(-1)).toBe('pause');
    settleQuiet(lineAudio);

    // Session pauses, then resumes — id and status never change.
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, sessionStatus: 'paused' }, ns)} />);
    rerender(<YouTubeHoldPlayer {...baseProps({ lineAudio, sessionStatus: 'active' }, ns)} />);

    // Quiet for >= 1.5s — resumes, because the session change (not the item
    // id or status, which never moved) released the latch.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(player.calls.at(-1)).toBe('play');
  });

  // Issue #1 — a REALISTIC fake: the real IFrame API's methods genuinely
  // don't exist on the returned object until onReady fires (the iframe is
  // still loading). Two loud samples in that window must not throw out of
  // the line-audio subscriber — that would break the Twilio SDK's volume
  // loop for the rest of the call (see line-audio.test.ts).
  function realisticFakeYT() {
    const created: Array<{ opts: YTPlayerOptions; player: YTPlayer & { calls: string[] } }> = [];
    class RealisticPlayer {
      calls: string[] = [];
      private state = -1;
      private o: YTPlayerOptions;
      constructor(_el: HTMLElement, o: YTPlayerOptions) {
        this.o = o;
        created.push({ opts: o, player: this as never });
        // The iframe "loads" 50ms later — only THEN do the real methods
        // become callable, exactly like the genuine YT.Player.
        setTimeout(() => {
          Object.assign(this, {
            playVideo: () => {
              this.calls.push('play');
              this.state = 1;
              this.o.events.onStateChange?.({ data: 1 });
            },
            pauseVideo: () => {
              this.calls.push('pause');
              this.state = 2;
              this.o.events.onStateChange?.({ data: 2 });
            },
            getPlayerState: () => this.state,
          });
          o.events.onReady?.({ target: this as never });
        }, 50);
      }
      setShuffle() { this.calls.push('shuffle'); }
      setLoop() { this.calls.push('loop'); }
      destroy() { this.calls.push('destroy'); }
    }
    return { ns: { Player: RealisticPlayer } as unknown as YTNamespace, created };
  }

  it('two loud line samples before the player is ready do not throw (the real API is not live until onReady)', async () => {
    const { ns, created } = realisticFakeYT();
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    // Flush only the loadApi microtask chain — the fake's onReady is behind a
    // REAL 50ms timer we deliberately have not advanced yet, so the player
    // exists but its methods (per the fake) are not live.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(created.length).toBe(1);

    expect(() => {
      act(() => { lineAudio.push(0.05); lineAudio.push(0.05); });
    }).not.toThrow();

    // A real call keeps sending samples — quiet ones follow, well before the
    // iframe finishes loading, so recentLevels reflects "quiet" by the time
    // it's ready (otherwise this proves nothing beyond "didn't throw").
    act(() => { lineAudio.push(0); lineAudio.push(0); });

    // Once ready (at 50ms) AND the line has been quiet long enough (1.5s),
    // the next evaluate (the periodic tick catches it) works normally.
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(created[0]!.player.calls).toContain('play');
  });

  // Fix round 2, item 3 (optional) — pins evaluate()'s `!ready` gate itself
  // (mutation X4). `realisticFakeYT`'s methods are simply ABSENT pre-ready,
  // so a call there throws (already caught by our own try/catches) rather
  // than being observable as a call — that's not sensitive enough to prove
  // the gate exists. This fake instead keeps the methods always present but
  // counts any invocation made before its own onReady fires, which is
  // observable regardless of how the caller handles a throw.
  function countingReadyGateYT() {
    let readyFired = false;
    let callsBeforeReady = 0;
    class Player {
      private state = -1;
      constructor(_el: HTMLElement, o: YTPlayerOptions) {
        setTimeout(() => {
          readyFired = true;
          o.events.onReady?.({ target: this as never });
        }, 50);
      }
      playVideo() { if (!readyFired) callsBeforeReady++; this.state = 1; }
      pauseVideo() { if (!readyFired) callsBeforeReady++; this.state = 2; }
      getPlayerState() { if (!readyFired) callsBeforeReady++; return this.state; }
      setShuffle() { if (!readyFired) callsBeforeReady++; }
      setLoop() { if (!readyFired) callsBeforeReady++; }
      destroy() {}
    }
    return { ns: { Player } as unknown as YTNamespace, callsBeforeReady: () => callsBeforeReady };
  }

  it('makes zero player method calls before onReady fires, even from a prop-triggered re-evaluation', async () => {
    const { ns, callsBeforeReady } = countingReadyGateYT();
    const { rerender } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // constructed, not yet ready (fires at +50ms)

    rerender(<YouTubeHoldPlayer {...baseProps({ currentItem: item('dialing', null, 'item-2') }, ns)} />);
    expect(callsBeforeReady()).toBe(0);
  });

  it('pauses immediately when PLAYING arrives while a heard-latch is active, rather than waiting for the next tick', async () => {
    const { ns, created } = fakeYT({ blockAutoplay: true });
    const lineAudio = createLineAudio();
    render(<YouTubeHoldPlayer {...baseProps({ lineAudio }, ns)} />);
    await flush();
    const entry = created[0]!;
    expect(entry.player.calls).toContain('play'); // attempted, but blocked (first-time)

    // Two loud samples: latches, and (a no-op call-wise on state, but still
    // invoked) pauses — this is what happens while the video is still
    // trying to start.
    act(() => { lineAudio.push(0.05); lineAudio.push(0.05); });
    const pauseCallsBefore = entry.player.calls.filter((c) => c === 'pause').length;

    // The player's own async start finally lands late, racing the latch —
    // simulate the real state catching up alongside the event.
    entry.player.state = YT_PLAYING;
    act(() => { entry.opts.events.onStateChange?.({ data: YT_PLAYING }); });

    // Must pause AT ONCE (synchronously with the event), not on some later tick.
    expect(entry.player.calls.at(-1)).toBe('pause');
    expect(entry.player.calls.filter((c) => c === 'pause').length).toBe(pauseCallsBefore + 1);
  });

  it('clears the error caption once PLAYING actually arrives (one unembeddable playlist video still lets the rest play)', async () => {
    const { ns, created } = fakeYT({ blockAutoplay: true });
    render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    act(() => { created[0]?.opts.events.onError?.({ data: 2 }); });
    expect(screen.getByText(CAPTION_ERROR)).toBeTruthy();

    act(() => { created[0]?.opts.events.onStateChange?.({ data: YT_PLAYING }); });
    expect(screen.queryByText(CAPTION_ERROR)).toBeNull();
    expect(screen.getByText(CAPTION_NORMAL)).toBeTruthy();
  });

  it('shows the error caption if the player never becomes ready within 15s of the API loading', async () => {
    class NeverReadyPlayer {
      setShuffle() {}
      setLoop() {}
      playVideo() {}
      pauseVideo() {}
      getPlayerState() { return -1; }
      destroy() {}
    }
    const ns = { Player: NeverReadyPlayer } as unknown as YTNamespace;
    render(
      <YouTubeHoldPlayer youtube={PLAYLIST_REF} sessionStatus="active" currentItem={item('dialing')} loadApi={() => Promise.resolve(ns)} />,
    );
    await flush(); // lets the player get constructed (still never calls onReady)

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText(CAPTION_ERROR)).toBeTruthy();
  });

  it('loops a video-in-a-playlist too, but does not shuffle it (shuffle is only for a pure playlist)', async () => {
    const { ns, created } = fakeYT();
    const ref: YouTubeRef = { listId: 'PLx1234567', videoId: 'dQw4w9WgXcQ' };
    render(<YouTubeHoldPlayer {...baseProps({ youtube: ref }, ns)} />);
    await flush();

    expect(created[0]?.player.calls).toContain('loop');
    expect(created[0]?.player.calls).not.toContain('shuffle');
  });

  it('mounts the player on a child div it creates itself, not the React-owned host node', async () => {
    let capturedEl: HTMLElement | null = null;
    class CapturingPlayer {
      constructor(el: HTMLElement) { capturedEl = el; }
      setShuffle() {}
      setLoop() {}
      playVideo() {}
      pauseVideo() {}
      getPlayerState() { return -1; }
      destroy() {}
    }
    const ns = { Player: CapturingPlayer } as unknown as YTNamespace;
    const { container } = render(<YouTubeHoldPlayer {...baseProps({}, ns)} />);
    await flush();

    const host = container.querySelector('.dp-youtube > div');
    expect(host).toBeTruthy();
    expect(capturedEl).not.toBeNull();
    expect(capturedEl).not.toBe(host); // React never owns the node YouTube replaces
    expect(host?.contains(capturedEl)).toBe(true); // but it IS a child of the host
  });
});

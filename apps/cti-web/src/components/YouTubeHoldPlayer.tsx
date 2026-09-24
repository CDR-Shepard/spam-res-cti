/**
 * YouTube's own embedded player, shown on the Power Dial screen when the rep
 * picked YouTube hold music — the only compliant way to play it (YouTube
 * forbids separating the audio from its own visible player). It plays while
 * the run rings the next number and pauses the instant someone answers, on
 * two triggers: the line-audio signal (instant — see `line-audio.ts`) and the
 * poll showing `connected` (a backup, in case the audio signal is late or the
 * SDK never fires it). It resumes once the run is dialing again and the line
 * has been quiet for `QUIET_BEFORE_RESUME_MS`.
 *
 * Browsers block a `playVideo()` call before the rep has interacted with the
 * page — so nothing auto-plays. The rep presses play once; after that we
 * drive it. See `evaluate()` below for the actual play/pause decision.
 */
import { useEffect, useRef, useState } from 'react';
import type { YouTubeRef } from '@cti/contracts';
import type { DialerCurrentItem, DialerSession } from '../dialer-api';
import { HEARD_SAMPLES, heardSomeone, shouldPlay } from '../hold-music-rules';
import type { LineAudio } from '../line-audio';
import { YT_BUFFERING, YT_PLAYING, loadYouTubeApi, playerOptionsFor, type YTNamespace, type YTPlayer } from '../youtube-api';

/** How often we re-check play/pause outside of the direct triggers (prop
 *  changes, the line-audio subscription) — this is what lets a resume happen
 *  once the quiet window has simply passed with nothing else changing. */
const RE_EVALUATE_MS = 500;

/** How long a `playVideo()` call gets to actually reach PLAYING before we tell
 *  the rep it looks stuck and ask them to press play themselves. */
const STUCK_AFTER_MS = 2000;

/** How long we give the player to fire `onReady` at all once the API script
 *  has loaded — a torn-down iframe or a dropped connection can mean it simply
 *  never comes, and the rep shouldn't be left staring at the first-time
 *  caption forever with no explanation. */
const READY_TIMEOUT_MS = 15_000;

/**
 * How long a "someone was heard" latch blocks a resume even after the line
 * goes quiet again and the poll hasn't yet confirmed the call ended. Must be
 * at least the poll's own abort timeout (`POLL_TIMEOUT_MS` in DialerPanel.tsx,
 * 10s) plus its slow cadence (`POLL_INTERVAL_MS`, 2s) — 12s — so a hung or
 * merely slow poll can never hold the latch past the point where the NEXT
 * poll would have told us the truth anyway. Below that, a real hung poll
 * could let music resume mid-conversation.
 */
const HEARD_LATCH_MAX_MS = 12_000;

const CAPTION_ERROR = "Couldn't load your YouTube playlist";
const CAPTION_FIRST_TIME = 'Press play once — after that it pauses and resumes by itself.';
const CAPTION_STUCK = 'Press play to resume';
const CAPTION_NORMAL = 'Pauses automatically when someone answers.';

export interface YouTubeHoldPlayerProps {
  youtube: YouTubeRef;
  sessionStatus: DialerSession['status'];
  // `id` is needed for the heard-latch (see `evaluate()`): it tells us
  // whether the poll has moved on to a genuinely new ring, vs. still
  // reporting the same one it always was.
  currentItem: Pick<DialerCurrentItem, 'id' | 'status' | 'prospectEndedAt'> | null;
  lineAudio?: LineAudio;
  /** Injected in tests; defaults to the real IFrame API loader. */
  loadApi?: () => Promise<YTNamespace>;
}

/** True for a playlist (with or without a starting video) — YouTube's `loop`
 *  param needs a list to loop across; a lone video loops via the
 *  `playlist=<id>` trick in `playerOptionsFor` instead. */
function hasPlaylist(ref: YouTubeRef): boolean {
  return Boolean(ref.listId);
}

/** True for a playlist with no starting video — the only case that should
 *  shuffle: a video-in-a-playlist should still start where the rep pointed
 *  it, just looping afterward. */
function isPurePlaylist(ref: YouTubeRef): boolean {
  return Boolean(ref.listId) && !ref.videoId;
}

/** What the poll had last told us when a line-audio "someone answered" signal
 *  latched the pause — see the `HEARD_LATCH_MAX_MS` comment above. */
interface HeardLatch {
  itemId: string | null;
  status: string | null;
  at: number;
}

export function YouTubeHoldPlayer(props: YouTubeHoldPlayerProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Read inside the mount-only effect below so a 1-2s poll re-render never
  // recreates the player — only the LATEST props matter to it.
  const propsRef = useRef(props);
  propsRef.current = props;

  const [error, setError] = useState(false);
  const [everPlayed, setEverPlayed] = useState(false);
  const [stuck, setStuck] = useState(false);

  // Re-evaluate whenever the inputs `shouldPlay` (or the heard-latch) cares
  // about change — the mount effect below hands this a stable function to
  // call. `currentItem?.id` is included so a poll that moves straight from
  // one ringing item to the next (same status, e.g. dialing -> dialing)
  // still clears a stale latch immediately instead of waiting on the tick.
  const evaluateRef = useRef<() => void>(() => {});
  useEffect(() => {
    evaluateRef.current();
  }, [props.sessionStatus, props.currentItem?.id, props.currentItem?.status, props.currentItem?.prospectEndedAt]);

  useEffect(() => {
    const mountedRef = { current: true };
    let destroyed = false;
    let player: YTPlayer | null = null;
    let ready = false;
    let everPlayedLocal = false;
    let recentLevels: number[] = [];
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;
    let readyTimeoutId: ReturnType<typeof setTimeout> | undefined;
    let heardLatch: HeardLatch | null = null;

    // React 18 no longer warns on a setState after unmount, but we still
    // guard it ourselves: a stray callback (a rejected load, a late event)
    // must never touch state once the panel is gone.
    const safeSetState = (fn: () => void): void => {
      if (mountedRef.current) fn();
    };

    const clearStuckTimer = (): void => {
      if (stuckTimer !== undefined) {
        clearTimeout(stuckTimer);
        stuckTimer = undefined;
      }
    };

    const clearReadyTimeout = (): void => {
      if (readyTimeoutId !== undefined) {
        clearTimeout(readyTimeoutId);
        readyTimeoutId = undefined;
      }
    };

    // The real IFrame API's returned object exists the instant `new
    // YT.Player(...)` returns, but its methods aren't actually live until
    // `onReady` fires (the iframe itself is still loading) — reading state
    // before then, or racing a torn-down player, can throw.
    const safeGetPlayerState = (): number => {
      if (!player) return -1;
      try {
        return player.getPlayerState();
      } catch {
        return -1;
      }
    };

    // YouTube's own player can throw from inside these calls (seen in the
    // wild for a torn-down iframe) — never let that crash the panel.
    const play = (): void => {
      try {
        player?.playVideo();
      } catch {
        // Swallowed — a YouTube-internal error here is not ours to recover.
      }
    };
    const pause = (): void => {
      try {
        player?.pauseVideo();
      } catch {
        // Swallowed — see `play` above.
      }
    };

    /** The one play/pause decision, run on prop changes, the line-audio
     *  signal, PLAYING itself, and a periodic tick (so a resume can happen on
     *  quiet alone). */
    const evaluate = (): void => {
      if (!ready || !player) return; // nothing to drive yet — wait for onReady
      const p = propsRef.current;
      const currentId = p.currentItem?.id ?? null;
      const currentStatus = p.currentItem?.status ?? null;

      // Drop a stale heard-latch: the poll has moved on (a new item, or the
      // SAME item settling into a different status — e.g. dialing ->
      // connected -> dialing again IS a new ring even though the id
      // happened to repeat), the session isn't active, or it's simply been
      // too long to trust (see the HEARD_LATCH_MAX_MS comment above).
      if (heardLatch) {
        const movedOn =
          currentId !== heardLatch.itemId || currentStatus !== heardLatch.status || p.sessionStatus !== 'active';
        const expired = Date.now() - heardLatch.at >= HEARD_LATCH_MAX_MS;
        if (movedOn || expired) heardLatch = null;
      }

      const lineQuietForMs = p.lineAudio?.quietForMs() ?? Infinity;
      const want =
        !heardLatch &&
        shouldPlay({ sessionStatus: p.sessionStatus, currentItem: p.currentItem, lineQuietForMs }) &&
        !heardSomeone(recentLevels);
      const state = safeGetPlayerState();

      if (!want) {
        if (state === YT_PLAYING) pause();
        // No resume attempt is in flight, so any pending "did it get stuck?"
        // check is now moot.
        clearStuckTimer();
        return;
      }
      if (state === YT_PLAYING) return; // already playing — nothing to do

      play();
      // Only arm a NEW stuck timer if one isn't already pending, or every
      // 500ms tick while blocked would keep resetting the 2s countdown and
      // "stuck" would never fire.
      if (everPlayedLocal && stuckTimer === undefined) {
        stuckTimer = setTimeout(() => {
          stuckTimer = undefined;
          if (safeGetPlayerState() !== YT_PLAYING) {
            safeSetState(() => setStuck(true));
          }
        }, STUCK_AFTER_MS);
      }
    };
    evaluateRef.current = evaluate;

    const handleReady = (e: { target: YTPlayer }): void => {
      ready = true;
      player = e.target;
      clearReadyTimeout();
      const ref = propsRef.current.youtube;
      if (hasPlaylist(ref)) {
        try {
          player.setLoop(true);
        } catch {
          // Non-fatal — loop just won't apply.
        }
      }
      if (isPurePlaylist(ref)) {
        try {
          player.setShuffle(true);
        } catch {
          // Non-fatal — shuffle just won't apply.
        }
      }
      evaluate();
    };

    const handleStateChange = (e: { data: number }): void => {
      if (e.data === YT_PLAYING) {
        everPlayedLocal = true;
        clearStuckTimer();
        safeSetState(() => {
          setEverPlayed(true);
          setStuck(false);
          // One unembeddable video in an otherwise-fine playlist fires
          // onError and then keeps playing the rest — don't leave a stale
          // error caption up once we're demonstrably playing again.
          setError(false);
        });
        // Re-check right away: if someone was heard just as PLAYING landed
        // (a real async race), this pauses it instantly instead of waiting
        // for the next 500ms tick.
        evaluate();
      }
    };

    const handleError = (): void => {
      safeSetState(() => setError(true));
    };

    const options = {
      height: '200',
      width: '100%',
      host: 'https://www.youtube-nocookie.com',
      ...playerOptionsFor(propsRef.current.youtube),
      events: { onReady: handleReady, onStateChange: handleStateChange, onError: handleError },
    };

    const load = propsRef.current.loadApi ? propsRef.current.loadApi() : loadYouTubeApi();
    load
      .then((ns) => {
        if (destroyed || !hostRef.current) return;
        // A node WE own and hand to YouTube, never the React-owned host div
        // itself — the real Player REPLACES its target element with an
        // iframe, and React must never be surprised to find its own node
        // gone out from under it.
        const mountNode = document.createElement('div');
        hostRef.current.appendChild(mountNode);
        player = new ns.Player(mountNode, options);
        readyTimeoutId = setTimeout(() => {
          readyTimeoutId = undefined;
          if (!ready) safeSetState(() => setError(true));
        }, READY_TIMEOUT_MS);
      })
      .catch(() => {
        safeSetState(() => setError(true));
      });

    const unsubscribe = propsRef.current.lineAudio?.subscribe((level) => {
      recentLevels = [...recentLevels, level].slice(-HEARD_SAMPLES);
      // The real API's methods aren't live until onReady (see
      // `safeGetPlayerState` above) — never even attempt to act before that.
      // `line-audio.ts`'s `push` also try/catches each listener as a second
      // line of defense, so a bug here can never stop the SDK's volume loop.
      if (!ready || !player) return;
      if (!heardSomeone(recentLevels)) return;
      // Latch on every heard event regardless of player state — a voice on
      // the line is true whether or not we're currently playing.
      const p = propsRef.current;
      heardLatch = { itemId: p.currentItem?.id ?? null, status: p.currentItem?.status ?? null, at: Date.now() };
      // But only actually PAUSE while playing or buffering: once PLAYING
      // triggers its own evaluate() (see handleStateChange), the ONLY reason
      // to pause from here is a player that's already audible. Twilio fires
      // ~19 volume samples/sec while the prospect talks, and recentLevels
      // stays "heard" for all of them — pausing unconditionally on each one
      // was pause-spamming the iframe with ~19 pauseVideo() calls/sec for the
      // whole conversation.
      const s = safeGetPlayerState();
      if (s === YT_PLAYING || s === YT_BUFFERING) pause();
    });

    const intervalId = setInterval(evaluate, RE_EVALUATE_MS);

    return () => {
      mountedRef.current = false;
      destroyed = true;
      clearInterval(intervalId);
      clearStuckTimer();
      clearReadyTimeout();
      unsubscribe?.();
      if (player) {
        try {
          player.destroy();
        } catch {
          // Non-fatal — the iframe is going away regardless.
        }
      }
    };
    // Mount-only: the player is created once and driven entirely through
    // `propsRef` and the prop-change effect above, so re-renders never
    // recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const caption = error ? CAPTION_ERROR : !everPlayed ? CAPTION_FIRST_TIME : stuck ? CAPTION_STUCK : CAPTION_NORMAL;

  return (
    <div className="section dp-youtube">
      <div ref={hostRef} />
      <div className="dp-youtube-caption">{caption}</div>
    </div>
  );
}

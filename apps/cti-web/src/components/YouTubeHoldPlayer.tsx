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
import { YT_PLAYING, loadYouTubeApi, playerOptionsFor, type YTNamespace, type YTPlayer } from '../youtube-api';

/** How often we re-check play/pause outside of the direct triggers (prop
 *  changes, the line-audio subscription) — this is what lets a resume happen
 *  once the quiet window has simply passed with nothing else changing. */
const RE_EVALUATE_MS = 500;

/** How long a `playVideo()` call gets to actually reach PLAYING before we tell
 *  the rep it looks stuck and ask them to press play themselves. */
const STUCK_AFTER_MS = 2000;

const CAPTION_ERROR = "Couldn't load your YouTube playlist";
const CAPTION_FIRST_TIME = 'Press play once — after that it pauses and resumes by itself.';
const CAPTION_STUCK = 'Press play to resume';
const CAPTION_NORMAL = 'Pauses automatically when someone answers.';

export interface YouTubeHoldPlayerProps {
  youtube: YouTubeRef;
  sessionStatus: DialerSession['status'];
  currentItem: Pick<DialerCurrentItem, 'status' | 'prospectEndedAt'> | null;
  lineAudio?: LineAudio;
  /** Injected in tests; defaults to the real IFrame API loader. */
  loadApi?: () => Promise<YTNamespace>;
}

/** True for a playlist with no starting video — the only case that should
 *  shuffle and loop, since a single video already loops via `playerOptionsFor`
 *  and a video-in-a-playlist should play the playlist in its own order. */
function isPurePlaylist(ref: YouTubeRef): boolean {
  return Boolean(ref.listId) && !ref.videoId;
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

  // Re-evaluate whenever the inputs `shouldPlay` cares about change — the
  // mount effect below hands this a stable function to call.
  const evaluateRef = useRef<() => void>(() => {});
  useEffect(() => {
    evaluateRef.current();
  }, [props.sessionStatus, props.currentItem?.status, props.currentItem?.prospectEndedAt]);

  useEffect(() => {
    const mountedRef = { current: true };
    let destroyed = false;
    let player: YTPlayer | null = null;
    let ready = false;
    let everPlayedLocal = false;
    let recentLevels: number[] = [];
    let stuckTimer: ReturnType<typeof setTimeout> | undefined;

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
     *  signal, and a periodic tick (so a resume can happen on quiet alone). */
    const evaluate = (): void => {
      if (!ready || !player) return; // nothing to drive yet — wait for onReady
      const p = propsRef.current;
      const lineQuietForMs = p.lineAudio?.quietForMs() ?? Infinity;
      const want =
        shouldPlay({ sessionStatus: p.sessionStatus, currentItem: p.currentItem, lineQuietForMs }) &&
        !heardSomeone(recentLevels);
      const state = player.getPlayerState();

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
          if (player && player.getPlayerState() !== YT_PLAYING) {
            safeSetState(() => setStuck(true));
          }
        }, STUCK_AFTER_MS);
      }
    };
    evaluateRef.current = evaluate;

    const handleReady = (e: { target: YTPlayer }): void => {
      ready = true;
      player = e.target;
      if (isPurePlaylist(propsRef.current.youtube)) {
        try {
          player.setShuffle(true);
        } catch {
          // Non-fatal — shuffle just won't apply.
        }
        try {
          player.setLoop(true);
        } catch {
          // Non-fatal — loop just won't apply.
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
        });
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
        player = new ns.Player(hostRef.current, options);
      })
      .catch(() => {
        safeSetState(() => setError(true));
      });

    const unsubscribe = propsRef.current.lineAudio?.subscribe((level) => {
      recentLevels = [...recentLevels, level].slice(-HEARD_SAMPLES);
      if (heardSomeone(recentLevels) && player && player.getPlayerState() === YT_PLAYING) {
        pause();
      }
    });

    const intervalId = setInterval(evaluate, RE_EVALUATE_MS);

    return () => {
      mountedRef.current = false;
      destroyed = true;
      clearInterval(intervalId);
      clearStuckTimer();
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

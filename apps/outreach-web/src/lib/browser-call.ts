/**
 * "Talk in browser" (plan 1E, spec §5.4): the AI calls this browser tab and the tab answers on its own.
 *
 * One run: ask for the microphone, fetch an incoming-only Voice token (it can never dial out), register a Twilio Device
 * under the run's fresh `aitest_…` identity, ask outreach-api to place the practice call to that identity, and accept the
 * first incoming call. The token lives only inside the run (never in state, logs or the query cache), and the Device is
 * destroyed when the call ends or the page goes away. The Voice SDK is loaded with a dynamic import, only when needed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError } from './api';
import { practiceAnswerWords } from './call-words';
import { browserToken, recordTestCall } from './outreach-api';
import { errorText } from './outreach-words';
import { recordTestErrorText } from './record-test-words';
import { CALL_ERROR_WORDS, INSECURE_CONTEXT, micErrorWords, NO_RING_WORDS, REGISTER_WORDS } from './browser-call-words';

export { micErrorWords } from './browser-call-words';

export type BrowserCallState =
  | { phase: 'idle' } | { phase: 'mic' } | { phase: 'registering' } | { phase: 'placing' }
  | { phase: 'ringing' } | { phase: 'live'; since: number; muted: boolean }
  | { phase: 'ended'; reason: 'hung_up' | 'remote' | 'no_ring' | 'refused' | 'error'; words?: string };
type EndReason = Extract<BrowserCallState, { phase: 'ended' }>['reason'];

/** The parts of the Voice SDK's Call and Device this hook uses (handlers take varied arguments, hence `any`). */
export interface CallLike { accept(): void; mute(muted: boolean): void; disconnect(): void; reject?(): void; on(ev: string, fn: (...a: any[]) => void): void }
export interface DeviceLike { register(): Promise<void>; destroy(): void; on(ev: string, fn: (...a: any[]) => void): void }
export type DeviceCtor = new (token: string, opts: object) => DeviceLike;

export interface BrowserCallDeps {
  loadDevice: () => Promise<DeviceCtor>;
  /** Ask for the microphone, then release it: the SDK opens its own stream. */
  getMic: () => Promise<void>;
  isSupported: () => Promise<boolean>;
}

export const REGISTER_LIMIT_MS = 15_000;
export const RING_WAIT_MS = 45_000;
/** Never DEBUG (1): at that level the SDK logs every message it sends, the token included (G-4). 'error' is its default. */
export const DEVICE_OPTIONS = { logLevel: 'error' } as const;

const voiceSdk = () => import('@twilio/voice-sdk');

export const defaultBrowserCallDeps: BrowserCallDeps = {
  loadDevice: () => voiceSdk().then((m) => m.Device as unknown as DeviceCtor),
  getMic: async () => {
    // Browsers hide mediaDevices on a page that is not https (or localhost).
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('not a secure context', INSECURE_CONTEXT);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  },
  isSupported: () => voiceSdk().then((m) => m.Device.isSupported),
};

/** One run's live objects. The token is not among them: it is used once, to build the Device. */
interface Run {
  device: DeviceLike | null;
  call: CallLike | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Settles a pending registration wait when the run stops early. */
  wake: (() => void) | null;
  ended: boolean;
  muted: boolean;
}

function stopRun(r: Run): void {
  r.ended = true;
  if (r.timer) clearTimeout(r.timer);
  r.timer = null;
  r.wake?.();
  const device = r.device;
  r.device = null;
  r.call = null;
  try { device?.destroy(); } catch { /* already gone */ }
}

export function useBrowserCall(testId: string, deps: BrowserCallDeps = defaultBrowserCallDeps) {
  const [state, setState] = useState<BrowserCallState>({ phase: 'idle' });
  const [supported, setSupported] = useState<boolean | null>(null);
  const runRef = useRef<Run | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    let current = true;
    deps.isSupported().then((ok) => { if (current) setSupported(ok); }, () => { if (current) setSupported(false); });
    return () => { current = false; };
  }, [deps]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (runRef.current) stopRun(runRef.current);
    };
  }, []);

  const show = (r: Run, s: BrowserCallState): void => { if (mounted.current && runRef.current === r) setState(s); };
  const end = (r: Run, reason: EndReason, words?: string): void => {
    if (r.ended) return;
    stopRun(r);
    show(r, words ? { phase: 'ended', reason, words } : { phase: 'ended', reason });
  };

  const onIncoming = (r: Run, call: CallLike): void => {
    if (r.ended || r.call) { try { call.reject?.(); } catch { /* ignore */ } return; }
    r.call = call;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    call.on('accept', () => { if (!r.ended) show(r, { phase: 'live', since: Date.now(), muted: false }); });
    for (const ev of ['disconnect', 'cancel', 'reject']) call.on(ev, () => end(r, 'remote'));
    call.on('error', () => end(r, 'error', CALL_ERROR_WORDS));
    try { call.accept(); } catch { end(r, 'error', CALL_ERROR_WORDS); }
  };

  /** Builds the Device under the run's token and listens for the AI's call; null (the run ended) when anything throws. */
  const build = async (r: Run): Promise<{ device: DeviceLike; identity: string } | null> => {
    let token: string;
    let identity: string;
    let Device: DeviceCtor;
    try {
      ({ token, identity } = await browserToken());
      Device = await deps.loadDevice();
    } catch (err) {
      end(r, 'error', errorText(err));
      return null;
    }
    if (r.ended) return null;
    try {
      const device = new Device(token, DEVICE_OPTIONS);
      r.device = device;
      device.on('incoming', (call: CallLike) => onIncoming(r, call));
      return { device, identity };
    } catch {
      end(r, 'error', REGISTER_WORDS);
      return null;
    }
  };

  /** Token → Device → registered (within 15 s). The identity on success; null once the run has ended. */
  const register = async (r: Run): Promise<string | null> => {
    const built = await build(r);
    if (!built) return null;
    const { device, identity } = built;
    const registered = await new Promise<boolean>((resolve) => {
      r.wake = () => resolve(false);
      r.timer = setTimeout(() => resolve(false), REGISTER_LIMIT_MS);
      try {
        device.on('registered', () => resolve(true));
        device.on('error', () => { if (!r.call) resolve(false); });
        device.register().catch(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
    r.wake = null;
    if (r.timer) clearTimeout(r.timer);
    r.timer = null;
    if (r.ended) return null;
    if (!registered) { end(r, 'error', REGISTER_WORDS); return null; }
    return identity;
  };

  const place = async (r: Run, identity: string): Promise<void> => {
    let answer;
    try {
      answer = await recordTestCall(testId, { mode: 'browser', identity });
    } catch (err) {
      end(r, err instanceof ApiRequestError ? 'refused' : 'error', recordTestErrorText(err));
      return;
    }
    if (r.ended) return;
    if (answer.response.result !== 'placed') { end(r, 'refused', practiceAnswerWords(answer.response)); return; }
    if (r.call) return; // The AI rang before the answer came back: already live.
    show(r, { phase: 'ringing' });
    r.timer = setTimeout(() => end(r, 'no_ring', NO_RING_WORDS), RING_WAIT_MS);
  };

  const start = async (): Promise<void> => {
    if (runRef.current && !runRef.current.ended) return;
    const r: Run = { device: null, call: null, timer: null, wake: null, ended: false, muted: false };
    runRef.current = r;
    show(r, { phase: 'mic' });
    try { await deps.getMic(); } catch (err) { end(r, 'refused', micErrorWords(err)); return; }
    if (r.ended) return;
    try {
      show(r, { phase: 'registering' });
      const identity = await register(r);
      if (!identity || r.ended) return;
      show(r, { phase: 'placing' });
      await place(r, identity);
    } catch {
      // A belt: nothing above should throw, but a run must never sit in a phase with no way out.
      end(r, 'error', CALL_ERROR_WORDS);
    }
  };

  const hangUp = useCallback((): void => {
    const r = runRef.current;
    if (!r || r.ended) return;
    try { r.call?.disconnect(); } catch { /* already gone */ }
    end(r, 'hung_up');
    // `end` is recreated each render but only reads refs, so this callback never goes stale.
  }, []);

  const toggleMute = useCallback((): void => {
    const r = runRef.current;
    if (!r || r.ended || !r.call) return;
    r.muted = !r.muted;
    try { r.call.mute(r.muted); } catch { /* the call is ending */ }
    setState((s) => (s.phase === 'live' ? { ...s, muted: r.muted } : s));
  }, []);

  return { state, start, hangUp, toggleMute, supported };
}

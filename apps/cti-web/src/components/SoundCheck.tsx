import { useEffect, useMemo, useState } from 'react';
import type { AudioDevicePort } from '../audio-device-port';
import { loadAudioPrefs, type AudioPrefs } from '../audio-devices';
import { METER_INTERVAL_MS, type LevelSource, type MicStreamLike } from '../level-meter';
import { browserSoundCheckEnv, micErrorText, stopStream, type MicPermission, type SoundCheckEnv } from '../sound-check-env';
import { AudioDeviceRows } from './AudioDeviceRows';

type Toast = (t: { text: string; type: 'info' | 'error' | 'success' }) => void;

interface Props {
  port: AudioDevicePort;
  onToast: Toast;
  /** "Looks good": the check is finished (App clears the due flag). */
  onDone: () => void;
  /** "Not now": closed for now; a due check comes back on the next load. */
  onLater: () => void;
  /** The browser (tests hand in a fake). */
  env?: SoundCheckEnv;
}

/** Rep-facing text (exact). */
export const SOUND_CHECK_TEXT = {
  checking: 'Checking your microphone…',
  promptTitle: 'Allow your microphone',
  promptBody: "The softphone needs your microphone for calls. Click below, then choose Allow in Chrome's popup.",
  allow: 'Allow microphone',
  deniedTitle: 'Your microphone is blocked',
  deniedBody: 'Chrome is blocking the microphone for the softphone. Click the icon left of the address bar → Microphone → Allow. This screen updates by itself.',
  allowed: '✓ Microphone allowed',
  grantedTitle: 'Sound check',
  speak: 'Say something — the bar should move.',
  done: 'Looks good',
  later: 'Not now',
} as const;

/**
 * The sound check (spec decision 6): one screen for whichever of Chrome's
 * three microphone states applies. App mounts it as a full-screen overlay,
 * both after a reset's sign-in and from Settings, and unmounts it whenever a
 * call rings. Unmounting stops the stream, so the mic is never left open.
 */
export function SoundCheck({ port, onToast, onDone, onLater, env: injected }: Props): JSX.Element {
  const env = useMemo(() => injected ?? browserSoundCheckEnv(), [injected]);
  const [permission, setPermission] = useState<MicPermission | 'checking'>('checking');
  const [justAllowed, setJustAllowed] = useState(false);
  const [micId, setMicId] = useState<string | null>(() => loadAudioPrefs().input);
  const [level, setLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  // Chrome's setting, live: Blocked → Allowed flips this screen with no reload.
  useEffect(() => {
    let live = true;
    let stop = (): void => {};
    void env.watchPermission((p) => {
      if (!live) return;
      if (p === 'granted') setJustAllowed(true);
      setPermission(p);
    }).then(
      (w) => {
        if (!live) { w.stop(); return; }
        stop = w.stop;
        setPermission(w.state);
      },
      () => { if (live) setPermission('prompt'); },
    );
    return () => { live = false; stop(); };
  }, [env]);

  // The meter: the chosen mic is open only while Allowed and on screen.
  useEffect(() => {
    if (permission !== 'granted') return;
    let live = true;
    let stream: MicStreamLike | null = null;
    let source: LevelSource | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    env.openMic(micId).then(
      (opened) => {
        if (!live) { stopStream(opened); return; } // closed while opening: release it at once
        stream = opened;
        const meter = env.createLevelSource(opened);
        source = meter;
        setMicError(null);
        timer = setInterval(() => setLevel(meter.read()), METER_INTERVAL_MS);
      },
      (e: unknown) => { if (live) setMicError(micErrorText(e)); },
    );
    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
      source?.close();
      if (stream) stopStream(stream);
    };
  }, [permission, micId, env]);

  // "Allow microphone": the click is the user gesture Chrome's popup needs.
  const allow = async (): Promise<void> => {
    setAsking(true);
    setMicError(null);
    try {
      // Only asking for permission here; the meter opens the chosen mic next.
      stopStream(await env.openMic(null));
      setJustAllowed(true);
      setPermission('granted');
    } catch (e) {
      setMicError(micErrorText(e));
    } finally {
      setAsking(false);
    }
  };

  const pct = Math.round(level * 100);
  return (
    <div className="sound-check" role="dialog" aria-modal="true" aria-label="Sound check">
      <div className="sound-check-card">
        {permission === 'checking' && <p className="sub">{SOUND_CHECK_TEXT.checking}</p>}
        {permission === 'prompt' && (
          <>
            <h2>{SOUND_CHECK_TEXT.promptTitle}</h2>
            <p className="sub">{SOUND_CHECK_TEXT.promptBody}</p>
            <button className="btn primary full" disabled={asking} onClick={() => void allow()}>{SOUND_CHECK_TEXT.allow}</button>
          </>
        )}
        {permission === 'denied' && (
          <>
            <h2>{SOUND_CHECK_TEXT.deniedTitle}</h2>
            <p className="sub">{SOUND_CHECK_TEXT.deniedBody}</p>
          </>
        )}
        {permission === 'granted' && (
          <>
            <h2>{SOUND_CHECK_TEXT.grantedTitle}</h2>
            {justAllowed && <p className="sound-check-ok">{SOUND_CHECK_TEXT.allowed}</p>}
            <p className="sub">{SOUND_CHECK_TEXT.speak}</p>
            <div
              className="sound-check-meter"
              role="progressbar"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="sound-check-meter-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="set-list">
              <AudioDeviceRows port={port} onToast={onToast} onChange={(p: AudioPrefs) => setMicId(p.input)} />
            </div>
            <button className="btn primary full" onClick={onDone}>{SOUND_CHECK_TEXT.done}</button>
          </>
        )}
        {micError && <p className="set-error" role="alert">{micError}</p>}
        <button className="btn ghost full" onClick={onLater}>{SOUND_CHECK_TEXT.later}</button>
      </div>
    </div>
  );
}

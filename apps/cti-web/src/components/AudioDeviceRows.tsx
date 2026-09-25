import { useCallback, useEffect, useState } from 'react';
import {
  AUDIO_INPUT_KEY,
  AUDIO_OUTPUT_KEY,
  SYSTEM_DEFAULT,
  deviceIds,
  deviceOptions,
  effectiveDeviceId,
  labelsHidden,
  loadAudioPrefs,
  saveAudioPrefs,
  type AudioDeviceKind,
  type AudioPrefs,
  type DeviceOption,
  type MediaDeviceLike,
} from '../audio-devices';
import type { AudioDevicePort } from '../audio-device-port';
import { MicIcon, SpeakerIcon } from '../icons';

type Toast = (t: { text: string; type: 'info' | 'error' | 'success' }) => void;

interface Props {
  port: AudioDevicePort;
  onToast: Toast;
}

const MISSING_NOTE = 'Saved device not connected — using system default';
const NEEDS_PERMISSION = 'Allow microphone access to see device names';
const MIC_STAYS_OPEN = 'Choosing a specific microphone keeps it open while the softphone runs (Chrome shows the recording dot; '
  + "Bluetooth headsets stay in call mode). Leave System default unless callers can't hear you.";
const OUTPUT_UNSUPPORTED ="Your browser picks the speaker (change it in your computer's sound settings)";
const NOUN: Record<AudioDeviceKind, string> = { audioinput: 'microphone', audiooutput: 'speaker' };

interface RowState {
  options: DeviceOption[];
  /** The option shown selected: the device actually in use. */
  value: string;
  /** Device names are hidden until the page has microphone permission. */
  hidden: boolean;
  /** The saved device isn't connected; the system default is used meanwhile. */
  missing: boolean;
}

/** `devices` is null until the first listing arrives — until then nothing is
 *  claimed missing (we don't know yet). With names hidden, ids are too, so
 *  "missing" can't be judged either. */
function rowState(devices: MediaDeviceLike[] | null, kind: AudioDeviceKind, saved: string | null): RowState {
  const listed = devices ?? [];
  const hidden = labelsHidden(listed, kind);
  const known = devices !== null && !hidden;
  const effective = effectiveDeviceId(saved, deviceIds(listed, kind));
  return {
    options: deviceOptions(listed, kind),
    value: known ? effective.deviceId : SYSTEM_DEFAULT,
    hidden,
    missing: known && effective.missing,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'the browser refused it';
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Microphone and Speaker rows for Settings.
 *
 * WHY (2026-09-25): a rep couldn't hear callers and callers couldn't hear him,
 * while YouTube played through his headset. Voice Insights showed media
 * connected both ways, then constant-audio-input-level (his mic captured
 * silence) and constant-audio-output-level — the softphone was on a different
 * device than the headset he was wearing. Reps now pick both here; the choice
 * is saved in this browser and applied to the live Twilio Device.
 */
export function AudioDeviceRows({ port, onToast }: Props): JSX.Element {
  const [devices, setDevices] = useState<MediaDeviceLike[] | null>(null);
  const [prefs, setPrefs] = useState<AudioPrefs>(() => loadAudioPrefs());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      port.listDevices().then(
        (list) => { if (live) setDevices(list); },
        // Enumeration refused: leave the list "unknown" (System default only,
        // no false "not connected" note) — the next devicechange retries.
        () => { if (live) setDevices(null); },
      );
    };
    refresh();
    const off = port.onDeviceChange(refresh);
    return () => { live = false; off(); };
  }, [port]);

  const input = rowState(devices, 'audioinput', prefs.input);
  const output = rowState(devices, 'audiooutput', prefs.output);
  const canChooseOutput = port.canChooseOutput();

  // A choice made in another tab (the storage event only fires in the OTHER
  // tabs): show it here too, so no tab claims a device that isn't in use.
  useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === AUDIO_INPUT_KEY || e.key === AUDIO_OUTPUT_KEY) setPrefs(loadAudioPrefs());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const choose = useCallback(async (kind: AudioDeviceKind, value: string, options: DeviceOption[]) => {
    const previous = prefs;
    const choice = value === SYSTEM_DEFAULT ? null : value;
    const next: AudioPrefs = kind === 'audioinput' ? { ...prefs, input: choice } : { ...prefs, output: choice };
    // Saved BEFORE the switch so a device-change re-apply racing it (App's
    // keepSavedAudioPrefs) re-applies the new choice, not the old one.
    setPrefs(next);
    const remembered = saveAudioPrefs(next);
    const label = options.find((o) => o.value === value)?.label ?? 'System default';
    setBusy(true);
    try {
      if (kind === 'audioinput') await (choice ? port.setInputDevice(choice) : port.unsetInputDevice());
      else await port.setOutputDevice(choice ?? SYSTEM_DEFAULT);
      onToast(remembered
        ? { text: `${capitalize(NOUN[kind])}: ${label}.`, type: 'success' }
        : { text: `${capitalize(NOUN[kind])}: ${label} — this browser won't remember it after a reload.`, type: 'info' });
    } catch (e) {
      // The Device refused it and is still on the previous device: put the
      // select and the saved choice back so neither claims otherwise.
      setPrefs(previous);
      saveAudioPrefs(previous);
      onToast({ text: `Couldn't switch to that ${NOUN[kind]}: ${errorText(e)}`, type: 'error' });
    } finally {
      setBusy(false);
    }
  }, [prefs, port, onToast]);

  const playTest = useCallback(async () => {
    try {
      await port.playTestSound(output.value);
    } catch (e) {
      onToast({ text: `Couldn't play the test sound: ${errorText(e)}`, type: 'error' });
    }
  }, [port, output.value, onToast]);

  const notes = (row: RowState): JSX.Element => (
    <>
      {row.hidden && <div className="sub">{NEEDS_PERMISSION}</div>}
      {row.missing && <div className="set-note">{MISSING_NOTE}</div>}
    </>
  );

  return (
    <>
      <div className="set-row">
        <div className="icon"><MicIcon /></div>
        <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="name">Microphone</div>
          <div className="sub">What callers hear you through. If they can't hear you, pick your headset.</div>
          <select
            aria-label="Microphone"
            className="set-select"
            value={input.value}
            disabled={busy}
            onChange={(e) => void choose('audioinput', e.target.value, input.options)}
          >
            {input.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {notes(input)}
          {/* setInputDevice holds the chosen mic's capture until it is unset. */}
          <div className="sub">{MIC_STAYS_OPEN}</div>
        </div>
      </div>
      <div className="set-row">
        <div className="icon"><SpeakerIcon /></div>
        <div className="label" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="name">Speaker</div>
          {canChooseOutput ? (
            <>
              <div className="sub">Where you hear callers and the ring. If you can't hear callers, pick your headset.</div>
              <select
                aria-label="Speaker"
                className="set-select"
                value={output.value}
                disabled={busy}
                onChange={(e) => void choose('audiooutput', e.target.value, output.options)}
              >
                {output.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              {notes(output)}
              <div>
                <button className="btn ghost" style={{ padding: '2px 10px', fontSize: 11 }} onClick={() => void playTest()}>
                  Play test sound
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="sub">{OUTPUT_UNSUPPORTED}</div>
              <select aria-label="Speaker" className="set-select" value={SYSTEM_DEFAULT} disabled>
                <option value={SYSTEM_DEFAULT}>System default</option>
              </select>
            </>
          )}
        </div>
      </div>
    </>
  );
}

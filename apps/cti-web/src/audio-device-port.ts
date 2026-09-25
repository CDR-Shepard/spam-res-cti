/**
 * Microphone / speaker choice — the side that touches the browser and the
 * Twilio Device. The decisions live in audio-devices.ts; this applies them.
 *
 * WHY (2026-09-25): a rep's softphone captured from, and played to, a
 * different device than the headset he was wearing (Voice Insights:
 * constant-audio-input-level + constant-audio-output-level on a call whose
 * media connected fine). Reps choose both in Settings, and the choice is
 * applied to the one persistent Device — which also carries the power-dialer
 * conference leg, so that leg gets the same devices.
 *
 * Twilio @twilio/voice-sdk 2.18.3 calls used (es5/twilio/audiohelper.d.ts,
 * es5/twilio/outputdevicecollection.d.ts):
 *   device.audio.setInputDevice(id)        swaps the mic, live call included
 *   device.audio.unsetInputDevice()        back to the per-call default stream;
 *                                          REJECTED while a call is up
 *   device.audio.speakerDevices.set(id)    call audio + SDK sounds, live call included
 *   device.audio.ringtoneDevices.set(id)   the incoming ring
 *   device.audio.isOutputSelectionSupported / availableInput|OutputDevices
 */
import type { AudioHelperLike } from './audio-readiness';
import {
  AUDIO_INPUT_KEY,
  AUDIO_OUTPUT_KEY,
  SYSTEM_DEFAULT,
  effectiveDeviceId,
  systemDefaultDeviceId,
  type AudioPrefs,
  type MediaDeviceLike,
} from './audio-devices';

/** Twilio OutputDeviceCollection (`speakerDevices` / `ringtoneDevices`). */
export interface OutputDevicesLike {
  get(): Set<{ deviceId: string }>;
  set(deviceIdOrIds: string | string[]): Promise<void>;
}

/** The Twilio AudioHelper (`device.audio`) surface device choice needs. The
 *  optional members can be missing on a partial fake; every use guards. */
export interface DeviceAudioLike extends AudioHelperLike {
  availableOutputDevices?: Map<string, { deviceId: string }>;
  isOutputSelectionSupported?: boolean;
  unsetInputDevice?(): Promise<void>;
  speakerDevices?: OutputDevicesLike;
  ringtoneDevices?: OutputDevicesLike;
}

/** What happened to one direction when saved choices were applied. */
export type ApplyOutcome = 'default' | 'applied' | 'unchanged' | 'missing' | 'skipped' | 'failed';

export interface AudioApplyResult {
  input: ApplyOutcome;
  output: ApplyOutcome;
}

function outputIds(audio: DeviceAudioLike): string[] {
  return [...(audio.availableOutputDevices?.keys() ?? [])];
}

/** The collections a speaker choice goes to, or [] where the browser (per the
 *  SDK) can't route output. */
function outputCollections(audio: DeviceAudioLike): OutputDevicesLike[] {
  if (audio.isOutputSelectionSupported === false) return [];
  return [audio.speakerDevices, audio.ringtoneDevices]
    .filter((c): c is OutputDevicesLike => !!c && typeof c.set === 'function');
}

function isExactly(active: Set<{ deviceId: string }>, deviceId: string): boolean {
  return active.size === 1 && [...active][0]?.deviceId === deviceId;
}

/**
 * The rep picked a mic (or "System default", null) in Settings. Rejects when
 * the SDK refuses the device, so Settings can say so.
 */
export async function chooseInput(audio: DeviceAudioLike, deviceId: string | null): Promise<void> {
  if (deviceId && deviceId !== SYSTEM_DEFAULT) {
    await audio.setInputDevice(deviceId);
    return;
  }
  // Nothing pinned: the SDK already opens the system default for each call.
  if (!audio.inputDevice) return;
  if (typeof audio.unsetInputDevice === 'function') {
    try {
      await audio.unsetInputDevice();
      return;
    } catch {
      // Refused during a live call ("Cannot unset input device while a call is
      // in progress") — fall through and pin the system default instead, which
      // is what watchLocalMic does and what the SDK supports mid-call.
    }
  }
  const target = systemDefaultDeviceId([...audio.availableInputDevices.keys()]);
  if (target && audio.inputDevice?.deviceId !== target) await audio.setInputDevice(target);
}

/** The rep picked a speaker (or "System default", null) in Settings. Call
 *  audio and the ring both go there. Rejects when the SDK refuses. */
export async function chooseOutput(audio: DeviceAudioLike, deviceId: string | null): Promise<void> {
  const collections = outputCollections(audio);
  if (!collections.length) return;
  const target = deviceId && deviceId !== SYSTEM_DEFAULT ? deviceId : systemDefaultDeviceId(outputIds(audio));
  if (!target) return;
  await Promise.all(collections.map((c) => c.set(target)));
}

async function applyInput(audio: DeviceAudioLike, saved: string | null, include: boolean): Promise<ApplyOutcome> {
  if (!saved) return 'default';
  if (!include) return 'skipped';
  const { deviceId, missing } = effectiveDeviceId(saved, [...audio.availableInputDevices.keys()]);
  if (missing) return 'missing';
  if (audio.inputDevice?.deviceId === deviceId) return 'unchanged';
  try {
    await audio.setInputDevice(deviceId);
    return 'applied';
  } catch {
    return 'failed';
  }
}

async function applyOutput(audio: DeviceAudioLike, saved: string | null): Promise<ApplyOutcome> {
  if (!saved) return 'default';
  const collections = outputCollections(audio);
  if (!collections.length) return 'skipped';
  const { deviceId, missing } = effectiveDeviceId(saved, outputIds(audio));
  if (missing) return 'missing';
  const stale = collections.filter((c) => !isExactly(c.get(), deviceId));
  if (!stale.length) return 'unchanged';
  try {
    await Promise.all(stale.map((c) => c.set(deviceId)));
    return 'applied';
  } catch {
    return 'failed';
  }
}

/**
 * Put the saved choices on a Device that was just created or whose device
 * list just changed. Only acts on a SAVED device that is connected — no
 * choice keeps today's SDK-managed default exactly, and a saved device that
 * is unplugged is left to the SDK's own fallback (the choice is kept, so the
 * next device change that brings it back applies it). `includeInput: false`
 * during a call: the mic watcher owns re-pinning then. Never throws; the
 * outcome says what happened.
 */
export async function applySavedAudioPrefs(
  audio: DeviceAudioLike,
  prefs: AudioPrefs,
  opts: { includeInput: boolean },
): Promise<AudioApplyResult> {
  const [input, output] = await Promise.all([
    applyInput(audio, prefs.input, opts.includeInput),
    applyOutput(audio, prefs.output),
  ]);
  return { input, output };
}

export interface KeepPrefsHooks {
  loadPrefs: () => AudioPrefs;
  /** A call or the dialer leg is up — the mic watcher owns the input then. */
  isCallUp: () => boolean;
  /** False once this Device has been replaced/destroyed. */
  isCurrent: () => boolean;
  onFailed: (result: AudioApplyResult) => void;
}

/**
 * Wire a freshly created Device to the saved choices: re-apply on every SDK
 * 'deviceChange' (its first device listing arrives that way, and so does a
 * headset being plugged back in), and return an apply the caller runs once
 * the Device is registered. The deviceChange apply waits one task: the SDK's
 * first listing emits deviceChange and then, in the same turn, sets its
 * speakers to 'default' — applying sooner would be overwritten.
 */
export function keepSavedAudioPrefs(audio: DeviceAudioLike, hooks: KeepPrefsHooks): () => void {
  const apply = (): void => {
    if (!hooks.isCurrent()) return;
    void applySavedAudioPrefs(audio, hooks.loadPrefs(), { includeInput: !hooks.isCallUp() }).then((result) => {
      if (result.input === 'failed' || result.output === 'failed') hooks.onFailed(result);
    });
  };
  audio.on('deviceChange', () => { setTimeout(apply, 0); });
  return apply;
}

/**
 * Settings was changed in another tab (only the softphone leader tab holds
 * the Device): apply the direction whose storage key changed, exactly as if
 * it had been chosen here. Null for keys that aren't ours.
 */
export function applyChoiceFromStorage(
  audio: DeviceAudioLike,
  key: string | null,
  prefs: AudioPrefs,
): Promise<void> | null {
  if (key === AUDIO_INPUT_KEY) return chooseInput(audio, prefs.input);
  if (key === AUDIO_OUTPUT_KEY) return chooseOutput(audio, prefs.output);
  return null;
}

// ---------------------------------------------------------------------------
// Test sound
// ---------------------------------------------------------------------------

/** The HTMLAudioElement surface the test sound needs. */
export interface TestToneElement {
  src: string;
  play(): Promise<void>;
  setSinkId?(sinkId: string): Promise<void>;
}

const TONE_RATE = 8000;
const TONE_SECONDS = 0.35;
const TONE_HZ = 880;
const TONE_FADE_SECONDS = 0.02;

let toneUri: string | null = null;

/** A short, soft 880 Hz beep as a 16-bit mono WAV data URI (built once, ~7 KB)
 *  — no network fetch, so it plays even when a CDN is blocked. */
export function testToneDataUri(): string {
  if (toneUri) return toneUri;
  const samples = Math.round(TONE_RATE * TONE_SECONDS);
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, TONE_RATE, true); view.setUint32(28, TONE_RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples * 2, true);
  const fade = TONE_RATE * TONE_FADE_SECONDS;
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(1, i / fade, (samples - i) / fade);
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * TONE_HZ * i) / TONE_RATE) * envelope * 0.3 * 32767), true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  toneUri = `data:audio/wav;base64,${btoa(binary)}`;
  return toneUri;
}

/** Play the test beep on `deviceId` via setSinkId ("System default" plays on
 *  the browser's default output). Rejects when the browser refuses. */
export async function playTestTone(deviceId: string, el: TestToneElement): Promise<void> {
  el.src = testToneDataUri();
  if (deviceId !== SYSTEM_DEFAULT && typeof el.setSinkId === 'function') await el.setSinkId(deviceId);
  await el.play();
}

// ---------------------------------------------------------------------------
// The port Settings talks to
// ---------------------------------------------------------------------------

/** The navigator.mediaDevices surface this needs. */
export interface MediaDevicesLike {
  enumerateDevices(): Promise<MediaDeviceLike[]>;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

/** The browser, injectable for tests. */
export interface AudioEnvironment {
  mediaDevices: MediaDevicesLike | null;
  /** HTMLMediaElement.prototype.setSinkId exists — the browser can route output. */
  canSetSinkId: boolean;
  createAudioElement(): TestToneElement;
}

/** What the Settings rows need from the browser and the live Device —
 *  injected so tests hand in fakes. */
export interface AudioDevicePort {
  listDevices(): Promise<MediaDeviceLike[]>;
  /** Subscribe to navigator.mediaDevices 'devicechange'; returns the unsubscribe. */
  onDeviceChange(listener: () => void): () => void;
  canChooseOutput(): boolean;
  setInputDevice(deviceId: string): Promise<void>;
  /** "System default" for the mic. */
  unsetInputDevice(): Promise<void>;
  /** A speaker id, or 'default' for "System default". */
  setOutputDevice(deviceId: string): Promise<void>;
  playTestSound(deviceId: string): Promise<void>;
}

export function browserAudioEnvironment(): AudioEnvironment {
  const mediaDevices = typeof navigator === 'undefined' ? null : navigator.mediaDevices ?? null;
  return {
    mediaDevices: mediaDevices && typeof mediaDevices.enumerateDevices === 'function' ? mediaDevices : null,
    canSetSinkId: typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype,
    createAudioElement: () => new Audio(),
  };
}

/**
 * The port over the live Device's AudioHelper (`getAudio`, read at each use —
 * the Device is created lazily and re-created on leadership changes). With no
 * Device (this tab isn't the softphone leader, or it isn't up yet) the
 * choosers do nothing: the choice is already saved and is applied when a
 * Device appears, or by the leader tab through the storage event.
 */
export function createAudioDevicePort(
  getAudio: () => DeviceAudioLike | null,
  env: AudioEnvironment = browserAudioEnvironment(),
): AudioDevicePort {
  return {
    listDevices: async () => (env.mediaDevices ? env.mediaDevices.enumerateDevices() : []),
    onDeviceChange: (listener) => {
      const md = env.mediaDevices;
      if (!md?.addEventListener) return () => {};
      md.addEventListener('devicechange', listener);
      return () => md.removeEventListener?.('devicechange', listener);
    },
    canChooseOutput: () => env.canSetSinkId && getAudio()?.isOutputSelectionSupported !== false,
    setInputDevice: async (deviceId) => {
      const audio = getAudio();
      if (audio) await chooseInput(audio, deviceId);
    },
    unsetInputDevice: async () => {
      const audio = getAudio();
      if (audio) await chooseInput(audio, null);
    },
    setOutputDevice: async (deviceId) => {
      const audio = getAudio();
      if (audio) await chooseOutput(audio, deviceId === SYSTEM_DEFAULT ? null : deviceId);
    },
    playTestSound: (deviceId) => playTestTone(deviceId, env.createAudioElement()),
  };
}

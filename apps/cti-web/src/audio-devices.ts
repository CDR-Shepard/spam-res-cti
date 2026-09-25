/**
 * Microphone / speaker choice for the softphone — the pure decisions.
 *
 * WHY (2026-09-25): a rep could not hear callers on outbound calls and callers
 * could not hear him, while YouTube in the same Chrome played through his
 * headset. Voice Insights for his 10:44 PT call showed media connected both
 * ways, then `constant-audio-input-level` (his mic captured silence) and
 * `constant-audio-output-level` — the softphone was capturing from, and playing
 * to, a different device than the headset he was wearing. Reps now pick both
 * in Settings; this file decides what that choice means as devices come and go.
 *
 * Device ids are per browser and per origin, so the choice lives in this
 * browser's localStorage, not on the server.
 */

export const AUDIO_INPUT_KEY = 'cti.audio.input';
export const AUDIO_OUTPUT_KEY = 'cti.audio.output';
/** The "System default" choice. Also Chrome's own id for the pseudo-device
 *  that follows the OS default. */
export const SYSTEM_DEFAULT = 'default';

/** The rep's saved choice per direction; null = System default. */
export interface AudioPrefs {
  input: string | null;
  output: string | null;
}

/** The fields of a MediaDeviceInfo this needs. */
export interface MediaDeviceLike {
  deviceId: string;
  kind: string;
  label: string;
}

export type AudioDeviceKind = 'audioinput' | 'audiooutput';

export interface DeviceOption {
  value: string;
  label: string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** window.localStorage, or null where even touching it throws (blocked site data). */
function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readChoice(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    const v = storage.getItem(key);
    return v && v !== SYSTEM_DEFAULT ? v : null;
  } catch {
    // Blocked storage: the softphone still works, on the system default.
    return null;
  }
}

/** The saved choices, or System default for anything unreadable. Never throws. */
export function loadAudioPrefs(storage: StorageLike | null = browserStorage()): AudioPrefs {
  return { input: readChoice(storage, AUDIO_INPUT_KEY), output: readChoice(storage, AUDIO_OUTPUT_KEY) };
}

/** Save both choices (System default removes the key). Returns false when this
 *  browser won't keep them — the caller tells the rep. Never throws. */
export function saveAudioPrefs(prefs: AudioPrefs, storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    for (const [key, value] of [[AUDIO_INPUT_KEY, prefs.input], [AUDIO_OUTPUT_KEY, prefs.output]] as const) {
      if (value && value !== SYSTEM_DEFAULT) storage.setItem(key, value);
      else storage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Which device a saved choice means right now. A saved device that isn't
 * connected (headset unplugged) falls back to the system default and is
 * flagged `missing` — the saved choice itself is kept, so it applies again the
 * moment the device returns.
 */
export function effectiveDeviceId(
  saved: string | null,
  available: readonly string[],
): { deviceId: string; missing: boolean } {
  if (!saved || saved === SYSTEM_DEFAULT) return { deviceId: SYSTEM_DEFAULT, missing: false };
  if (available.includes(saved)) return { deviceId: saved, missing: false };
  return { deviceId: SYSTEM_DEFAULT, missing: true };
}

/** The concrete id "System default" maps to: Chrome's 'default' pseudo-device
 *  (it follows the OS default) when present, else the first device — the same
 *  fallback the Twilio SDK uses — else null. */
export function systemDefaultDeviceId(available: readonly string[]): string | null {
  if (available.includes(SYSTEM_DEFAULT)) return SYSTEM_DEFAULT;
  return available[0] ?? null;
}

/** A saved choice resolved to a device id the Twilio SDK will accept, or null
 *  when there are no devices at all. */
export function resolveDeviceId(saved: string | null, available: readonly string[]): string | null {
  const { deviceId } = effectiveDeviceId(saved, available);
  return deviceId === SYSTEM_DEFAULT ? systemDefaultDeviceId(available) : deviceId;
}

const FALLBACK_NOUN: Record<AudioDeviceKind, string> = { audioinput: 'Microphone', audiooutput: 'Speaker' };

/** Devices of one kind a rep can actually pick: not Chrome's own 'default'
 *  entry ("System default" is that) and not the blank-id placeholders a
 *  browser lists before permission. */
function pickable(devices: readonly MediaDeviceLike[], kind: AudioDeviceKind): MediaDeviceLike[] {
  return devices.filter((d) => d.kind === kind && d.deviceId !== '' && d.deviceId !== SYSTEM_DEFAULT);
}

/** The ids of one kind as the browser lists them (including 'default'). */
export function deviceIds(devices: readonly MediaDeviceLike[], kind: AudioDeviceKind): string[] {
  return devices.filter((d) => d.kind === kind && d.deviceId !== '').map((d) => d.deviceId);
}

/** The select's options: "System default" first, then each device by label
 *  (or "Microphone 2" when the browser hides labels). */
export function deviceOptions(devices: readonly MediaDeviceLike[], kind: AudioDeviceKind): DeviceOption[] {
  return [
    { value: SYSTEM_DEFAULT, label: 'System default' },
    ...pickable(devices, kind).map((d, i) => ({ value: d.deviceId, label: d.label || `${FALLBACK_NOUN[kind]} ${i + 1}` })),
  ];
}

/** True when the browser is hiding device names (no microphone permission yet):
 *  there are devices of this kind and none has a label. */
export function labelsHidden(devices: readonly MediaDeviceLike[], kind: AudioDeviceKind): boolean {
  const ofKind = devices.filter((d) => d.kind === kind);
  return ofKind.length > 0 && ofKind.every((d) => !d.label);
}

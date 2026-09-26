/**
 * The callback chime (spec 2026-09-26): the Voice SDK plays no ringtone for a
 * call that arrives while another is up (device.ts `_onSignalingInvite` plays
 * the incoming sound only when it was not busy), so a callback during a run
 * would ring in silence. Two short beeps of the Settings test tone
 * (audio-device-port.ts `testToneDataUri` — a generated WAV, no network) on the
 * speaker chosen in Settings.
 */
import { testToneDataUri, type TestToneElement } from './audio-device-port';
import { loadAudioPrefs, SYSTEM_DEFAULT } from './audio-devices';

export const CHIME_BEEPS = 2;
export const CHIME_GAP_MS = 450;

export interface ChimeDeps {
  createAudioElement: () => TestToneElement;
  /** The speaker chosen in Settings, or 'default'. */
  outputDeviceId: () => string;
  wait: (ms: number) => Promise<void>;
  /** True once the chime should stop — the banner came down (the caller hung
   *  up, the rep pressed Ignore). Checked before each beep after the first. */
  cancelled?: () => boolean;
}

export function browserChimeDeps(): ChimeDeps {
  return {
    createAudioElement: () => new Audio(),
    outputDeviceId: () => loadAudioPrefs().output ?? SYSTEM_DEFAULT,
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

/** One beep on the chosen speaker. If that speaker has gone away since
 *  Settings (setSinkId rejects), the element keeps the default output. */
async function beep(deviceId: string, el: TestToneElement): Promise<void> {
  el.src = testToneDataUri();
  if (deviceId !== SYSTEM_DEFAULT && typeof el.setSinkId === 'function') {
    try { await el.setSinkId(deviceId); } catch { /* unplugged: play on the default output */ }
  }
  await el.play();
}

/** Rejects only when the browser refuses to play at all (autoplay policy, no
 *  output) — a missing chosen speaker falls back to the default output. */
export async function playCallbackChime(deps: ChimeDeps = browserChimeDeps()): Promise<void> {
  const deviceId = deps.outputDeviceId();
  for (let i = 0; i < CHIME_BEEPS; i++) {
    if (i > 0) {
      await deps.wait(CHIME_GAP_MS);
      if (deps.cancelled?.()) return;
    }
    await beep(deviceId, deps.createAudioElement());
  }
}

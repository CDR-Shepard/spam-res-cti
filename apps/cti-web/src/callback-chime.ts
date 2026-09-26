/**
 * The callback chime (spec 2026-09-26): the Voice SDK plays no ringtone for a
 * call that arrives while another is up (device.ts `_onSignalingInvite` plays
 * the incoming sound only when it was not busy), so a callback during a run
 * would ring in silence. Two short beeps of the Settings test tone
 * (audio-device-port.ts `playTestTone` — a generated WAV, no network) on the
 * speaker chosen in Settings.
 */
import { playTestTone, type TestToneElement } from './audio-device-port';
import { loadAudioPrefs, SYSTEM_DEFAULT } from './audio-devices';

export const CHIME_BEEPS = 2;
export const CHIME_GAP_MS = 450;

export interface ChimeDeps {
  createAudioElement: () => TestToneElement;
  /** The speaker chosen in Settings, or 'default'. */
  outputDeviceId: () => string;
  wait: (ms: number) => Promise<void>;
}

export function browserChimeDeps(): ChimeDeps {
  return {
    createAudioElement: () => new Audio(),
    outputDeviceId: () => loadAudioPrefs().output ?? SYSTEM_DEFAULT,
    wait: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  };
}

/** Rejects when the browser refuses to play (autoplay policy, a speaker that is gone). */
export async function playCallbackChime(deps: ChimeDeps = browserChimeDeps()): Promise<void> {
  const deviceId = deps.outputDeviceId();
  for (let i = 0; i < CHIME_BEEPS; i++) {
    if (i > 0) await deps.wait(CHIME_GAP_MS);
    await playTestTone(deviceId, deps.createAudioElement());
  }
}

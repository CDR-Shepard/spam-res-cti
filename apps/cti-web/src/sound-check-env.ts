/**
 * The browser behind the sound check, injectable so jsdom tests use fakes.
 *  - Chrome's microphone setting, via navigator.permissions (spec decision 6).
 *    No Permissions API, or one that refuses 'microphone', reads as 'prompt'.
 *  - A short-lived getUserMedia stream on the chosen mic. System default is
 *    used when none is saved, or when the saved one is unplugged.
 *  - The level source over that stream (level-meter.ts).
 */
import { SYSTEM_DEFAULT } from './audio-devices';
import { createLevelSource, type AudioContextLike, type LevelSource, type MicStreamLike } from './level-meter';

export type MicPermission = 'prompt' | 'granted' | 'denied';

export interface PermissionWatch {
  state: MicPermission;
  stop(): void;
}

export interface SoundCheckEnv {
  /** Chrome's current setting, plus every later change (PermissionStatus `change`). */
  watchPermission(onChange: (p: MicPermission) => void): Promise<PermissionWatch>;
  /** Open the mic (null = System default). The caller must stopStream() it. */
  openMic(deviceId: string | null): Promise<MicStreamLike>;
  createLevelSource(stream: MicStreamLike): LevelSource;
  /** The tab went hidden (visibilitychange). Returns the unsubscribe. */
  onHidden(cb: () => void): () => void;
}

export interface PermissionStatusLike {
  state: string;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface NavigatorLike {
  permissions?: { query(descriptor: { name: string }): Promise<PermissionStatusLike> };
  mediaDevices?: { getUserMedia?(constraints: MicConstraints): Promise<MicStreamLike> };
}

type MicConstraints = { audio: true | { deviceId: { exact: string } } };

export function toMicPermission(state: unknown): MicPermission {
  return state === 'granted' || state === 'denied' ? state : 'prompt';
}

export function micConstraints(deviceId: string | null): MicConstraints {
  return { audio: deviceId && deviceId !== SYSTEM_DEFAULT ? { deviceId: { exact: deviceId } } : true };
}

/** Stop every track: the browser's recording dot goes out. */
export function stopStream(stream: MicStreamLike): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Already stopped.
    }
  }
}

/** The sentence the rep sees when the mic could not be opened. */
export function micErrorText(e: unknown): string {
  const name = (e as { name?: unknown } | null)?.name;
  if (name === 'NotAllowedError') return "Chrome didn't allow the microphone. Click Allow microphone, then choose Allow.";
  if (name === 'NotFoundError') return 'No microphone found. Plug in your headset.';
  if (name === 'NotReadableError') return 'Another app is using the microphone. Close it and try again.';
  const msg = e instanceof Error && e.message ? e.message : 'the browser refused it';
  return `Couldn't open the microphone: ${msg}`;
}

/** getUserMedia errors that mean "that device isn't here": fall back to any mic. */
const DEVICE_GONE = new Set(['OverconstrainedError', 'NotFoundError']);

export function browserSoundCheckEnv(
  nav: NavigatorLike | undefined = typeof navigator === 'undefined' ? undefined : (navigator as unknown as NavigatorLike),
  createContext: () => AudioContextLike = () => new AudioContext() as unknown as AudioContextLike,
): SoundCheckEnv {
  return {
    async watchPermission(onChange) {
      const permissions = nav?.permissions;
      if (!permissions) return { state: 'prompt', stop: () => {} };
      let status: PermissionStatusLike;
      try {
        status = await permissions.query({ name: 'microphone' });
      } catch {
        return { state: 'prompt', stop: () => {} }; // this browser can't be asked about the mic
      }
      const listener = (): void => onChange(toMicPermission(status.state));
      status.addEventListener('change', listener);
      return { state: toMicPermission(status.state), stop: () => status.removeEventListener('change', listener) };
    },
    async openMic(deviceId) {
      const media = nav?.mediaDevices;
      if (!media || !media.getUserMedia) {
        throw Object.assign(new Error('This browser has no microphone access.'), { name: 'NotSupportedError' });
      }
      try {
        return await media.getUserMedia(micConstraints(deviceId));
      } catch (e) {
        const name = (e as { name?: unknown } | null)?.name;
        if (deviceId && typeof name === 'string' && DEVICE_GONE.has(name)) return media.getUserMedia(micConstraints(null));
        throw e;
      }
    },
    createLevelSource: (stream) => createLevelSource(stream, createContext()),
    onHidden(cb) {
      if (typeof document === 'undefined') return () => {};
      const onChange = (): void => { if (document.visibilityState === 'hidden') cb(); };
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
  };
}

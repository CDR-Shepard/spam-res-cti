import { describe, expect, it, vi } from 'vitest';
import type { AudioContextLike, MicStreamLike } from './level-meter';
import {
  browserSoundCheckEnv,
  MAC_MIC_BLOCKED_TEXT,
  micConstraints,
  micErrorText,
  stopStream,
  toMicPermission,
  type MicPermission,
  type NavigatorLike,
  type PermissionStatusLike,
} from './sound-check-env';

const named = (name: string, message = name): Error => Object.assign(new Error(message), { name });

describe('the pure pieces', () => {
  it("toMicPermission: granted and denied pass; anything else is 'prompt'", () => {
    expect(toMicPermission('granted')).toBe('granted');
    expect(toMicPermission('denied')).toBe('denied');
    for (const other of ['prompt', undefined, 'weird', 3]) expect(toMicPermission(other)).toBe('prompt');
  });

  it('micConstraints: System default (or none) is any mic; a saved one is exact', () => {
    expect(micConstraints(null)).toEqual({ audio: true });
    expect(micConstraints('default')).toEqual({ audio: true });
    expect(micConstraints('jabra')).toEqual({ audio: { deviceId: { exact: 'jabra' } } });
  });

  it('micErrorText: what the rep reads', () => {
    expect(micErrorText(named('NotAllowedError'))).toBe("Chrome didn't allow the microphone. Click Allow microphone, then choose Allow.");
    expect(micErrorText(named('NotFoundError'))).toBe('No microphone found. Plug in your headset.');
    expect(micErrorText(named('NotReadableError'))).toBe('Another app is using the microphone. Close it and try again.');
    expect(micErrorText(new Error('boom'))).toBe("Couldn't open the microphone: boom");
    expect(micErrorText('x')).toBe("Couldn't open the microphone: the browser refused it");
  });

  // Task 3 review I4: Chrome says Allowed, but macOS blocks Chrome itself —
  // getUserMedia throws NotAllowedError ("Permission denied by system").
  // Chrome's site settings can't fix that, so don't send the rep there.
  it('micErrorText: a macOS privacy block gets the System Settings steps', () => {
    const mac = MAC_MIC_BLOCKED_TEXT;
    expect(mac).toBe("Your Mac is blocking Chrome's microphone: System Settings → Privacy & Security → Microphone → turn on Google Chrome, then quit and reopen Chrome.");
    expect(micErrorText(named('NotAllowedError', 'Permission denied by system'))).toBe(mac);
    expect(micErrorText(named('NotAllowedError', 'Permission denied'), 'granted')).toBe(mac);
    expect(micErrorText(named('NotAllowedError', 'Permission denied'), 'prompt')).toBe("Chrome didn't allow the microphone. Click Allow microphone, then choose Allow.");
    expect(micErrorText(named('NotFoundError'), 'granted')).toBe('No microphone found. Plug in your headset.');
  });

  it('stopStream stops every track', () => {
    const stops = [vi.fn(), vi.fn()];
    stopStream({ getTracks: () => stops.map((stop) => ({ stop })) });
    for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
  });
});

describe('browserSoundCheckEnv — Chrome\'s microphone setting', () => {
  function status(state: string) {
    const listeners = new Set<() => void>();
    const s: PermissionStatusLike & { fire(next: string): void; listeners: Set<() => void> } = {
      state,
      listeners,
      addEventListener: (_t, l) => { listeners.add(l); },
      removeEventListener: (_t, l) => { listeners.delete(l); },
      fire(next) { s.state = next; for (const l of [...listeners]) l(); },
    };
    return s;
  }

  it("no Permissions API → 'prompt'", async () => {
    await expect(browserSoundCheckEnv({}).watchPermission(() => {})).resolves.toMatchObject({ state: 'prompt' });
  });

  it("a Permissions API that refuses 'microphone' → 'prompt'", async () => {
    const nav: NavigatorLike = { permissions: { query: async () => { throw new TypeError('not a valid permission name'); } } };
    await expect(browserSoundCheckEnv(nav).watchPermission(() => {})).resolves.toMatchObject({ state: 'prompt' });
  });

  it('reads the state, reports changes (Blocked → Allowed), and stop() unsubscribes', async () => {
    const st = status('denied');
    const query = vi.fn(async () => st);
    const seen: MicPermission[] = [];
    const w = await browserSoundCheckEnv({ permissions: { query } }).watchPermission((p) => seen.push(p));
    expect(query).toHaveBeenCalledWith({ name: 'microphone' });
    expect(w.state).toBe('denied');
    st.fire('granted');
    expect(seen).toEqual(['granted']);
    w.stop();
    st.fire('denied');
    expect(seen).toEqual(['granted']);
  });
});

describe('browserSoundCheckEnv — opening the mic', () => {
  const stream: MicStreamLike = { getTracks: () => [] };

  it('opens the saved mic exactly', async () => {
    const getUserMedia = vi.fn(async () => stream);
    await expect(browserSoundCheckEnv({ mediaDevices: { getUserMedia } }).openMic('jabra')).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: 'jabra' } } });
  });

  it('falls back to any mic when the saved one is unplugged', async () => {
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(named('OverconstrainedError'))
      .mockResolvedValueOnce(stream);
    await expect(browserSoundCheckEnv({ mediaDevices: { getUserMedia } }).openMic('jabra')).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenLastCalledWith({ audio: true });
  });

  it('a refusal is not retried', async () => {
    const getUserMedia = vi.fn(async () => { throw named('NotAllowedError'); });
    await expect(browserSoundCheckEnv({ mediaDevices: { getUserMedia } }).openMic('jabra')).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('no getUserMedia at all → NotSupportedError', async () => {
    await expect(browserSoundCheckEnv({}).openMic(null)).rejects.toMatchObject({ name: 'NotSupportedError' });
  });

  it('the level source uses the injected AudioContext', () => {
    const analyser = { fftSize: 0, getFloatTimeDomainData: (a: Float32Array) => { a.fill(0.1); } };
    const ctx: AudioContextLike = { createMediaStreamSource: () => ({ connect: () => {}, disconnect: () => {} }), createAnalyser: () => analyser, close: async () => {} };
    const make = vi.fn(() => ctx);
    const meter = browserSoundCheckEnv({}, make).createLevelSource(stream);
    expect(make).toHaveBeenCalledTimes(1);
    expect(meter.read()).toBeCloseTo(0.4);
  });
});

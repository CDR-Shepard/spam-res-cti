import { describe, expect, it } from 'vitest';
import {
  AUDIO_INPUT_KEY,
  AUDIO_OUTPUT_KEY,
  deviceOptions,
  effectiveDeviceId,
  labelsHidden,
  loadAudioPrefs,
  resolveDeviceId,
  saveAudioPrefs,
  systemDefaultDeviceId,
  type MediaDeviceLike,
  type StorageLike,
} from './audio-devices';

/** A Map-backed Storage, optionally throwing on every access (blocked site data). */
function memoryStorage(seed: Record<string, string> = {}, broken = false): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  const guard = (): void => { if (broken) throw new Error('SecurityError: storage is blocked'); };
  return {
    data,
    getItem: (k) => { guard(); return data.get(k) ?? null; },
    setItem: (k, v) => { guard(); data.set(k, v); },
    removeItem: (k) => { guard(); data.delete(k); },
  };
}

const dev = (kind: string, deviceId: string, label = ''): MediaDeviceLike => ({ kind, deviceId, label });

describe('effectiveDeviceId', () => {
  it('no saved choice → the system default, nothing missing', () => {
    expect(effectiveDeviceId(null, ['default', 'jabra'])).toEqual({ deviceId: 'default', missing: false });
    expect(effectiveDeviceId('default', ['jabra'])).toEqual({ deviceId: 'default', missing: false });
  });

  it('a saved device that is connected → that device', () => {
    expect(effectiveDeviceId('jabra', ['default', 'jabra'])).toEqual({ deviceId: 'jabra', missing: false });
  });

  // Headset unplugged: use the default for now, but report it so Settings can
  // say so — the saved choice itself is kept and applies again on return.
  it('a saved device that is NOT connected → the system default, flagged missing', () => {
    expect(effectiveDeviceId('jabra', ['default', 'macbook-mic'])).toEqual({ deviceId: 'default', missing: true });
    expect(effectiveDeviceId('jabra', [])).toEqual({ deviceId: 'default', missing: true });
  });
});

describe('systemDefaultDeviceId / resolveDeviceId', () => {
  it("prefers Chrome's 'default' pseudo-device, else the first device, else null (what the SDK itself falls back to)", () => {
    expect(systemDefaultDeviceId(['jabra', 'default'])).toBe('default');
    expect(systemDefaultDeviceId(['jabra', 'macbook-mic'])).toBe('jabra');
    expect(systemDefaultDeviceId([])).toBeNull();
  });

  it('resolves a choice to a concrete SDK device id', () => {
    expect(resolveDeviceId('jabra', ['default', 'jabra'])).toBe('jabra');
    expect(resolveDeviceId(null, ['default', 'jabra'])).toBe('default');
    expect(resolveDeviceId('jabra', ['macbook-mic'])).toBe('macbook-mic');
    expect(resolveDeviceId('jabra', [])).toBeNull();
  });
});

describe('deviceOptions', () => {
  const devices = [
    dev('audioinput', 'default', 'Default - Jabra Evolve2 (0b0e:24c8)'),
    dev('audioinput', 'jabra', 'Jabra Evolve2 (0b0e:24c8)'),
    dev('audioinput', 'mac', 'MacBook Pro Microphone (Built-in)'),
    dev('audiooutput', 'default', 'Default - MacBook Pro Speakers'),
    dev('audiooutput', 'spk-jabra', 'Jabra Evolve2 (0b0e:24c8)'),
    dev('videoinput', 'cam', 'FaceTime HD Camera'),
  ];

  it('"System default" first, then the devices of that kind with their labels', () => {
    expect(deviceOptions(devices, 'audioinput')).toEqual([
      { value: 'default', label: 'System default' },
      { value: 'jabra', label: 'Jabra Evolve2 (0b0e:24c8)' },
      { value: 'mac', label: 'MacBook Pro Microphone (Built-in)' },
    ]);
    expect(deviceOptions(devices, 'audiooutput')).toEqual([
      { value: 'default', label: 'System default' },
      { value: 'spk-jabra', label: 'Jabra Evolve2 (0b0e:24c8)' },
    ]);
  });

  it("drops Chrome's own 'default' entry (\"System default\" is it) and unusable empty ids", () => {
    const opts = deviceOptions([dev('audioinput', ''), dev('audioinput', 'default', 'Default - X')], 'audioinput');
    expect(opts).toEqual([{ value: 'default', label: 'System default' }]);
  });

  it('names unlabelled devices so the list is still usable', () => {
    expect(deviceOptions([dev('audioinput', 'a'), dev('audioinput', 'b')], 'audioinput').map((o) => o.label))
      .toEqual(['System default', 'Microphone 1', 'Microphone 2']);
    expect(deviceOptions([dev('audiooutput', 'a')], 'audiooutput').map((o) => o.label))
      .toEqual(['System default', 'Speaker 1']);
  });
});

describe('labelsHidden', () => {
  // Browsers blank device labels until the page has microphone permission.
  it('true when every device of that kind is unlabelled, false otherwise (or when there are none)', () => {
    expect(labelsHidden([dev('audioinput', ''), dev('audiooutput', '')], 'audioinput')).toBe(true);
    expect(labelsHidden([dev('audioinput', 'a', 'Jabra')], 'audioinput')).toBe(false);
    expect(labelsHidden([dev('audiooutput', 'a', 'Jabra')], 'audioinput')).toBe(false);
  });
});

describe('loadAudioPrefs / saveAudioPrefs', () => {
  it('round-trips both choices under cti.audio.input / cti.audio.output', () => {
    const s = memoryStorage();
    expect(saveAudioPrefs({ input: 'jabra', output: 'spk-jabra' }, s)).toBe(true);
    expect(s.data.get(AUDIO_INPUT_KEY)).toBe('jabra');
    expect(s.data.get(AUDIO_OUTPUT_KEY)).toBe('spk-jabra');
    expect(loadAudioPrefs(s)).toEqual({ input: 'jabra', output: 'spk-jabra' });
  });

  it('"System default" is stored as no key at all', () => {
    const s = memoryStorage({ [AUDIO_INPUT_KEY]: 'jabra', [AUDIO_OUTPUT_KEY]: 'spk' });
    saveAudioPrefs({ input: null, output: null }, s);
    expect(s.data.size).toBe(0);
    expect(loadAudioPrefs(s)).toEqual({ input: null, output: null });
  });

  it("reads a stored 'default' or empty string as the system default", () => {
    expect(loadAudioPrefs(memoryStorage({ [AUDIO_INPUT_KEY]: 'default', [AUDIO_OUTPUT_KEY]: '' })))
      .toEqual({ input: null, output: null });
  });

  // Private windows / blocked site data make every Storage access throw. The
  // softphone must still work (on the system default) — never crash on it.
  it('blocked storage: load gives the defaults and save reports false, neither throws', () => {
    const s = memoryStorage({}, true);
    expect(loadAudioPrefs(s)).toEqual({ input: null, output: null });
    expect(saveAudioPrefs({ input: 'jabra', output: null }, s)).toBe(false);
    expect(loadAudioPrefs(null)).toEqual({ input: null, output: null });
    expect(saveAudioPrefs({ input: 'jabra', output: null }, null)).toBe(false);
  });
});

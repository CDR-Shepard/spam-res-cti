import { describe, expect, it, vi } from 'vitest';
import {
  applyChoiceFromStorage,
  applySavedAudioPrefs,
  keepSavedAudioPrefs,
  chooseInput,
  chooseOutput,
  createAudioDevicePort,
  playTestTone,
  testToneDataUri,
  type AudioEnvironment,
  type DeviceAudioLike,
  type OutputDevicesLike,
} from './audio-device-port';

/** A Twilio OutputDeviceCollection fake: `set` records and becomes the active set. */
function fakeOutputs(initial: string[] = []): OutputDevicesLike & { set: ReturnType<typeof vi.fn> } {
  let active = new Set(initial.map((deviceId) => ({ deviceId })));
  return {
    get: () => active,
    set: vi.fn(async (id: string | string[]) => {
      active = new Set((Array.isArray(id) ? id : [id]).map((deviceId) => ({ deviceId })));
    }),
  };
}

/** A Twilio AudioHelper (`device.audio`) fake with a Jabra headset plugged in. */
function fakeAudio(over: Partial<DeviceAudioLike> = {}) {
  const audio = {
    availableInputDevices: new Map([['default', { deviceId: 'default' }], ['jabra', { deviceId: 'jabra' }]]),
    availableOutputDevices: new Map([['default', { deviceId: 'default' }], ['spk-jabra', { deviceId: 'spk-jabra' }]]),
    inputDevice: null as { deviceId: string } | null,
    isOutputSelectionSupported: true,
    setInputDevice: vi.fn(async (id: string) => { audio.inputDevice = { deviceId: id }; }),
    unsetInputDevice: vi.fn(async () => { audio.inputDevice = null; }),
    speakerDevices: fakeOutputs(['default']),
    ringtoneDevices: fakeOutputs(['default']),
    on: vi.fn(),
    ...over,
  };
  return audio;
}

describe('chooseInput', () => {
  it('a device → setInputDevice(id) (the SDK swaps it into a live call too)', async () => {
    const audio = fakeAudio();
    await chooseInput(audio, 'jabra');
    expect(audio.setInputDevice).toHaveBeenCalledWith('jabra');
  });

  it('System default → unsetInputDevice()', async () => {
    const audio = fakeAudio({ inputDevice: { deviceId: 'jabra' } });
    await chooseInput(audio, null);
    expect(audio.unsetInputDevice).toHaveBeenCalled();
  });

  // Twilio 2.18.3 rejects unsetInputDevice during a call ("Cannot unset input
  // device while a call is in progress"). Pin the system default instead —
  // the same thing the mic watcher does — so the choice still takes effect now.
  it('System default mid-call: unset is refused, so it pins the system default device', async () => {
    const audio = fakeAudio({
      inputDevice: { deviceId: 'jabra' },
      unsetInputDevice: vi.fn(async () => { throw new Error('Cannot unset input device while a call is in progress.'); }),
    });
    await chooseInput(audio, null);
    expect(audio.setInputDevice).toHaveBeenCalledWith('default');
  });

  it('System default when nothing is pinned is a no-op (the SDK is already on the default)', async () => {
    const audio = fakeAudio();
    await chooseInput(audio, null);
    expect(audio.unsetInputDevice).not.toHaveBeenCalled();
    expect(audio.setInputDevice).not.toHaveBeenCalled();
  });

  it('a device the SDK refuses rejects, so Settings can say so', async () => {
    const audio = fakeAudio({ setInputDevice: vi.fn(async () => { throw new Error('NotReadableError'); }) });
    await expect(chooseInput(audio, 'jabra')).rejects.toThrow('NotReadableError');
  });
});

describe('chooseOutput', () => {
  it('a device → speakerDevices.set(id) AND ringtoneDevices.set(id)', async () => {
    const audio = fakeAudio();
    await chooseOutput(audio, 'spk-jabra');
    expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-jabra');
    expect(audio.ringtoneDevices.set).toHaveBeenCalledWith('spk-jabra');
  });

  it("System default → 'default'", async () => {
    const audio = fakeAudio();
    await chooseOutput(audio, null);
    expect(audio.speakerDevices.set).toHaveBeenCalledWith('default');
    expect(audio.ringtoneDevices.set).toHaveBeenCalledWith('default');
  });

  // Browsers without Chrome's 'default' pseudo-device: same fallback the SDK uses.
  it("System default where there is no 'default' entry → the first speaker", async () => {
    const audio = fakeAudio({ availableOutputDevices: new Map([['spk-a', { deviceId: 'spk-a' }], ['spk-b', { deviceId: 'spk-b' }]]) });
    await chooseOutput(audio, null);
    expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-a');
  });

  it('does nothing where the SDK reports output selection unsupported', async () => {
    const audio = fakeAudio({ isOutputSelectionSupported: false });
    await chooseOutput(audio, 'spk-jabra');
    expect(audio.speakerDevices.set).not.toHaveBeenCalled();
  });
});

describe('applySavedAudioPrefs (Device created, or its device list changed)', () => {
  it('applies a saved mic and speaker that are connected', async () => {
    const audio = fakeAudio();
    const r = await applySavedAudioPrefs(audio, { input: 'jabra', output: 'spk-jabra' }, { includeInput: true });
    expect(r).toEqual({ input: 'applied', output: 'applied' });
    expect(audio.setInputDevice).toHaveBeenCalledWith('jabra');
    expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-jabra');
    expect(audio.ringtoneDevices.set).toHaveBeenCalledWith('spk-jabra');
  });

  it('is idempotent — nothing is re-set when the Device already uses the saved devices', async () => {
    const audio = fakeAudio({
      inputDevice: { deviceId: 'jabra' },
      speakerDevices: fakeOutputs(['spk-jabra']),
      ringtoneDevices: fakeOutputs(['spk-jabra']),
    });
    const r = await applySavedAudioPrefs(audio, { input: 'jabra', output: 'spk-jabra' }, { includeInput: true });
    expect(r).toEqual({ input: 'unchanged', output: 'unchanged' });
    expect(audio.setInputDevice).not.toHaveBeenCalled();
    expect(audio.speakerDevices.set).not.toHaveBeenCalled();
  });

  // Headset unplugged: stay on the SDK's default silently; the saved choice is
  // untouched and applies on the next device change that brings it back.
  it('a saved device that is not connected is left alone (missing), never forced', async () => {
    const audio = fakeAudio();
    const r = await applySavedAudioPrefs(audio, { input: 'gone-mic', output: 'gone-spk' }, { includeInput: true });
    expect(r).toEqual({ input: 'missing', output: 'missing' });
    expect(audio.setInputDevice).not.toHaveBeenCalled();
    expect(audio.speakerDevices.set).not.toHaveBeenCalled();
  });

  // No choice saved: exactly today's behaviour — the SDK manages the default.
  it('no saved choice touches nothing', async () => {
    const audio = fakeAudio({ inputDevice: { deviceId: 'default' } });
    const r = await applySavedAudioPrefs(audio, { input: null, output: null }, { includeInput: true });
    expect(r).toEqual({ input: 'default', output: 'default' });
    expect(audio.unsetInputDevice).not.toHaveBeenCalled();
    expect(audio.setInputDevice).not.toHaveBeenCalled();
    expect(audio.speakerDevices.set).not.toHaveBeenCalled();
  });

  // During a call the mic watcher owns re-pinning (it honours the saved mic).
  it('includeInput:false leaves the mic to the watcher but still applies the speaker', async () => {
    const audio = fakeAudio();
    const r = await applySavedAudioPrefs(audio, { input: 'jabra', output: 'spk-jabra' }, { includeInput: false });
    expect(r).toEqual({ input: 'skipped', output: 'applied' });
    expect(audio.setInputDevice).not.toHaveBeenCalled();
  });

  it('reports failed (never throws) when the SDK refuses', async () => {
    const audio = fakeAudio({ setInputDevice: vi.fn(async () => { throw new Error('NotReadableError'); }) });
    vi.mocked(audio.speakerDevices.set).mockRejectedValueOnce(new Error('NotAllowedError'));
    const r = await applySavedAudioPrefs(audio, { input: 'jabra', output: 'spk-jabra' }, { includeInput: true });
    expect(r).toEqual({ input: 'failed', output: 'failed' });
  });

  it('a partial AudioHelper (no output collections) skips the speaker', async () => {
    const audio = fakeAudio({ speakerDevices: undefined, ringtoneDevices: undefined, availableOutputDevices: undefined });
    const r = await applySavedAudioPrefs(audio, { input: null, output: 'spk-jabra' }, { includeInput: true });
    expect(r.output).toBe('skipped');
  });
});

describe('keepSavedAudioPrefs (wired once per Device)', () => {
  function withEmitter() {
    const listeners: Array<(...a: unknown[]) => void> = [];
    const audio = fakeAudio({ on: vi.fn((_e: string, cb: (...a: unknown[]) => void) => { listeners.push(cb); }) });
    return { audio, emitDeviceChange: () => listeners.forEach((cb) => cb([])) };
  }
  const hooks = (over: Partial<Parameters<typeof keepSavedAudioPrefs>[1]> = {}) => ({
    loadPrefs: () => ({ input: 'jabra', output: 'spk-jabra' }),
    isCallUp: () => false,
    isCurrent: () => true,
    onFailed: vi.fn(),
    ...over,
  });

  // The SDK's first device listing emits deviceChange and THEN (same turn) sets
  // its speakers to 'default'; applying on the next task lands after that.
  it("applies on the SDK's deviceChange, one task later", async () => {
    vi.useFakeTimers();
    try {
      const { audio, emitDeviceChange } = withEmitter();
      keepSavedAudioPrefs(audio, hooks());
      emitDeviceChange();
      expect(audio.setInputDevice).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(audio.setInputDevice).toHaveBeenCalledWith('jabra');
      expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-jabra');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the returned apply runs now; it leaves the mic alone while a call is up', async () => {
    const { audio } = withEmitter();
    const apply = keepSavedAudioPrefs(audio, hooks({ isCallUp: () => true }));
    apply();
    await vi.waitFor(() => expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-jabra'));
    expect(audio.setInputDevice).not.toHaveBeenCalled();
  });

  it('a replaced (stale) Device is never touched', async () => {
    const { audio } = withEmitter();
    keepSavedAudioPrefs(audio, hooks({ isCurrent: () => false }))();
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.setInputDevice).not.toHaveBeenCalled();
    expect(audio.speakerDevices.set).not.toHaveBeenCalled();
  });

  // teardownDevice (lost leadership → hidden tab) can run while the keeper's
  // getUserMedia is still pending. The SDK then finishes on the destroyed
  // AudioHelper and holds the mic until reload — release it.
  it('a switch that finishes after the Device was torn down releases the mic', async () => {
    const { audio } = withEmitter();
    let finish: () => void = () => {};
    audio.setInputDevice = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    audio.unsetInputDevice = vi.fn(async () => { throw new Error('destroyed'); });
    let current = true;
    keepSavedAudioPrefs(audio, hooks({ isCurrent: () => current }))();
    await vi.waitFor(() => expect(audio.setInputDevice).toHaveBeenCalledWith('jabra'));
    current = false; // teardownDevice ran
    finish();
    await vi.waitFor(() => expect(audio.unsetInputDevice).toHaveBeenCalled());
  });

  it('a switch that finishes while the Device is still current keeps the mic', async () => {
    const { audio } = withEmitter();
    keepSavedAudioPrefs(audio, hooks())();
    await vi.waitFor(() => expect(audio.setInputDevice).toHaveBeenCalledWith('jabra'));
    await new Promise((r) => setTimeout(r, 0));
    expect(audio.unsetInputDevice).not.toHaveBeenCalled();
  });

  it('reports a refused device so the app can tell the rep', async () => {
    const { audio } = withEmitter();
    vi.mocked(audio.setInputDevice).mockRejectedValueOnce(new Error('NotReadableError'));
    const h = hooks();
    keepSavedAudioPrefs(audio, h)();
    await vi.waitFor(() => expect(h.onFailed).toHaveBeenCalledWith({ input: 'failed', output: 'applied' }));
  });
});

describe('applyChoiceFromStorage (Settings changed in another tab)', () => {
  it('applies the direction whose key changed, as an explicit choice', async () => {
    const audio = fakeAudio({ inputDevice: { deviceId: 'jabra' } });
    await applyChoiceFromStorage(audio, 'cti.audio.output', { input: null, output: 'spk-jabra' });
    expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-jabra');
    await applyChoiceFromStorage(audio, 'cti.audio.input', { input: null, output: 'spk-jabra' });
    expect(audio.unsetInputDevice).toHaveBeenCalled();
  });

  it('ignores keys that are not ours', () => {
    expect(applyChoiceFromStorage(fakeAudio(), 'cti.session.v1', { input: null, output: null })).toBeNull();
    expect(applyChoiceFromStorage(fakeAudio(), null, { input: null, output: null })).toBeNull();
  });
});

describe('createAudioDevicePort', () => {
  function env(over: Partial<AudioEnvironment> = {}): AudioEnvironment {
    return {
      mediaDevices: {
        enumerateDevices: vi.fn(async () => [{ kind: 'audioinput', deviceId: 'jabra', label: 'Jabra' }]),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      canSetSinkId: true,
      createAudioElement: () => ({ src: '', play: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}) }),
      ...over,
    };
  }

  it('lists devices from navigator.mediaDevices, [] when the browser has none', async () => {
    expect(await createAudioDevicePort(() => null, env()).listDevices()).toEqual([{ kind: 'audioinput', deviceId: 'jabra', label: 'Jabra' }]);
    expect(await createAudioDevicePort(() => null, env({ mediaDevices: null })).listDevices()).toEqual([]);
  });

  it("subscribes to 'devicechange' and unsubscribes", () => {
    const e = env();
    const listener = vi.fn();
    const off = createAudioDevicePort(() => null, e).onDeviceChange(listener);
    expect(e.mediaDevices!.addEventListener).toHaveBeenCalledWith('devicechange', listener);
    off();
    expect(e.mediaDevices!.removeEventListener).toHaveBeenCalledWith('devicechange', listener);
  });

  it('can choose the speaker only with setSinkId AND an SDK that supports output selection', () => {
    expect(createAudioDevicePort(() => null, env()).canChooseOutput()).toBe(true);
    expect(createAudioDevicePort(() => null, env({ canSetSinkId: false })).canChooseOutput()).toBe(false);
    expect(createAudioDevicePort(() => fakeAudio({ isOutputSelectionSupported: false }), env()).canChooseOutput()).toBe(false);
  });

  // A non-leader tab has no Device: the choice is saved and applied when the
  // Device appears (or by the leader tab, via the storage event).
  it('with no live Device the choosers resolve without doing anything', async () => {
    const port = createAudioDevicePort(() => null, env());
    await expect(port.setInputDevice('jabra')).resolves.toBeUndefined();
    await expect(port.unsetInputDevice()).resolves.toBeUndefined();
    await expect(port.setOutputDevice('spk-jabra')).resolves.toBeUndefined();
  });

  it('with a live Device the choosers drive its AudioHelper', async () => {
    const audio = fakeAudio();
    const port = createAudioDevicePort(() => audio, env());
    await port.setInputDevice('jabra');
    await port.setOutputDevice('spk-jabra');
    expect(audio.setInputDevice).toHaveBeenCalledWith('jabra');
    expect(audio.speakerDevices.set).toHaveBeenCalledWith('spk-jabra');
  });
});

describe('playTestTone', () => {
  it('plays a short tone on the chosen speaker via setSinkId', async () => {
    const el = { src: '', play: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}) };
    await playTestTone('spk-jabra', el);
    expect(el.src).toBe(testToneDataUri());
    expect(el.setSinkId).toHaveBeenCalledWith('spk-jabra');
    expect(el.play).toHaveBeenCalled();
  });

  it('System default plays without choosing a sink', async () => {
    const el = { src: '', play: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}) };
    await playTestTone('default', el);
    expect(el.setSinkId).not.toHaveBeenCalled();
    expect(el.play).toHaveBeenCalled();
  });

  it('the tone is a playable WAV data URI', () => {
    const uri = testToneDataUri();
    expect(uri.startsWith('data:audio/wav;base64,UklGR')).toBe(true); // "RIFF"
    expect(uri.length).toBeGreaterThan(1000);
  });
});

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserChimeDeps, CHIME_BEEPS, CHIME_GAP_MS, playCallbackChime } from './callback-chime';
import { testToneDataUri } from './audio-device-port';

const el = () => ({ src: '', play: vi.fn(async () => {}), setSinkId: vi.fn(async () => {}) });

afterEach(() => { localStorage.clear(); });

describe('playCallbackChime — the SDK plays no ringtone while the rep is on the run leg, so this is the only sound', () => {
  it('beeps twice on the speaker chosen in Settings, a short gap apart', async () => {
    expect(CHIME_BEEPS).toBe(2);
    const els = [el(), el()];
    let i = 0;
    const wait = vi.fn(async () => {});
    await playCallbackChime({ createAudioElement: () => els[i++]!, outputDeviceId: () => 'spk-jabra', wait });
    for (const e of els) {
      expect(e.src).toBe(testToneDataUri());
      expect(e.setSinkId).toHaveBeenCalledWith('spk-jabra');
      expect(e.play).toHaveBeenCalledTimes(1);
    }
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait).toHaveBeenCalledWith(CHIME_GAP_MS);
  });

  it('"System default" plays on the browser default output — no setSinkId', async () => {
    const e = el();
    await playCallbackChime({ createAudioElement: () => e, outputDeviceId: () => 'default', wait: async () => {} });
    expect(e.setSinkId).not.toHaveBeenCalled();
    expect(e.play).toHaveBeenCalledTimes(2);
  });

  it('a play() the browser refuses rejects, so the caller can log it', async () => {
    const e = { src: '', play: vi.fn(async () => { throw new Error('NotAllowedError'); }) };
    await expect(playCallbackChime({ createAudioElement: () => e, outputDeviceId: () => 'default', wait: async () => {} })).rejects.toThrow('NotAllowedError');
  });

  it('the browser deps read the speaker saved in Settings, else the default', () => {
    expect(browserChimeDeps().outputDeviceId()).toBe('default');
    localStorage.setItem('cti.audio.output', 'spk-jabra');
    expect(browserChimeDeps().outputDeviceId()).toBe('spk-jabra');
  });
});

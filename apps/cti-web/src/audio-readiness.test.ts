import { describe, expect, it, vi } from 'vitest';
import { isLikelyDeadAudio, prewarmMic, resumeAudio } from './audio-readiness';

describe('isLikelyDeadAudio', () => {
  it('true when every sample is silent and we have enough samples', () => {
    expect(isLikelyDeadAudio([0, 0, 0, 0])).toBe(true);
  });
  it('false as soon as any sample carries audio', () => {
    expect(isLikelyDeadAudio([0, 0, 0.02, 0])).toBe(false);
  });
  it('false when we do not yet have enough samples to judge', () => {
    expect(isLikelyDeadAudio([0, 0])).toBe(false);
  });
});

describe('prewarmMic', () => {
  it('resolves true and stops the primed tracks when getUserMedia succeeds', async () => {
    const stop = vi.fn();
    const getMedia = vi.fn(async () => ({ getTracks: () => [{ stop }] }));
    await expect(prewarmMic(getMedia)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  it('resolves false (never throws) when the mic is denied', async () => {
    const getMedia = vi.fn(async () => { throw new Error('NotAllowedError'); });
    await expect(prewarmMic(getMedia)).resolves.toBe(false);
  });
});

describe('resumeAudio', () => {
  it('resumes a suspended AudioContext', () => {
    const resume = vi.fn(async () => {});
    resumeAudio({ state: 'suspended', resume });
    expect(resume).toHaveBeenCalled();
  });
  it('does nothing for a running or null context', () => {
    const resume = vi.fn(async () => {});
    resumeAudio({ state: 'running', resume });
    resumeAudio(null);
    expect(resume).not.toHaveBeenCalled();
  });
});

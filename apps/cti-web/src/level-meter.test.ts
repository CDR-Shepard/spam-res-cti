import { describe, expect, it, vi } from 'vitest';
import { createLevelSource, levelFromRms, METER_FFT_SIZE, rms, type AudioContextLike, type MicStreamLike } from './level-meter';

describe('rms / levelFromRms', () => {
  it('rms of a ±0.5 square wave is 0.5; silence and no samples are 0', () => {
    expect(rms([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
    expect(rms([0, 0, 0])).toBe(0);
    expect(rms([])).toBe(0);
  });

  it('speech-level RMS fills the bar part-way; loud is capped at full; silence and NaN are empty', () => {
    expect(levelFromRms(0.1)).toBeCloseTo(0.4);
    expect(levelFromRms(0.5)).toBe(1);
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(Number.NaN)).toBe(0);
  });
});

describe('createLevelSource', () => {
  function fakeCtx(fill: number) {
    const analyser = { fftSize: 0, getFloatTimeDomainData: vi.fn((a: Float32Array) => { a.fill(fill); }) };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const createMediaStreamSource = vi.fn(() => source);
    const close = vi.fn(async () => {});
    const ctx: AudioContextLike = { createMediaStreamSource, createAnalyser: () => analyser, close };
    return { ctx, analyser, source, createMediaStreamSource, close };
  }
  const stream: MicStreamLike = { getTracks: () => [] };

  it('wires the stream into a 1024-sample analyser and reads the level from it', () => {
    const f = fakeCtx(0.1);
    const meter = createLevelSource(stream, f.ctx);
    expect(f.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(f.source.connect).toHaveBeenCalledWith(f.analyser);
    expect(f.analyser.fftSize).toBe(METER_FFT_SIZE);
    expect(meter.read()).toBeCloseTo(0.4);
  });

  it('close() disconnects and closes the AudioContext once; reads after close are 0', () => {
    const f = fakeCtx(0.1);
    const meter = createLevelSource(stream, f.ctx);
    meter.close();
    meter.close();
    expect(f.source.disconnect).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(meter.read()).toBe(0);
  });
});

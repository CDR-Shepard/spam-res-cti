import { describe, expect, it } from 'vitest';
import { fromMuLaw, muLaw, phoneDownsampler } from './phone-audio.js';

/** 16-bit little-endian PCM at 16 kHz. */
function pcm16(samples: readonly number[]): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(Math.round(s), i * 2));
  return b;
}
const tone = (hz: number, seconds: number, amp = 10_000): number[] =>
  Array.from({ length: Math.round(16_000 * seconds) }, (_, n) => amp * Math.sin((2 * Math.PI * hz * n) / 16_000));
/** RMS of the decoded phone audio, skipping the filter's first few milliseconds. */
const rms = (ulaw: Buffer): number => {
  const s = [...ulaw].slice(80).map(fromMuLaw);
  return Math.sqrt(s.reduce((a, x) => a + x * x, 0) / s.length);
};

describe('muLaw', () => {
  it('is G.711 μ-law: silence is 0xFF, and a round trip keeps the level', () => {
    expect(muLaw(0)).toBe(0xff);
    for (const x of [-20_000, -1000, -50, 50, 1000, 20_000]) {
      expect(Math.abs(fromMuLaw(muLaw(x)) - x)).toBeLessThanOrEqual(Math.abs(x) * 0.07 + 8);
    }
  });
});

describe('phoneDownsampler — ElevenLabs 16 kHz PCM to the phone line (8 kHz μ-law)', () => {
  it('silence in is phone silence out, at half the samples', () => {
    const out = phoneDownsampler().push(pcm16(new Array(1600).fill(0)));
    expect(out.length).toBe(800);
    expect(new Set(out)).toEqual(new Set([0xff]));
  });

  it('keeps the speech band: a 1 kHz tone comes out at the same level', () => {
    const inRms = 10_000 / Math.SQRT2;
    expect(rms(phoneDownsampler().push(pcm16(tone(1000, 0.5))))).toBeGreaterThan(inRms * 0.9);
  });

  it("removes what the phone can't carry: a 6 kHz tone (which would fold back as a 2 kHz whine) is nearly gone", () => {
    const inRms = 10_000 / Math.SQRT2;
    expect(rms(phoneDownsampler().push(pcm16(tone(6000, 0.5))))).toBeLessThan(inRms * 0.05);
  });

  it('chunks split anywhere, even mid-sample, give the same audio as one piece', () => {
    const input = pcm16(tone(700, 0.2).map((s, i) => s + (i % 7) * 300));
    const whole = phoneDownsampler().push(input);
    const d = phoneDownsampler();
    const cuts = [1, 2, 3, 7, 100, 101, 555, 1000, 3001, input.length];
    let from = 0;
    const parts = cuts.map((to) => {
      const part = d.push(input.subarray(from, to));
      from = to;
      return part;
    });
    expect(Buffer.concat(parts)).toEqual(whole);
  });
});

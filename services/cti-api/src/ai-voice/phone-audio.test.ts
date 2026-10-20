import { describe, expect, it } from 'vitest';
import { PHONE_FRAME_BYTES, fromMuLaw, lastFrame, muLaw, muLawWav, phoneAudio, phoneDownsampler, wholeFrames } from './phone-audio.js';

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

describe('wholeFrames / lastFrame — Twilio gets whole 20 ms frames only', () => {
  const bytes = (n: number, from = 0): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (from + i) % 256));

  it('a 20 ms frame is 160 bytes of phone audio', () => {
    expect(PHONE_FRAME_BYTES).toBe(160);
  });

  it('sends the whole frames and keeps the part frame for the next piece', () => {
    const first = wholeFrames(Buffer.alloc(0), bytes(379));
    expect(first.frames).toEqual(bytes(320));
    expect(first.carry).toEqual(bytes(59, 320));
    const second = wholeFrames(first.carry, bytes(150, 379));
    expect(second.frames).toEqual(bytes(160, 320));
    expect(second.carry).toEqual(bytes(49, 480));
  });

  it('a piece smaller than a frame is all kept', () => {
    const r = wholeFrames(Buffer.alloc(0), bytes(107));
    expect(r.frames.length).toBe(0);
    expect(r.carry).toEqual(bytes(107));
  });

  it('pieces split anywhere come out as the same audio, in whole frames', () => {
    const all = bytes(5000);
    let carry: Buffer = Buffer.alloc(0);
    const out: Buffer[] = [];
    let from = 0;
    for (const to of [1, 107, 379, 2274, 2275, 4000, 5000]) {
      const r = wholeFrames(carry, all.subarray(from, to));
      expect(r.frames.length % PHONE_FRAME_BYTES).toBe(0);
      out.push(r.frames);
      carry = r.carry;
      from = to;
    }
    expect(Buffer.concat([...out, carry])).toEqual(all);
  });

  it("a line's last part frame is filled out with silence; nothing left is nothing", () => {
    const last = lastFrame(bytes(59));
    expect(last.length).toBe(PHONE_FRAME_BYTES);
    expect(last.subarray(0, 59)).toEqual(bytes(59));
    expect(new Set(last.subarray(59))).toEqual(new Set([muLaw(0)]));
    expect(lastFrame(Buffer.alloc(0)).length).toBe(0);
  });
});

describe('muLawWav — a voicemail clip as a file Twilio <Play>s', () => {
  it('wraps μ-law in a WAV: format 7, mono, 8 kHz, 8-bit, then fact and data chunks', () => {
    const wav = muLawWav(Buffer.from([1, 2, 3, 4]));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.toString('ascii', 8, 16)).toBe('WAVEfmt ');
    expect([
      wav.readUInt32LE(16),
      wav.readUInt16LE(20),
      wav.readUInt16LE(22),
      wav.readUInt32LE(24),
      wav.readUInt32LE(28),
      wav.readUInt16LE(32),
      wav.readUInt16LE(34),
      wav.readUInt16LE(36),
    ]).toEqual([18, 7, 1, 8000, 8000, 1, 8, 0]);
    expect(wav.toString('ascii', 38, 42)).toBe('fact');
    expect([wav.readUInt32LE(42), wav.readUInt32LE(46)]).toEqual([4, 4]);
    expect(wav.toString('ascii', 50, 54)).toBe('data');
    expect(wav.readUInt32LE(54)).toBe(4);
    expect([...wav.subarray(58)]).toEqual([1, 2, 3, 4]);
  });

  it('pads an odd data chunk to an even length: counted in the RIFF size, not in the data size', () => {
    const wav = muLawWav(Buffer.from([9, 9, 9]));
    expect(wav.readUInt32LE(54)).toBe(3);
    expect(wav.readUInt32LE(46)).toBe(3);
    expect(wav.length).toBe(58 + 4);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav[61]).toBe(0);
  });
});

describe('phoneAudio — a whole 16 kHz clip made phone audio', () => {
  it('gives half as many μ-law bytes; silence stays phone silence', async () => {
    const out = await phoneAudio(Buffer.alloc(32_000)); // 1 s of 16 kHz silence
    expect(out.length).toBe(8_000);
    expect(new Set(out)).toEqual(new Set([0xff]));
  });

  it('is filtered like the live voice: a 6 kHz tone is nearly gone, a 1 kHz tone is kept', async () => {
    const inRms = 10_000 / Math.SQRT2;
    expect(rms(await phoneAudio(pcm16(tone(1000, 0.5))))).toBeGreaterThan(inRms * 0.9);
    expect(rms(await phoneAudio(pcm16(tone(6000, 0.5))))).toBeLessThan(inRms * 0.05);
  });

  it('comes out exactly as the live converter makes it in one piece, across its slices', async () => {
    const clip = pcm16(tone(440, 1.3).map((x, n) => x + 3000 * Math.sin(n / 7)));
    expect(await phoneAudio(clip)).toEqual(phoneDownsampler().push(clip));
  });

  it('yields to other work between slices, so a long clip never stalls the live calls', async () => {
    const order: string[] = [];
    const done = phoneAudio(Buffer.alloc(32_000 * 3)).then(() => order.push('audio'));
    setImmediate(() => order.push('other'));
    await done;
    expect(order).toEqual(['other', 'audio']);
  });
});

import { describe, expect, it } from 'vitest';
import {
  CallerSoundMeter,
  FLOOR_LOUD_RATE,
  FLOOR_QUIET_RATE,
  FRAME_BYTES,
  LOUD_OVER_FLOOR,
  MIN_LOUD_RMS,
  SOUND_GAP_MS,
  frameRms,
  muLawToLinear,
} from './bridge-sound.js';

/** One 20 ms frame of digital silence (μ-law 0xFF = 0) and one of full-scale sound (0x00 = −32124), as Twilio base64. */
const QUIET = Buffer.alloc(FRAME_BYTES, 0xff).toString('base64');
const LOUD = Buffer.alloc(FRAME_BYTES, 0x00).toString('base64');

/** G.711 μ-law encode, so tests can build frames at a chosen loudness. */
function muLawEncode(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = sample < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(Math.round(sample)), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (magnitude & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (magnitude >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One full frame alternating +amplitude / −amplitude, so its RMS is about `amplitude`. */
function frameAt(amplitude: number): Buffer {
  return Buffer.from(Array.from({ length: FRAME_BYTES }, (_, i) => muLawEncode(i % 2 === 0 ? amplitude : -amplitude)));
}

const b64 = (bytes: Buffer): string => bytes.toString('base64');

/** Push `count` copies of a base64 frame; returns runMs after the last one. */
function pushMany(meter: CallerSoundMeter, frame: string, count: number): number {
  let run = meter.runMs;
  for (let i = 0; i < count; i += 1) run = meter.push(frame);
  return run;
}

describe('muLawToLinear', () => {
  it('decodes the G.711 anchor values', () => {
    expect(muLawToLinear(0xff)).toBe(0);
    expect(muLawToLinear(0x7f)).toBe(0);
    expect(muLawToLinear(0x00)).toBe(-32124);
    expect(muLawToLinear(0x80)).toBe(32124);
  });

  it('is sign-symmetric: the same magnitude with the sign bit flipped', () => {
    for (let byte = 0; byte < 0x80; byte += 1) {
      expect(muLawToLinear(byte)).toBe(0 - muLawToLinear(byte | 0x80));
    }
  });

  it('round-trips encode → decode to within the μ-law step size', () => {
    for (const sample of [100, 300, 1500, 3000, 12000]) {
      const back = muLawToLinear(muLawEncode(sample));
      expect(Math.abs(back - sample) / sample).toBeLessThan(0.05);
    }
  });
});

describe('frameRms', () => {
  it('is 0 for an empty frame and for digital silence', () => {
    expect(frameRms(new Uint8Array(0))).toBe(0);
    expect(frameRms(Buffer.alloc(FRAME_BYTES, 0xff))).toBe(0);
  });

  it('is the RMS of the decoded samples', () => {
    expect(frameRms(Buffer.alloc(FRAME_BYTES, 0x00))).toBeCloseTo(32124, 5);
    expect(frameRms(Buffer.alloc(FRAME_BYTES, 0x80))).toBeCloseTo(32124, 5);
    expect(frameRms(frameAt(3000))).toBeGreaterThan(2850);
    expect(frameRms(frameAt(3000))).toBeLessThan(3150);
  });

  it('accepts a plain Uint8Array as well as a Buffer', () => {
    expect(frameRms(new Uint8Array(FRAME_BYTES).fill(0x00))).toBeCloseTo(32124, 5);
  });
});

describe('CallerSoundMeter', () => {
  it('is 0 before any loud frame and while the line is quiet', () => {
    const meter = new CallerSoundMeter();
    expect(meter.runMs).toBe(0);
    expect(pushMany(meter, QUIET, 50)).toBe(0);
    expect(meter.runMs).toBe(0);
  });

  it('counts 20 ms per loud frame, inclusive of the first', () => {
    const meter = new CallerSoundMeter();
    expect(meter.push(LOUD)).toBe(20);
    expect(meter.runMs).toBe(20);
    const thirty = new CallerSoundMeter();
    expect(pushMany(thirty, LOUD, 30)).toBe(600);
  });

  it('push returns the same value runMs reports', () => {
    const meter = new CallerSoundMeter();
    expect(meter.push(LOUD)).toBe(meter.runMs);
    expect(meter.push(QUIET)).toBe(meter.runMs);
  });

  it('measures from the first loud frame, not from the start of the call', () => {
    const meter = new CallerSoundMeter();
    pushMany(meter, QUIET, 40);
    expect(pushMany(meter, LOUD, 5)).toBe(100);
  });

  it('bridges quiet gaps shorter than SOUND_GAP_MS into one sound', () => {
    const meter = new CallerSoundMeter();
    pushMany(meter, LOUD, 10);
    pushMany(meter, QUIET, 10); // 200 ms gap
    expect(pushMany(meter, LOUD, 10)).toBe(600);
  });

  it('holds the span so far during a short gap', () => {
    const meter = new CallerSoundMeter();
    pushMany(meter, LOUD, 10);
    expect(pushMany(meter, QUIET, 3)).toBe(200);
    expect(pushMany(meter, QUIET, 11)).toBe(200); // 280 ms of quiet: still inside the gap
  });

  it('ends the sound after SOUND_GAP_MS of quiet, and a later loud frame starts a new one', () => {
    expect(SOUND_GAP_MS).toBe(300);
    const meter = new CallerSoundMeter();
    pushMany(meter, LOUD, 10);
    expect(pushMany(meter, QUIET, 14)).toBe(200);
    expect(meter.push(QUIET)).toBe(0); // the 15th quiet frame = 300 ms
    expect(meter.push(QUIET)).toBe(0);
    expect(meter.push(LOUD)).toBe(20);
  });

  it('starts a new sound at exactly the gap boundary, not a bridged one', () => {
    const meter = new CallerSoundMeter();
    pushMany(meter, LOUD, 10);
    pushMany(meter, QUIET, 15);
    expect(pushMany(meter, LOUD, 10)).toBe(200);
  });

  it('treats a multi-frame payload like the same frames pushed one at a time', () => {
    const together = new CallerSoundMeter();
    const apart = new CallerSoundMeter();
    const payload = b64(Buffer.concat([Buffer.from(LOUD, 'base64'), Buffer.from(LOUD, 'base64'), Buffer.from(QUIET, 'base64')]));
    expect(together.push(payload)).toBe(40);
    apart.push(LOUD);
    apart.push(LOUD);
    expect(apart.push(QUIET)).toBe(40);
    // and they keep agreeing as the gap runs out
    expect(pushMany(together, QUIET, 14)).toBe(pushMany(apart, QUIET, 14));
    expect(together.runMs).toBe(0);
  });

  it('counts a trailing partial frame by its own length (8 bytes per ms)', () => {
    const half = new CallerSoundMeter();
    expect(half.push(b64(Buffer.alloc(80, 0x00)))).toBe(10);
    const frameAndBit = new CallerSoundMeter();
    expect(frameAndBit.push(b64(Buffer.alloc(FRAME_BYTES + 40, 0x00)))).toBe(25);
  });

  it('keeps the audio clock honest across partial frames when judging the gap', () => {
    const meter = new CallerSoundMeter();
    meter.push(LOUD); // 0–20
    // 280 ms of quiet delivered as odd-sized pieces still bridges; 300 ms ends it
    meter.push(b64(Buffer.alloc(100, 0xff))); // 12.5 ms
    meter.push(b64(Buffer.alloc(2140, 0xff))); // 267.5 ms
    expect(meter.runMs).toBe(20); // 280 ms of quiet
    meter.push(b64(Buffer.alloc(160, 0xff))); // +20 ms = 300 ms
    expect(meter.runMs).toBe(0);
  });

  it('ignores empty and invalid input without throwing or moving the clock', () => {
    const meter = new CallerSoundMeter();
    pushMany(meter, LOUD, 10);
    expect(() => meter.push('')).not.toThrow();
    expect(meter.push('')).toBe(200);
    expect(meter.push('***not base64***')).toBe(200);
    expect(meter.push('AAAA!AAAA')).toBe(200);
    expect(meter.push(undefined as unknown as string)).toBe(200);
    expect(meter.push(null as unknown as string)).toBe(200);
    // 6 garbage payloads (2 empty, 2 invalid strings, undefined, null) must not have counted as 20 ms of "gap" each
    pushMany(meter, QUIET, 4);
    expect(meter.runMs).toBe(200);
  });

  it('ignores garbage before any audio arrives', () => {
    const meter = new CallerSoundMeter();
    expect(meter.push('***')).toBe(0);
    expect(meter.push(LOUD)).toBe(20);
  });

  it('exports the calibrated thresholds', () => {
    expect(FRAME_BYTES).toBe(160);
    expect(MIN_LOUD_RMS).toBe(300);
    expect(LOUD_OVER_FLOOR).toBe(4);
    expect(FLOOR_QUIET_RATE).toBeGreaterThan(FLOOR_LOUD_RATE);
  });

  describe('noise floor', () => {
    it('a steady low hum never counts as loud, and speech on top of it does', () => {
      const meter = new CallerSoundMeter();
      const hum = b64(frameAt(150));
      expect(frameRms(Buffer.from(hum, 'base64'))).toBeGreaterThan(130);
      for (let i = 0; i < 250; i += 1) expect(meter.push(hum)).toBe(0); // 5 s of hum
      const speech = b64(frameAt(3000));
      expect(pushMany(meter, speech, 10)).toBe(200);
      expect(pushMany(meter, speech, 15)).toBe(500);
    });

    it('a steady hum below the loudness floor never counts, even on a fresh meter', () => {
      const meter = new CallerSoundMeter();
      expect(pushMany(meter, b64(frameAt(250)), 100)).toBe(0);
    });

    it('a line with a hum raises the bar above the fixed minimum', () => {
      const mid = b64(frameAt(600)); // louder than MIN_LOUD_RMS, so loud on a quiet line
      expect(pushMany(new CallerSoundMeter(), mid, 5)).toBe(100);

      const noisy = new CallerSoundMeter();
      pushMany(noisy, b64(frameAt(250)), 100); // floor catches up to ~250, so the bar is ~1000
      expect(pushMany(noisy, mid, 5)).toBe(0);
      expect(pushMany(noisy, b64(frameAt(3000)), 5)).toBe(100);
    });

    it('steady loud noise eventually stops counting as talk', () => {
      const meter = new CallerSoundMeter();
      const noise = b64(frameAt(1500));
      expect(meter.push(noise)).toBe(20); // starts out counted
      expect(pushMany(meter, noise, 49)).toBe(1000); // and still counted a second in
      expect(pushMany(meter, noise, 1500 - 50)).toBe(0); // 30 s in, the floor has caught up
    });

    it('a 2 s speech-level run counts throughout', () => {
      const meter = new CallerSoundMeter();
      const speech = b64(frameAt(3000));
      for (let i = 1; i <= 100; i += 1) expect(meter.push(speech)).toBe(i * 20);
    });

    it('speech after a long pause still counts: the floor falls back with the quiet', () => {
      const meter = new CallerSoundMeter();
      pushMany(meter, b64(frameAt(1500)), 1500); // noisy stretch, floor ≈ 1500
      pushMany(meter, QUIET, 100); // 2 s of silence: floor decays toward its minimum
      expect(pushMany(meter, b64(frameAt(1500)), 5)).toBe(100);
    });
  });
});

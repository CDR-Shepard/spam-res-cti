/**
 * Measures how long the caller's current sound has been going, from the audio
 * itself rather than from transcribed words (which arrive a second or more after
 * the caller starts). The bridge uses it to tell a real interruption from a
 * listening sound: "mm-hmm", "yeah" and "okay" are over in about half a second,
 * while a real reply keeps going past ~600 ms.
 *
 * Each inbound Twilio media payload (8 kHz μ-law, 20 ms frames) is split into
 * frames and each frame measured:
 *
 * - a frame is loud when its RMS is at least `MIN_LOUD_RMS` and at least
 *   `LOUD_OVER_FLOOR` times the line's noise floor;
 * - the noise floor follows the line's own noise: quickly on quiet frames, slowly
 *   on loud ones, so a steady hum raises the bar but speech does not;
 * - a sound runs from its first loud frame to its last loud frame; quiet gaps
 *   shorter than `SOUND_GAP_MS` (the pause inside "mm … hmm", between words) do
 *   not end it, and `SOUND_GAP_MS` of quiet resets it to 0.
 *
 * Time is the meter's own audio clock (milliseconds of caller audio seen), so it
 * needs no timers and is exact however the payloads arrive. It keeps only the
 * numbers above, never the audio.
 */

/** Twilio media is 8 kHz μ-law: 8 bytes per ms, 160 bytes per 20 ms frame. */
export const FRAME_BYTES = 160;
/** Quiet gaps shorter than this inside a sound do not end it ("mm … hmm", the pause between words). */
export const SOUND_GAP_MS = 300;
/** A frame is loud only at or above this RMS (16-bit linear scale) … */
export const MIN_LOUD_RMS = 300;
/** … and at least this many times the line's noise floor. */
export const LOUD_OVER_FLOOR = 4;
/** How fast the noise floor follows a quiet frame (per frame): it tracks the line's noise within ~0.5 s. */
export const FLOOR_QUIET_RATE = 0.05;
/** How fast the noise floor follows a loud frame (per frame): slow, so steady loud noise eventually stops counting as talk but speech does not. */
export const FLOOR_LOUD_RATE = 0.002;

/** μ-law 8 kHz mono: 8 bytes per millisecond. */
const BYTES_PER_MS = 8;
/** Where the noise floor starts, and the lowest it may fall (16-bit linear RMS). */
const INITIAL_NOISE_FLOOR = 50;
const MIN_NOISE_FLOOR = 20;
/** Standard base64 alphabet with optional padding; anything else is not a Twilio payload. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** G.711 μ-law byte → 16-bit linear sample, built once. */
const DECODE_TABLE: readonly number[] = Array.from({ length: 256 }, (_, byte) => {
  const inverted = ~byte & 0xff;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  // `0 - magnitude` rather than `-magnitude`, so a zero sample is +0 and never -0.
  return inverted & 0x80 ? 0 - magnitude : magnitude;
});

/** Standard G.711 μ-law decode of one byte: 0xFF → 0, 0x7F → 0, 0x00 → −32124, 0x80 → +32124. */
export function muLawToLinear(byte: number): number {
  return DECODE_TABLE[byte & 0xff] ?? 0;
}

/** RMS of a μ-law frame's decoded samples (16-bit linear scale); 0 for an empty frame. */
export function frameRms(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let sumSquares = 0;
  for (const byte of bytes) {
    const sample = muLawToLinear(byte);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / bytes.length);
}

export class CallerSoundMeter {
  /** Milliseconds of caller audio seen so far; the frame being measured starts here. */
  private clockMs = 0;
  /** The line's noise level (RMS), as learned from the audio so far. */
  private noiseFloor = INITIAL_NOISE_FLOOR;
  /** Start of the current sound's first loud frame, or null before any loud frame. */
  private soundStartMs: number | null = null;
  /** End of the most recent loud frame, or null before any loud frame. */
  private lastLoudEndMs: number | null = null;

  /**
   * Feed one Twilio media payload (base64 μ-law). Returns `runMs` after it.
   * An empty, non-string or invalid payload is ignored (and does not advance the clock).
   */
  push(payloadBase64: string): number {
    if (typeof payloadBase64 !== 'string' || payloadBase64.length === 0 || !BASE64_PATTERN.test(payloadBase64)) {
      return this.runMs;
    }
    const audio = Buffer.from(payloadBase64, 'base64');
    for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
      this.onFrame(audio.subarray(offset, offset + FRAME_BYTES));
    }
    return this.runMs;
  }

  /**
   * Length of the caller's current sound in ms: from its first loud frame to its last loud frame (inclusive),
   * while less than `SOUND_GAP_MS` of quiet has followed it; 0 once that much quiet has passed, and 0 before any loud frame.
   */
  get runMs(): number {
    if (this.soundStartMs === null || this.lastLoudEndMs === null) return 0;
    if (this.clockMs - this.lastLoudEndMs >= SOUND_GAP_MS) return 0;
    return this.lastLoudEndMs - this.soundStartMs;
  }

  /** Measure one frame (full, or the shorter tail of a payload) and advance the audio clock past it. */
  private onFrame(frame: Uint8Array): void {
    const startMs = this.clockMs;
    const endMs = startMs + frame.length / BYTES_PER_MS;
    const rms = frameRms(frame);
    const loud = rms >= Math.max(MIN_LOUD_RMS, this.noiseFloor * LOUD_OVER_FLOOR);

    if (loud) {
      const hasSound = this.lastLoudEndMs !== null && startMs - this.lastLoudEndMs < SOUND_GAP_MS;
      if (!hasSound) this.soundStartMs = startMs;
      this.lastLoudEndMs = endMs;
    }
    this.noiseFloor = Math.max(
      MIN_NOISE_FLOOR,
      this.noiseFloor + (rms - this.noiseFloor) * (loud ? FLOOR_LOUD_RATE : FLOOR_QUIET_RATE),
    );
    this.clockMs = endMs;
  }
}

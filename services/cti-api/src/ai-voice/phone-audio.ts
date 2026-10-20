/**
 * ElevenLabs' 16 kHz PCM made into Twilio's 8 kHz μ-law here, rather than by ElevenLabs (owner's first call
 * 2026-10-19: crackle on Sam's s/t/k sounds). ElevenLabs' own ulaw_8000 kept more of the harsh top end (energy above
 * 3 kHz 0.91 % vs 0.56 % this way; OpenAI's voice 0.46 %). A 63-tap windowed-sinc low-pass at 3.4 kHz (the phone band),
 * every second sample kept, then G.711 μ-law. Causal, so the audio is ~2 ms late; chunks may split anywhere.
 */
const SOURCE_RATE = 16_000;
export const PHONE_CUTOFF_HZ = 3400;
const TAPS = 63;

/** Hamming-windowed sinc, normalised to unity gain at 0 Hz. */
const FILTER: readonly number[] = (() => {
  const fc = PHONE_CUTOFF_HZ / SOURCE_RATE;
  const raw = Array.from({ length: TAPS }, (_, n) => {
    const m = n - (TAPS - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (TAPS - 1)));
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((h) => h / sum);
})();

const MU_BIAS = 0x84;
const MU_CLIP = 32_635;

/** G.711 μ-law encoding of one 16-bit sample. */
export function muLaw(sample: number): number {
  let s = Math.max(-32_768, Math.min(32_767, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s = Math.min(s, MU_CLIP) + MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent -= 1, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** G.711 μ-law decoding of one byte. */
export function fromMuLaw(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const magnitude = ((((u & 0x0f) << 3) + MU_BIAS) << exponent) - MU_BIAS;
  return u & 0x80 ? -magnitude : magnitude;
}

export interface PhoneDownsampler {
  /** 16-bit little-endian PCM at 16 kHz in, 8 kHz μ-law out (what is complete so far). */
  push(pcm16le: Buffer): Buffer;
}

/** One per stretch of audio (a line): it keeps the filter's last samples and any half sample between chunks. */
export function phoneDownsampler(): PhoneDownsampler {
  let history: number[] = new Array<number>(TAPS - 1).fill(0);
  let halfSample: Buffer = Buffer.alloc(0);
  /** Samples seen so far: every even one makes an output sample. */
  let seen = 0;

  return {
    push(chunk) {
      const bytes = halfSample.length ? Buffer.concat([halfSample, chunk]) : chunk;
      const whole = bytes.length - (bytes.length % 2);
      halfSample = Buffer.from(bytes.subarray(whole));
      const fresh = Array.from({ length: whole / 2 }, (_, i) => bytes.readInt16LE(i * 2));
      const x = [...history, ...fresh];
      const out: number[] = [];
      fresh.forEach((_, i) => {
        if ((seen + i) % 2 !== 0) return;
        const at = TAPS - 1 + i;
        let y = 0;
        for (let k = 0; k < TAPS; k += 1) y += (FILTER[k] ?? 0) * (x[at - k] ?? 0);
        out.push(muLaw(y));
      });
      seen += fresh.length;
      history = x.slice(x.length - (TAPS - 1));
      return Buffer.from(out);
    },
  };
}

/**
 * Twilio plays the phone line in 20 ms frames. The OpenAI voice arrives in whole frames (400 ms pieces); ElevenLabs'
 * pieces are any size (13 ms to ~1 s), and on the owner's call (2026-10-19) Sam cut in and out on the phone though
 * the same audio played clean as a file. So the voice hands the bridge whole frames only: a piece's part frame waits
 * for the next piece, and a line's last one is filled out with silence (at most 20 ms).
 */
export const PHONE_FRAME_BYTES = 160;
const MU_LAW_SILENCE = muLaw(0);
const EMPTY = Buffer.alloc(0);

/** `carry` (a part frame kept from before) and `audio`, as the whole frames to send now and the part frame to keep. */
export function wholeFrames(carry: Buffer, audio: Buffer): { frames: Buffer; carry: Buffer } {
  const all = carry.length ? Buffer.concat([carry, audio]) : audio;
  const whole = all.length - (all.length % PHONE_FRAME_BYTES);
  return { frames: all.subarray(0, whole), carry: whole === all.length ? EMPTY : Buffer.from(all.subarray(whole)) };
}

/** A line's last part frame, filled out with silence (nothing if there is none). */
export function lastFrame(carry: Buffer): Buffer {
  if (!carry.length) return EMPTY;
  return Buffer.concat([carry, Buffer.alloc(PHONE_FRAME_BYTES - carry.length, MU_LAW_SILENCE)]);
}

/** Half a second of 16 kHz PCM: the most phoneAudio converts before letting other work run (~0.7 ms of filtering). */
const PHONE_AUDIO_SLICE_BYTES = 16_000;
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A whole 16 kHz clip (a voicemail) as phone audio: the same filter and μ-law as the live voice. Converted half a
 * second at a time with a yield between, because in one go a 15 s voicemail holds the event loop ~20 ms, as long as
 * a live call's audio frame.
 */
export async function phoneAudio(pcm16le: Buffer): Promise<Buffer> {
  const phone = phoneDownsampler();
  const out: Buffer[] = [];
  for (let at = 0; at < pcm16le.length; at += PHONE_AUDIO_SLICE_BYTES) {
    if (at > 0) await nextTurn();
    out.push(phone.push(pcm16le.subarray(at, at + PHONE_AUDIO_SLICE_BYTES)));
  }
  return Buffer.concat(out);
}

const PHONE_RATE = 8_000;
/** WAVE_FORMAT_MULAW. */
const WAV_MU_LAW = 7;
/** RIFF + WAVE, an 18-byte fmt chunk, a fact chunk and the data chunk's header. */
const WAV_HEADER_BYTES = 58;

/**
 * 8 kHz μ-law in a WAV file, the form Twilio's `<Play>` takes without converting it again (its docs prefer lossless
 * 8 kHz audio). A non-PCM WAV carries cbSize and a fact chunk (the sample count); an odd data chunk gets a pad byte.
 */
export function muLawWav(ulaw: Buffer): Buffer {
  const pad = ulaw.length % 2;
  const head = Buffer.alloc(WAV_HEADER_BYTES);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(WAV_HEADER_BYTES - 8 + ulaw.length + pad, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(18, 16);
  head.writeUInt16LE(WAV_MU_LAW, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(PHONE_RATE, 24);
  head.writeUInt32LE(PHONE_RATE, 28);
  head.writeUInt16LE(1, 32);
  head.writeUInt16LE(8, 34);
  head.writeUInt16LE(0, 36);
  head.write('fact', 38, 'ascii');
  head.writeUInt32LE(4, 42);
  head.writeUInt32LE(ulaw.length, 46);
  head.write('data', 50, 'ascii');
  head.writeUInt32LE(ulaw.length, 54);
  return Buffer.concat([head, ulaw, Buffer.alloc(pad)]);
}

/**
 * The sound check's live microphone level: an AnalyserNode on a short-lived
 * getUserMedia stream. The level is the RMS of the time-domain samples, read
 * every 100 ms by a timer rather than requestAnimationFrame, which stops in a
 * hidden tab or a collapsed Salesforce utility panel. The AudioContext is
 * injected, so jsdom tests hand in a fake.
 */
export const METER_INTERVAL_MS = 100;
export const METER_FFT_SIZE = 1024;
/** Normal speech (RMS ~0.05–0.2 of full scale) fills the bar to ~20–80 %. */
export const METER_GAIN = 4;

export interface MicTrackLike {
  stop(): void;
  /** 'ended': the device went away (unplugged) — not fired by our own stop(). */
  addEventListener?(type: 'ended', listener: () => void): void;
  removeEventListener?(type: 'ended', listener: () => void): void;
}
export interface MicStreamLike { getTracks(): MicTrackLike[] }
export interface AnalyserLike { fftSize: number; getFloatTimeDomainData(array: Float32Array): void }
export interface MediaSourceLike { connect(node: AnalyserLike): void; disconnect(): void }
export interface AudioContextLike {
  createMediaStreamSource(stream: MicStreamLike): MediaSourceLike;
  createAnalyser(): AnalyserLike;
  close(): Promise<void>;
  /** 'suspended' | 'running' | 'closed' (real AudioContexts always have it). */
  state?: string;
  resume?(): Promise<void>;
}
export interface LevelSource {
  /** 0..1, the bar's fill right now. */
  read(): number;
  /** Disconnect and close the AudioContext. The caller stops the stream. */
  close(): void;
}

/** Root mean square of samples in [-1, 1]; 0 for none. */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** The bar's fill, 0..1. */
export function levelFromRms(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value * METER_GAIN);
}

export function createLevelSource(stream: MicStreamLike, ctx: AudioContextLike): LevelSource {
  // Chrome starts a context suspended until the page has had a user gesture,
  // and a suspended analyser reads silence forever (Task 3 review I5). The
  // meter now starts on a click, so resuming here is allowed.
  if (ctx.state === 'suspended') {
    ctx.resume?.().catch(() => {
      // Still suspended (no gesture yet): the bar stays at 0 until one.
    });
  }
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = METER_FFT_SIZE;
  source.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  let closed = false;
  return {
    read() {
      if (closed) return 0;
      analyser.getFloatTimeDomainData(buffer);
      return levelFromRms(rms(buffer));
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        source.disconnect();
      } catch {
        // Already disconnected: nothing left to release.
      }
      ctx.close().catch(() => {
        // Already closed: the context no longer holds anything.
      });
    },
  };
}

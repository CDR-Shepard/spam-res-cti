/**
 * Tracks the agent audio the bridge has handed to Twilio but Twilio may not
 * have played yet, so a barge-in can cut the assistant item at the point the
 * caller actually heard (the Twilio speech-assistant sample's algorithm):
 *
 * - every inbound media frame advances `latestMediaMs` (Twilio's stream clock);
 * - the first chunk of each assistant item records the clock as its start;
 * - each forwarded chunk is followed by a named `mark`; Twilio echoes the mark
 *   once the audio before it has played, which shrinks the queue;
 * - on barge-in, played = clock − start, clamped to [0, audio generated].
 *
 * The audio left to play (for "late" overlaps) uses a separate estimate of when
 * the item starts playing: an item forwarded while an earlier one is still queued
 * starts once that one ends, not when it was forwarded. The truncate offset keeps
 * the forwarding time.
 *
 * It also lets the service wait for the agent's last words to finish before
 * hanging up or redirecting the call.
 */

/** μ-law 8 kHz mono: 8 bytes per millisecond. */
export const PCMU_BYTES_PER_MS = 8;
/** Slack on top of the audio still to play when waiting for it to drain (mark echoes trail the audio). */
export const DRAIN_MARGIN_MS = 1500;
/** The longest a drain wait ever lasts, however much audio is queued. */
export const PLAYBACK_DRAIN_CEILING_MS = 30_000;

export type SetTimer = (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
export type ClearTimer = (handle: ReturnType<typeof setTimeout>) => void;

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(b64: string): number {
  if (b64.length === 0) return 0;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export interface Truncation {
  itemId: string;
  audioEndMs: number;
}

interface DrainWaiter {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PlaybackTracker {
  private latestMediaMs = 0;
  private itemStartMs = 0;
  /** When the current item is estimated to start playing: after any item still queued ahead of it. */
  private playStartMs = 0;
  private itemId: string | null = null;
  private generatedBytes = 0;
  private marks: string[] = [];
  private markSeq = 0;
  private streaming = false;
  private busy = false;
  private waiters: DrainWaiter[] = [];
  private readonly setTimer: SetTimer;
  private readonly clearTimer: ClearTimer;
  private readonly onDrained: () => void;

  constructor(timers: { setTimer?: SetTimer; clearTimer?: ClearTimer; onDrained?: () => void } = {}) {
    this.setTimer = timers.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = timers.clearTimer ?? ((h) => clearTimeout(h));
    this.onDrained = timers.onDrained ?? (() => undefined);
  }

  /** True while some forwarded agent audio has not been confirmed played. */
  get playing(): boolean {
    return this.marks.length > 0 && this.itemId !== null;
  }

  /** Agent audio is still arriving: forwarded, and no `output_audio.done` / `response.done` for it yet. */
  get audioStreaming(): boolean {
    return this.streaming;
  }

  /** The agent item most recently forwarded (kept after it plays out, cleared on interrupt/reset), or null. */
  get currentItemId(): string | null {
    return this.itemId;
  }

  /** Agent audio left to play: Infinity while the response still streams, 0 when nothing is queued. */
  remainingMs(): number {
    if (this.streaming) return Number.POSITIVE_INFINITY;
    if (!this.playing) return 0;
    return Math.max(0, this.generatedMs() - (this.latestMediaMs - this.playStartMs));
  }

  /** An inbound Twilio media frame's `timestamp` (ms since stream start). */
  onInboundMedia(timestampMs: number): void {
    if (Number.isFinite(timestampMs) && timestampMs > this.latestMediaMs) this.latestMediaMs = timestampMs;
  }

  /** An agent audio chunk is being forwarded; returns the mark name to send right after it. */
  onAudioDelta(itemId: string, payload: string): string {
    if (itemId !== this.itemId) {
      // Still queued ahead of it: the previous item, from its own estimated start.
      const queuedEndMs = this.playing ? this.playStartMs + this.generatedMs() : 0;
      this.itemId = itemId;
      this.itemStartMs = this.latestMediaMs;
      this.playStartMs = Math.max(this.latestMediaMs, queuedEndMs);
      this.generatedBytes = 0;
    }
    this.generatedBytes += base64Bytes(payload);
    this.streaming = true;
    this.busy = true;
    this.markSeq += 1;
    const name = `agent-${this.markSeq}`;
    this.marks = [...this.marks, name];
    return name;
  }

  /** Twilio echoed a mark: that chunk and every earlier one has played. Unknown names are ignored. */
  onMark(name: string): void {
    const i = this.marks.indexOf(name);
    if (i < 0) return;
    this.marks = this.marks.slice(i + 1);
    this.settle();
  }

  /** `response.output_audio.done`: no more audio is coming for this response. */
  onAudioDone(): void {
    this.streaming = false;
    this.settle();
  }

  /** `response.done`: covers responses that end without an audio-done event (e.g. cancelled). */
  onResponseDone(): void {
    this.onAudioDone();
  }

  /** Where to cut the playing item (or null if nothing is playing); always resets tracking. */
  interrupt(): Truncation | null {
    const cut =
      this.playing && this.itemId !== null
        ? {
            itemId: this.itemId,
            audioEndMs: Math.max(0, Math.min(this.latestMediaMs - this.itemStartMs, this.generatedMs())),
          }
        : null;
    this.reset();
    return cut;
  }

  /** Forget everything queued (after a Twilio `clear`). */
  reset(): void {
    this.marks = [];
    this.itemId = null;
    this.itemStartMs = 0;
    this.playStartMs = 0;
    this.generatedBytes = 0;
    this.streaming = false;
    this.settle(false);
  }

  /**
   * Resolves when no audio is streaming and every mark has played, or after a cap: `maxMs`, stretched to the audio
   * still to play plus DRAIN_MARGIN_MS (a long goodbye is generated far faster than it plays), at most
   * PLAYBACK_DRAIN_CEILING_MS. While the response still streams its length is unknown, so the cap stays `maxMs`.
   */
  waitForDrain(maxMs: number): Promise<void> {
    if (this.drained()) return Promise.resolve();
    const left = this.remainingMs();
    const capMs = Number.isFinite(left) ? Math.min(Math.max(maxMs, left + DRAIN_MARGIN_MS), PLAYBACK_DRAIN_CEILING_MS) : maxMs;
    return new Promise<void>((resolve) => {
      const waiter: DrainWaiter = {
        resolve,
        timer: this.setTimer(() => this.release(waiter), capMs),
      };
      this.waiters = [...this.waiters, waiter];
    });
  }

  /** Resolve every pending waiter now (the bridge is shutting down). */
  releaseAll(): void {
    for (const w of this.waiters) this.release(w);
  }

  /** Audio generated for the current item so far, in ms. */
  private generatedMs(): number {
    return Math.floor(this.generatedBytes / PCMU_BYTES_PER_MS);
  }

  private drained(): boolean {
    return this.marks.length === 0 && !this.streaming;
  }

  /** Release drain waiters once drained; `notify` = the audio played out (not cut). */
  private settle(notify = true): void {
    if (!this.drained()) return;
    this.releaseAll();
    if (!this.busy) return;
    this.busy = false;
    if (notify) this.onDrained();
  }

  private release(waiter: DrainWaiter): void {
    if (!this.waiters.includes(waiter)) return;
    this.waiters = this.waiters.filter((w) => w !== waiter);
    this.clearTimer(waiter.timer);
    waiter.resolve();
  }
}

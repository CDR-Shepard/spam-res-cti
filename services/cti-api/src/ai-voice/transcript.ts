/**
 * Batches a live call's transcript lines into `ai_calls.transcript`: at most
 * one write per `intervalMs` while the call runs, writes strictly in order,
 * and an immediate flush on close. A failed write is logged, never thrown —
 * the call must not die because a transcript line was lost.
 */
import type { BridgeLog } from './bridge.js';
import type { TranscriptEntry } from './store.js';

export const TRANSCRIPT_FLUSH_MS = 1000;
/** Longest single line kept (a runaway turn must not bloat the row). */
export const TRANSCRIPT_LINE_MAX = 4000;

type Timer = ReturnType<typeof setTimeout>;

export interface TranscriptBufferOptions {
  log: BridgeLog;
  intervalMs?: number;
  setTimer?: (cb: () => void, ms: number) => Timer;
  clearTimer?: (h: Timer) => void;
}

export class TranscriptBuffer {
  private pending: readonly TranscriptEntry[] = [];
  private timer: Timer | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly intervalMs: number;
  private readonly setTimer: (cb: () => void, ms: number) => Timer;
  private readonly clearTimer: (h: Timer) => void;

  constructor(
    private readonly write: (entries: readonly TranscriptEntry[]) => Promise<void>,
    private readonly opts: TranscriptBufferOptions,
  ) {
    this.intervalMs = opts.intervalMs ?? TRANSCRIPT_FLUSH_MS;
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  }

  push(entry: { role: TranscriptEntry['role']; text: string; at: Date }): void {
    const line = { role: entry.role, text: entry.text.slice(0, TRANSCRIPT_LINE_MAX), at: entry.at.toISOString() };
    this.pending = [...this.pending, line];
    if (this.closed) {
      void this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = this.setTimer(() => {
        this.timer = null;
        void this.flush();
      }, this.intervalMs);
    }
  }

  /** Write everything pending now; resolves once every earlier write has finished. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) {
      this.chain = this.chain
        .then(() => this.write(batch))
        .catch((e: unknown) =>
          this.opts.log.error(
            { lines: batch.length, err: e instanceof Error ? e.message : String(e) },
            'ai-voice: transcript write failed',
          ),
        );
    }
    return this.chain;
  }

  /** Final flush; later lines are written straight away. */
  close(): Promise<void> {
    this.closed = true;
    return this.flush();
  }
}

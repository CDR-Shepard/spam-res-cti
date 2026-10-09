/**
 * One caller "overlap" at a time: the caller started talking while the agent was talking. The gate
 * keeps the agent talking through listening sounds ("mm-hmm", "yeah") and cuts it on a real
 * interruption: a stop word, two real words, or 3 s of talk with no word transcribed
 * (NO_WORDS_INTERRUPT_MS: a transcriber hiccup, another language). The opener is uncuttable (disclosure).
 * Spec: docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1.
 */
import { overlapVerdict } from './bridge-listening.js';
import type { ClearTimer, SetTimer } from './bridge-playback.js';

/** Caller talking this long over the agent with no word transcribed: treat it as an interruption. */
export const NO_WORDS_INTERRUPT_MS = 3000;
/** Caller started with at most this much (fully generated) agent audio left: an early answer. */
export const LATE_OVERLAP_MS = 1500;

/** How an undecided overlap ends: the agent was cut, the bridge should answer it, or it was just listening. */
export type OverlapEnd = 'interrupted' | 'answer' | 'ignore';

export type InterruptWhy = 'words' | 'no words';

interface Overlap {
  readonly itemId: string;
  readonly text: string;
  /** May the gate cut the agent? False over the opener (the disclosure line). */
  readonly cuttable: boolean;
  /** Began near the end of the agent's turn ("…got a quick minute?" / "yeah sure"). */
  readonly late: boolean;
}

export interface OverlapGateDeps {
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  /** Cut the agent now; `itemId` is the interrupted caller item. */
  onInterrupt(why: InterruptWhy, itemId: string): void;
}

export class OverlapGate {
  private current: Overlap | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OverlapGateDeps) {}

  /** The caller item being judged, or null. */
  get itemId(): string | null {
    return this.current?.itemId ?? null;
  }

  open(itemId: string, opts: { cuttable: boolean; late: boolean }): void {
    this.close();
    this.current = { itemId, text: '', cuttable: opts.cuttable, late: opts.late };
    if (opts.cuttable) this.timer = this.deps.setTimer(() => this.interrupt('no words'), NO_WORDS_INTERRUPT_MS);
  }

  /** Words streamed for a caller item (`conversation.item.input_audio_transcription.delta`). */
  onDelta(itemId: string, delta: string): void {
    const o = this.current;
    if (o === null || o.itemId !== itemId || delta.length === 0) return;
    const next: Overlap = { ...o, text: o.text + delta };
    this.current = next;
    const verdict = overlapVerdict(next.text);
    if (verdict !== 'empty') this.clearNoWordsTimer();
    if (verdict === 'interrupt' && next.cuttable) this.interrupt('words');
  }

  /** The item's final transcript (or '' when transcription failed): settle the overlap. */
  finish(itemId: string, finalText: string): OverlapEnd {
    const o = this.current;
    if (o === null || o.itemId !== itemId) return 'ignore';
    const verdict = overlapVerdict(finalText.trim().length > 0 ? finalText : o.text);
    // A wordless sound (a cough) is never an answer, late or not.
    if (verdict === 'empty') {
      this.close();
      return 'ignore';
    }
    if (verdict === 'interrupt' && o.cuttable) {
      this.interrupt('words');
      return 'interrupted';
    }
    this.close();
    if (verdict === 'interrupt') return 'answer';
    return o.late ? 'answer' : 'ignore';
  }

  close(): void {
    this.clearNoWordsTimer();
    this.current = null;
  }

  /** The caller stopped talking: a sound shorter than the no-words timer is settled by its transcript. */
  onSpeechStopped(itemId: string): void {
    if (this.current?.itemId === itemId) this.clearNoWordsTimer();
  }

  private interrupt(why: InterruptWhy): void {
    const itemId = this.current?.itemId ?? '';
    this.close();
    this.deps.onInterrupt(why, itemId);
  }

  private clearNoWordsTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}

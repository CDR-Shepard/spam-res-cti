/**
 * Caller "overlaps": the caller started talking while the agent was talking. The gate
 * keeps the agent talking through listening sounds ("mm-hmm", "yeah") and cuts it on a real
 * interruption: a stop word, two real words, or 3 s of talk with no word transcribed
 * (NO_WORDS_INTERRUPT_MS: a transcriber hiccup, another language). The opener is uncuttable (disclosure).
 * A listening sound near the end of the agent's turn, or still going when the agent finishes, is the answer.
 * New speech pushes an undecided overlap aside; it is still judged by its words, and a cut settles all.
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
  /** Began near the end of the agent's turn ("…got a quick minute?" / "yeah sure"), or outlasted it. */
  readonly late: boolean;
  /** The caller stopped talking (`speech_stopped`). */
  readonly stopped: boolean;
}

export interface OverlapGateDeps {
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  /** Cut the agent now; `itemId` is the interrupted caller item. */
  onInterrupt(why: InterruptWhy, itemId: string): void;
  /** An overlap was settled as a listening sound with words ("mm-hmm"); a wordless one (a cough) is not. */
  onListening(itemId: string): void;
}

export class OverlapGate {
  private current: Overlap | null = null;
  /** Earlier overlaps pushed aside by new speech before their words were judged. */
  private displaced: readonly Overlap[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: OverlapGateDeps) {}

  /** The caller item being judged, or null. */
  get itemId(): string | null {
    return this.current?.itemId ?? null;
  }

  /** No overlap is being judged: neither a current one nor one pushed aside. */
  get idle(): boolean {
    return this.current === null && this.displaced.length === 0;
  }

  /** Whether this caller item is being judged (the current overlap or one pushed aside). */
  has(itemId: string): boolean {
    return this.find(itemId) !== null;
  }

  /** Whether this overlap is late: it began near the end of the agent's turn, or outlasted it. False for any other item. */
  isLate(itemId: string): boolean {
    return this.find(itemId)?.late ?? false;
  }

  open(itemId: string, opts: { cuttable: boolean; late: boolean }): void {
    this.clearNoWordsTimer();
    if (this.current !== null) this.displaced = [...this.displaced, this.current];
    this.current = { itemId, text: '', cuttable: opts.cuttable, late: opts.late, stopped: false };
    if (opts.cuttable) this.timer = this.deps.setTimer(() => this.interrupt('no words', itemId), NO_WORDS_INTERRUPT_MS);
  }

  /** Words streamed for a caller item (`conversation.item.input_audio_transcription.delta`). */
  onDelta(itemId: string, delta: string): void {
    const o = this.find(itemId);
    if (o === null || delta.length === 0) return;
    const next: Overlap = { ...o, text: o.text + delta };
    const isCurrent = o === this.current;
    this.replace(o, next);
    const verdict = overlapVerdict(next.text);
    if (verdict !== 'empty' && isCurrent) this.clearNoWordsTimer();
    if (verdict === 'interrupt' && next.cuttable) this.interrupt('words', itemId);
  }

  /** The item's final transcript (or '' when transcription failed): settle the overlap. */
  finish(itemId: string, finalText: string): OverlapEnd {
    const o = this.find(itemId);
    if (o === null) return 'ignore';
    const verdict = overlapVerdict(finalText.trim().length > 0 ? finalText : o.text);
    if (verdict === 'interrupt' && o.cuttable) {
      this.interrupt('words', itemId);
      return 'interrupted';
    }
    this.drop(o);
    // A wordless sound (a cough) is never an answer, late or not — nor a listening sound.
    if (verdict === 'empty') return 'ignore';
    if (verdict === 'interrupt' || o.late) return 'answer';
    this.deps.onListening(itemId);
    return 'ignore';
  }

  close(): void {
    this.clearNoWordsTimer();
    this.current = null;
    this.displaced = [];
  }

  /** The caller stopped talking: a sound shorter than the no-words timer is settled by its transcript. */
  onSpeechStopped(itemId: string): void {
    const o = this.find(itemId);
    if (o === null) return;
    if (o === this.current) this.clearNoWordsTimer();
    this.replace(o, { ...o, stopped: true });
  }

  /** The agent's audio finished playing: a caller still talking over its end is answering it — a late overlap. */
  onAgentFinished(): void {
    if (this.current === null || this.current.stopped) return;
    this.current = { ...this.current, late: true };
  }

  /** A cut settles every overlap: the agent is no longer talking over anyone. */
  private interrupt(why: InterruptWhy, itemId: string): void {
    this.close();
    this.deps.onInterrupt(why, itemId);
  }

  private find(itemId: string): Overlap | null {
    if (this.current?.itemId === itemId) return this.current;
    return this.displaced.find((o) => o.itemId === itemId) ?? null;
  }

  private replace(o: Overlap, next: Overlap): void {
    if (o === this.current) this.current = next;
    else this.displaced = this.displaced.map((d) => (d === o ? next : d));
  }

  private drop(o: Overlap): void {
    if (o !== this.current) {
      this.displaced = this.displaced.filter((d) => d !== o);
      return;
    }
    this.clearNoWordsTimer();
    this.current = null;
  }

  private clearNoWordsTimer(): void {
    if (this.timer === null) return;
    this.deps.clearTimer(this.timer);
    this.timer = null;
  }
}

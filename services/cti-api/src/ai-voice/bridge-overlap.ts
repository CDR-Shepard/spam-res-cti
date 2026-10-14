/**
 * Caller "overlaps": the caller started talking while the agent was talking. The gate
 * keeps the agent talking through listening sounds ("mm-hmm", "yeah") and cuts it on a real
 * interruption. How it recognises one is its judge (AI_VOICE_OVERLAP_JUDGE):
 *
 * - `words` (2026-10-09): a stop word, two real words, or 3 s of talk with no word transcribed
 *   (NO_WORDS_INTERRUPT_MS: a transcriber hiccup, another language). A listening sound near the end
 *   of the agent's turn, or still going when the agent finishes, is the answer.
 * - `sound` (smart stop v2, 2026-10-13): the caller's current sound (bridge-sound.ts) reaching `stopMs`
 *   cuts the agent at once — "mm-hmm" is over in about half a second, a real reply keeps going; speech
 *   starting with at most LATE_OVERLAP_MS of agent audio left cuts it at once (they are answering it);
 *   a caller still talking when the agent finishes is no longer an overlap but their turn, handed back
 *   to the bridge. The word rules above still cut too, a little later (a short "wait").
 *
 * The opener is uncuttable (disclosure) by either judge.
 * New speech pushes an undecided overlap aside; it is still judged by its words, and a cut settles all.
 * Spec: docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.1, §4.5.
 */
import { overlapVerdict } from './bridge-listening.js';
import type { ClearTimer, SetTimer } from './bridge-playback.js';

/** Caller talking this long over the agent with no word transcribed: treat it as an interruption. */
export const NO_WORDS_INTERRUPT_MS = 3000;
/** Caller started with at most this much (fully generated) agent audio left: an early answer. */
export const LATE_OVERLAP_MS = 1500;

/** Sound judge: the caller's current sound this long over the agent cuts it, in ms (AI_VOICE_STOP_MS). */
export const DEFAULT_STOP_MS = 600;

/** How a real interruption is recognised: the caller's sound (and words), or words only (the 2026-10-09 gate). */
export type OverlapJudge = 'sound' | 'words';

/** How an undecided overlap ends: the agent was cut, the bridge should answer it, or it was just listening. */
export type OverlapEnd = 'interrupted' | 'answer' | 'ignore';

export type InterruptWhy = 'words' | 'no words' | 'sound' | 'late';

interface Overlap {
  readonly itemId: string;
  readonly text: string;
  /** May the gate cut the agent? False over the opener (the disclosure line). */
  readonly cuttable: boolean;
  /** Began near the end of the agent's turn ("…got a quick minute?" / "yeah sure"), or outlasted it. */
  readonly late: boolean;
  /** The caller stopped talking (`speech_stopped`). */
  readonly stopped: boolean;
  /** Sound judge: the longest the caller's sound ran while they talked, in ms (0 for the words judge). */
  readonly maxRunMs: number;
}

export interface OverlapGateDeps {
  setTimer: SetTimer;
  clearTimer: ClearTimer;
  judge: OverlapJudge;
  /** Sound judge: the caller's current sound reaching this many ms cuts the agent. */
  stopMs: number;
  /** Cut the agent now; `itemId` is the interrupted caller item. */
  onInterrupt(why: InterruptWhy, itemId: string): void;
  /** An overlap was settled as a listening sound with words ("mm-hmm"); a wordless one (a cough) is not. `maxRunMs`: its longest sound. */
  onListening(itemId: string, maxRunMs: number): void;
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

  /** The caller started talking over the agent; `runMs`: how long their sound has run already (sound judge). */
  open(itemId: string, opts: { cuttable: boolean; late: boolean; runMs?: number }): void {
    const bySound = this.deps.judge === 'sound' && opts.cuttable;
    // Sound judge: they are answering the agent's last words — stop it now; their turn is answered at its commit.
    if (bySound && opts.late) return this.interrupt('late', itemId);
    const runMs = this.deps.judge === 'sound' ? (opts.runMs ?? 0) : 0;
    this.clearNoWordsTimer();
    if (this.current !== null) this.displaced = [...this.displaced, this.current];
    this.current = { itemId, text: '', cuttable: opts.cuttable, late: opts.late, stopped: false, maxRunMs: runMs };
    if (opts.cuttable) this.timer = this.deps.setTimer(() => this.interrupt('no words', itemId), NO_WORDS_INTERRUPT_MS);
    if (bySound && runMs >= this.deps.stopMs) this.interrupt('sound', itemId);
  }

  /** Sound judge: the caller's current sound has run `runMs`. Long enough over a cuttable agent, it is a real interruption. */
  onSound(runMs: number): void {
    const o = this.current;
    if (this.deps.judge !== 'sound' || o === null || o.stopped) return;
    if (runMs > o.maxRunMs) this.current = { ...o, maxRunMs: runMs };
    if (o.cuttable && runMs >= this.deps.stopMs) this.interrupt('sound', o.itemId);
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
    this.deps.onListening(itemId, o.maxRunMs);
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

  /**
   * The agent's audio finished playing: a caller still talking over its end is answering it. Words judge: a late
   * overlap, still judged by its words (returns null). Sound judge: no longer an overlap but their turn — dropped
   * from the gate and its item returned, for the bridge to answer like any turn. A stopped overlap waits for its words.
   */
  onAgentFinished(): string | null {
    const o = this.current;
    if (o === null || o.stopped) return null;
    if (this.deps.judge === 'words') {
      this.current = { ...o, late: true };
      return null;
    }
    this.drop(o);
    return o.itemId;
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

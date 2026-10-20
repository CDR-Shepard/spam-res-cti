/**
 * Whether the caller is waiting on an answer, for the end_call guard (bridge.ts). An agent that ends the call without a
 * word right after the caller spoke is sent back: before 2026-10-20 always to say a goodbye and then end, which hung up
 * on a caller mid-question ("You don't have a rough timeline?", a test call, 2026-10-19). Now the agent answers that one
 * shape only: the caller's last words are a question, and nothing they said asks not to be called. Anything else — a
 * goodbye, a decline, words not in yet — keeps the goodbye-then-end (review, 2026-10-20: a wider "no goodbye heard"
 * rule kept sellers who said "We're not selling" on the line).
 */
import type { ClearTimer, SetTimer } from './bridge-playback.js';

/** Words that ask not to be called: never answered, whatever else was said. */
const OPT_OUT =
  /\b(take (me|us|this number) off|remove (me|us|this number)|stop calling|quit calling|don't call|dont call|do not call|never call|lose (my|this|our) number|leave (me|us) alone)\b/;

function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'?.! ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The line's last sentence, without trailing quotes ("Thanks, bye. Oh wait, how long does closing take?" → its question). */
function lastSentence(line: string): string {
  const sentences = normalize(line).split(/(?<=[.!?])\s+/);
  return (sentences[sentences.length - 1] ?? '').replace(/[\s'"]+$/, '');
}

/** A caller line since the agent last spoke: its words so far, and whether its transcript is complete. */
export interface CallerLine {
  text: string;
  final: boolean;
}

/** True when any of the caller's lines asks not to be called. */
export function optedOut(lines: readonly CallerLine[]): boolean {
  return lines.some((line) => OPT_OUT.test(normalize(line.text)));
}

/** A line of only "mm", "uh", "hmm" and the like: it does not hide a question asked before it. */
const FILLER = /^(?:(?:m+|mm+|m+hm+|mhm|uh+|um+|hm+|uh huh|ah+|oh|er+|huh)\s*)+$/;
const isFiller = (text: string): boolean => FILLER.test(normalize(text).replace(/[?.!]/g, '').trim());

/** True when the caller's last words (filler aside) are a question ("Okay, bye?" is not one) and none of their lines opts out. */
export function waitingOnAnswer(lines: readonly CallerLine[]): boolean {
  const known = lines.filter((line) => line.text.trim() !== '' && !isFiller(line.text));
  const last = known[known.length - 1];
  if (last === undefined || optedOut(lines)) return false;
  const sentence = lastSentence(last.text);
  return sentence.endsWith('?') && !/\bbye\b/.test(sentence);
}

/** How many caller lines' words are kept (a line's words can arrive just before or after its commit). */
const KEPT_LINES = 8;

/** The caller's lines since the agent last spoke: streamed words while they talk, the final transcript once it comes. */
export class CallerLines {
  private words = new Map<string, CallerLine>();
  private since: readonly string[] = [];
  private waiters: ReadonlySet<() => void> = new Set();

  constructor(private readonly timers: { setTimer: SetTimer; clearTimer: ClearTimer }) {}

  delta(itemId: string, text: string): void {
    const line = this.words.get(itemId);
    if (line?.final) return;
    this.keep(itemId, { text: (line?.text ?? '') + text, final: false });
  }

  /** The line's final transcript ('' when transcription failed): complete from now on. */
  final(itemId: string, text: string): void {
    this.keep(itemId, { text, final: true });
    if (this.allFinal()) this.wake();
  }

  /** A caller turn (any commit, overlaps included). */
  committed(itemId: string): void {
    if (!this.since.includes(itemId)) this.since = [...this.since, itemId];
  }

  /** The agent's audio started: lines before it are answered. */
  agentSpoke(): void {
    this.since = [];
    this.wake();
  }

  /** The call is over: nothing more is coming. */
  close(): void {
    this.wake();
  }

  sinceAgent(): CallerLine[] {
    return this.since.map((id) => this.words.get(id) ?? { text: '', final: false });
  }

  /** Resolves once every line since the agent spoke has its final transcript, or after `maxMs`, or on close(). */
  settled(maxMs: number): Promise<void> {
    if (maxMs <= 0 || this.allFinal()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        this.timers.clearTimer(timer);
        this.waiters = new Set([...this.waiters].filter((w) => w !== done));
        resolve();
      };
      const timer = this.timers.setTimer(done, maxMs);
      this.waiters = new Set([...this.waiters, done]);
    });
  }

  private allFinal(): boolean {
    return this.since.every((id) => this.words.get(id)?.final === true);
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private keep(itemId: string, line: CallerLine): void {
    const next = new Map(this.words);
    next.delete(itemId);
    next.set(itemId, line);
    while (next.size > KEPT_LINES) next.delete(next.keys().next().value as string);
    this.words = next;
  }
}

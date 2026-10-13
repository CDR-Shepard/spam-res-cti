/**
 * Where each answered caller turn's response time goes: one `ai-voice: turn timing` line per turn (a
 * diagnostic, logged by the bridge). Every figure is ms since that turn's `speech_stopped` arrived;
 * a figure the turn never had is null. Only numbers, booleans and short enums — never text or audio.
 *
 * It follows the same turns as TurnStatsCollector (bridge-turn-stats.ts), by the same rules: a caller stop
 * is the turn the next forwarded agent audio answers; an overlap the gate is judging is a turn only once
 * it is answered; a later stop replaces an unanswered one. So `forwardedMs` is that collector's answer point.
 *
 * - committedMs: `input_audio_buffer.committed` for the item.
 * - requestedMs: the first `response.create` the bridge sent after the stop (null: before it, or OpenAI's VAD answered).
 * - deferred: why the first attempt to answer was held — the bridge's own reasons, first one wins.
 * - createdMs: the first `response.created` after the stop; `responses` counts those up to the answer.
 * - firstDeltaMs: the answering response's first `response.output_audio.delta`.
 * - forwardedMs: its first audio reaching Twilio. playedMs: Twilio echoing the mark that follows it.
 * - toolBatches: tool batches started in that window (2+ responses with a batch: a function call came first).
 */
import type { TurnDetection } from './bridge-session.js';
import type { BargeInMode } from './bridge-turn-stats.js';

export type Deferral = 'caller_talking' | 'response_active' | 'tools' | 'overlap_verdict' | 'after_playback';

export interface TurnTimingLine {
  committedMs: number | null;
  requestedMs: number | null;
  deferred: Deferral | null;
  createdMs: number | null;
  firstDeltaMs: number;
  forwardedMs: number;
  /** Null when the call, or the caller's next speech, came before Twilio confirmed the audio. */
  playedMs: number | null;
  responses: number;
  toolBatches: number;
  /** The turn was an overlap the gate had to judge; `late`: it began near the end of the agent's own turn. */
  overlap: boolean;
  late: boolean;
  bargeIn: BargeInMode;
  turnDetection: TurnDetection;
}

/** Why a `response.create` cannot go out right now: the first of these that holds, or null. */
export function heldBy(callerTalking: boolean, responseBusy: boolean, toolsRunning: boolean): Deferral | null {
  if (callerTalking) return 'caller_talking';
  if (responseBusy) return 'response_active';
  return toolsRunning ? 'tools' : null;
}

interface Turn {
  readonly itemId: string;
  readonly stoppedAt: number;
  readonly overlap: boolean;
  readonly late: boolean;
  readonly committedAt: number | null;
  readonly deferred: Deferral | null;
  readonly requestedAt: number | null;
  readonly createdAt: number | null;
  readonly responses: number;
  readonly toolBatches: number;
}

/** A turn whose first audio was forwarded; it logs once Twilio plays it, or the next speech or the end comes first. */
interface Answered {
  readonly turn: Turn;
  readonly firstDeltaAt: number;
  readonly forwardedAt: number;
  /** The mark sent right after that first chunk. */
  readonly mark: string;
}

const since = (from: number, at: number | null): number | null => (at === null ? null : at - from);

export class TurnTiming {
  private pending: Turn | null = null;
  /** Overlaps the gate is still judging, by caller item. */
  private judged: ReadonlyMap<string, Turn> = new Map();
  private answered: Answered | null = null;
  /** When the current response's first audio delta arrived. */
  private deltaAt: number | null = null;

  constructor(
    private readonly bargeIn: BargeInMode,
    private readonly turnDetection: TurnDetection,
    private readonly emit: (line: TurnTimingLine) => void,
  ) {}

  /** The caller started talking: the last answered turn will not be confirmed any more — log it. */
  speechStarted(): void {
    this.flush(null);
  }

  /** The caller stopped at `at`. An overlap waits for its verdict; any other stop replaces an unanswered turn. */
  stopped(itemId: string, at: number, overlap: boolean, late: boolean): void {
    const turn: Turn = {
      itemId,
      stoppedAt: at,
      overlap,
      late,
      committedAt: null,
      deferred: null,
      requestedAt: null,
      createdAt: null,
      responses: 0,
      toolBatches: 0,
    };
    if (overlap) this.judged = new Map([...this.judged, [itemId, turn]]);
    else this.pending = turn;
  }

  committed(itemId: string, at: number): void {
    const stamp = (t: Turn): Turn => (t.itemId === itemId && t.committedAt === null ? { ...t, committedAt: at } : t);
    this.pending = this.pending === null ? null : stamp(this.pending);
    this.judged = new Map([...this.judged].map(([id, t]) => [id, stamp(t)]));
  }

  /** The first attempt to answer was held (for a judged overlap: `itemId`). Later holds, or any after the create, are not it. */
  deferred(why: Deferral, itemId?: string): void {
    const hold = (t: Turn): Turn => (t.deferred === null && t.requestedAt === null ? { ...t, deferred: why } : t);
    if (itemId === undefined) this.pending = this.pending === null ? null : hold(this.pending);
    else this.judged = this.update(this.judged, itemId, hold);
  }

  /** These judged overlaps get one answer: the latest is the turn, unless a later stop is already pending. */
  overlapsAnswered(itemIds: readonly string[], agentStillPlaying = false): void {
    const turns = itemIds.flatMap((id) => this.judged.get(id) ?? []);
    this.judged = new Map([...this.judged].filter(([id]) => !itemIds.includes(id)));
    const latest = turns.reduce<Turn | null>((a, b) => (a === null || b.stoppedAt > a.stoppedAt ? b : a), null);
    if (latest === null || (this.pending !== null && this.pending.stoppedAt >= latest.stoppedAt)) return;
    // Behind the agent's own audio: that is the hold, unless something held the answer earlier.
    this.pending = agentStillPlaying && latest.deferred === null ? { ...latest, deferred: 'after_playback' } : latest;
  }

  /** A judged overlap was only a listening sound. */
  ignored(itemId: string): void {
    this.judged = new Map([...this.judged].filter(([id]) => id !== itemId));
  }

  /** The last caller stop will not be answered. */
  dropPending(): void {
    this.pending = null;
  }

  /** The bridge sent a `response.create` at `at`. */
  requested(at: number): void {
    this.pending = this.pending === null || this.pending.requestedAt !== null ? this.pending : { ...this.pending, requestedAt: at };
  }

  /** `response.created`: another response in the window; its audio has not started. */
  created(at: number): void {
    this.deltaAt = null;
    if (this.pending === null) return;
    this.pending = { ...this.pending, responses: this.pending.responses + 1, createdAt: this.pending.createdAt ?? at };
  }

  /** A tool batch started. */
  toolBatch(): void {
    if (this.pending !== null) this.pending = { ...this.pending, toolBatches: this.pending.toolBatches + 1 };
  }

  /** An audio delta arrived from OpenAI (whether or not it is forwarded). */
  delta(at: number): void {
    this.deltaAt ??= at;
  }

  /** The first audio of a response was forwarded to Twilio at `at`, followed by `mark`: it answers the pending turn. */
  forwarded(at: number, mark: string): void {
    if (this.pending === null) return;
    this.flush(null); // an earlier answer never confirmed: it logs before this one
    this.answered = { turn: this.pending, firstDeltaAt: this.deltaAt ?? at, forwardedAt: at, mark };
    this.pending = null;
  }

  /** Twilio echoed `mark`: if it is the answer's first, the audio has played. */
  played(mark: string, at: number): void {
    if (this.answered?.mark === mark) this.flush(at);
  }

  /** The call is ending (or the agent was silenced): log an answered turn Twilio never confirmed. */
  end(): void {
    this.flush(null);
  }

  private flush(playedAt: number | null): void {
    if (this.answered === null) return;
    const { turn: t, firstDeltaAt, forwardedAt } = this.answered;
    this.answered = null;
    this.emit({
      committedMs: since(t.stoppedAt, t.committedAt),
      requestedMs: since(t.stoppedAt, t.requestedAt),
      deferred: t.deferred,
      createdMs: since(t.stoppedAt, t.createdAt),
      firstDeltaMs: firstDeltaAt - t.stoppedAt,
      forwardedMs: forwardedAt - t.stoppedAt,
      playedMs: since(t.stoppedAt, playedAt),
      responses: t.responses,
      toolBatches: t.toolBatches,
      overlap: t.overlap,
      late: t.late,
      bargeIn: this.bargeIn,
      turnDetection: this.turnDetection,
    });
  }

  private update(turns: ReadonlyMap<string, Turn>, itemId: string, fn: (t: Turn) => Turn): ReadonlyMap<string, Turn> {
    const t = turns.get(itemId);
    return t === undefined ? turns : new Map([...turns, [itemId, fn(t)]]);
  }
}

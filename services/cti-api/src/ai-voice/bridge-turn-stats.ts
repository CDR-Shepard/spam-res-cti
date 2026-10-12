/**
 * Per-call turn-taking numbers (spec 2026-10-09 §4.3). A sample is one caller turn the agent
 * answered: endpointMs (caller stopped → turn declared over, from the audio clock) + answerMs
 * (turn declared over → first agent audio forwarded, wall clock). Twilio playout is not included.
 * A caller "overlap" the gate is judging (bridge-overlap.ts) becomes a turn only once it is answered;
 * an answer that had to wait for the agent's own audio is timed from when that audio finished.
 */
import type { AiCallTurnStats } from '@cti/contracts';

export type BargeInMode = 'gate' | 'instant';

interface Sample {
  readonly endpointMs: number;
  readonly answerMs: number;
}

interface Stop {
  readonly endpointMs: number;
  readonly stoppedAt: number;
}

interface Turn extends Stop {
  /** The answer clock starts here: the stop, or later once the agent's own audio finished. */
  readonly clockFrom: number;
  /** A late answer waiting for the agent's audio to finish: the clock moves to that moment. */
  readonly waitsForAgent: boolean;
}

/** Nearest-rank percentile of an ascending, non-empty list. */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

export class TurnStatsCollector {
  private pending: Turn | null = null;
  /** Stops of overlaps the gate is still judging, by caller item. */
  private judged: ReadonlyMap<string, Stop> = new Map();
  private agentDoneAt = Number.NEGATIVE_INFINITY;
  private samples: readonly Sample[] = [];
  private interruptions = 0;
  private listening = 0;
  private silenceChecks = 0;

  constructor(private readonly bargeIn: BargeInMode) {}

  /** The caller's turn was declared over at `atMs`, `endpointMs` after they actually stopped. */
  callerStopped(endpointMs: number, atMs: number): void {
    this.pending = { endpointMs: Math.max(0, Math.round(endpointMs)), stoppedAt: atMs, clockFrom: atMs, waitsForAgent: false };
  }

  /** A caller overlap the gate is still judging stopped: not a turn until it is answered. */
  overlapStopped(itemId: string, endpointMs: number, atMs: number): void {
    this.judged = new Map([...this.judged, [itemId, { endpointMs: Math.max(0, Math.round(endpointMs)), stoppedAt: atMs }]]);
  }

  /**
   * These judged overlaps get one answer: the most recent becomes the turn, unless a later caller stop is
   * already pending. Its clock starts once both had stopped; `agentStillPlaying`: when the agent's audio finishes.
   */
  overlapsAnswered(itemIds: readonly string[], agentStillPlaying = false): void {
    const stops = itemIds.flatMap((id) => this.judged.get(id) ?? []);
    this.judged = new Map([...this.judged].filter(([id]) => !itemIds.includes(id)));
    const latest = stops.reduce<Stop | null>((a, b) => (a === null || b.stoppedAt > a.stoppedAt ? b : a), null);
    if (latest === null || (this.pending !== null && this.pending.stoppedAt >= latest.stoppedAt)) return;
    const clockFrom = Math.max(latest.stoppedAt, this.agentDoneAt);
    this.pending = { ...latest, clockFrom, waitsForAgent: agentStillPlaying };
  }

  /** A judged overlap was only a listening sound: it is not a turn. */
  overlapIgnored(itemId: string): void {
    this.judged = new Map([...this.judged].filter(([id]) => id !== itemId));
  }

  /** Every overlap was dropped (the call is closing). */
  clearOverlaps(): void {
    this.judged = new Map();
  }

  /** The agent's audio finished playing at `atMs` (not cut): an answer waiting for it starts its clock now. */
  agentFinished(atMs: number): void {
    this.agentDoneAt = atMs;
    if (this.pending === null || !this.pending.waitsForAgent) return;
    this.pending = { ...this.pending, clockFrom: Math.max(this.pending.clockFrom, atMs), waitsForAgent: false };
  }

  /** The first audio of an agent response was forwarded at `atMs`. */
  agentAudio(atMs: number): void {
    if (this.pending === null) return;
    const { endpointMs, clockFrom } = this.pending;
    this.samples = [...this.samples, { endpointMs, answerMs: Math.max(0, atMs - clockFrom) }];
    this.pending = null;
  }

  /** The last caller stop will not be answered (a listening sound). */
  dropPending(): void {
    this.pending = null;
  }

  interruption(): void {
    this.interruptions += 1;
  }

  listeningSound(): void {
    this.listening += 1;
  }

  silenceCheck(): void {
    this.silenceChecks += 1;
  }

  summary(): AiCallTurnStats {
    const totals = ascending(this.samples.map((s) => s.endpointMs + s.answerMs));
    const endpoints = ascending(this.samples.map((s) => s.endpointMs));
    const answers = ascending(this.samples.map((s) => s.answerMs));
    const any = this.samples.length > 0;
    return {
      v: 1,
      bargeIn: this.bargeIn,
      turns: this.samples.length,
      totalMs: any ? { p50: percentile(totals, 50), p90: percentile(totals, 90), max: totals[totals.length - 1] as number } : null,
      endpointMs: any ? { p50: percentile(endpoints, 50) } : null,
      answerMs: any ? { p50: percentile(answers, 50) } : null,
      interruptions: this.interruptions,
      listening: this.listening,
      silenceChecks: this.silenceChecks,
    };
  }
}

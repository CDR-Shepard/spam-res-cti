/**
 * Per-call turn-taking numbers (spec 2026-10-09 §4.3). A sample is one caller turn the agent
 * answered: endpointMs (caller stopped → turn declared over, from the audio clock) + answerMs
 * (turn declared over → first agent audio forwarded, wall clock). Twilio playout is not included.
 */
import type { AiCallTurnStats } from '@cti/contracts';

export type BargeInMode = 'gate' | 'instant';

interface Sample {
  readonly endpointMs: number;
  readonly answerMs: number;
}

/** Nearest-rank percentile of an ascending, non-empty list. */
export function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

const ascending = (xs: readonly number[]): number[] => [...xs].sort((a, b) => a - b);

export class TurnStatsCollector {
  private pending: { endpointMs: number; stoppedAt: number } | null = null;
  private samples: readonly Sample[] = [];
  private interruptions = 0;
  private listening = 0;
  private silenceChecks = 0;

  constructor(private readonly bargeIn: BargeInMode) {}

  /** The caller's turn was declared over at `atMs`, `endpointMs` after they actually stopped. */
  callerStopped(endpointMs: number, atMs: number): void {
    this.pending = { endpointMs: Math.max(0, Math.round(endpointMs)), stoppedAt: atMs };
  }

  /** The first audio of an agent response was forwarded at `atMs`. */
  agentAudio(atMs: number): void {
    if (this.pending === null) return;
    const { endpointMs, stoppedAt } = this.pending;
    this.samples = [...this.samples, { endpointMs, answerMs: Math.max(0, atMs - stoppedAt) }];
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

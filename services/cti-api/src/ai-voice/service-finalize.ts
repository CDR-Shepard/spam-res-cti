/**
 * The end of an AI call, driven by Twilio's terminal status callback.
 *
 * `finalizeAiCall` is idempotent: the row is closed by a compare-and-swap on
 * `ended_at is null`, so a re-delivered callback does nothing. Before the CAS
 * it tears down the live side (bridge, transcript flush, registry entry) so
 * the row it returns carries the whole transcript. The outcome a tool or
 * webhook set wins; otherwise it is derived from how the call ended.
 *
 * Task 7 extends this function (calls row, summary, Salesforce Task) using
 * the row returned in `{ finalized: true, row }`.
 */
import type { BridgeLog } from './bridge.js';
import { closeActiveCall } from './registry.js';
import type { AiCallOutcome, AiCallRow, AiCallStatus, AiCallStore } from './store.js';

export const TERMINAL_CALL_STATUSES = ['completed', 'busy', 'no-answer', 'failed', 'canceled'] as const;

export function isTerminalCallStatus(callStatus: string): boolean {
  return (TERMINAL_CALL_STATUSES as readonly string[]).includes(callStatus);
}

/** A non-terminal Twilio CallStatus → the row status it implies (null: nothing to record). */
export function mapCallStatus(callStatus: string): Extract<AiCallStatus, 'ringing' | 'in_progress'> | null {
  if (callStatus === 'ringing') return 'ringing';
  if (callStatus === 'in-progress') return 'in_progress';
  return null;
}

/** The outcome of a call no tool or webhook classified. */
export function derivedOutcome(callStatus: string, answeredBy: string | null | undefined): AiCallOutcome {
  if (callStatus === 'no-answer') return 'no_answer';
  if (callStatus === 'busy') return 'busy';
  if (callStatus === 'failed' || callStatus === 'canceled') return 'failed';
  if (answeredBy?.startsWith('machine')) return 'voicemail';
  if (answeredBy === 'fax') return 'wrong_number';
  return 'hung_up';
}

export interface FinalizeInput {
  /** Twilio's terminal CallStatus. */
  callStatus: string;
  durationSeconds: number | null;
  endedAt: Date;
  answeredBy?: string | null;
}

export interface FinalizeDeps {
  store: AiCallStore;
  log: BridgeLog;
}

export type FinalizeResult = { finalized: true; row: AiCallRow } | { finalized: false };

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function finalizeAiCall(deps: FinalizeDeps, aiCallId: string, input: FinalizeInput): Promise<FinalizeResult> {
  const { store, log } = deps;
  await closeActiveCall(aiCallId);

  const current = await store.get(aiCallId);
  if (!current || current.endedAt) return { finalized: false };
  const answeredBy = current.answeredBy ?? input.answeredBy ?? null;
  const row = await store.finalize(aiCallId, {
    derivedOutcome: derivedOutcome(input.callStatus, answeredBy),
    durationSeconds: input.durationSeconds,
    endedAt: input.endedAt,
    answeredBy: input.answeredBy ?? null,
  });
  if (!row) return { finalized: false };

  if (row.outcome === 'do_not_call') {
    // The tool already wrote it; re-assert in case that write failed mid-call.
    try {
      await store.upsertOptOut(row.orgId, row.toE164, 'ai call: do not call');
    } catch (e) {
      log.error({ aiCallId, err: errText(e) }, 'ai-voice: opt-out re-assert failed — add it by hand');
    }
  }
  log.info({ aiCallId, status: row.status, outcome: row.outcome }, 'ai-voice: call finalized');
  return { finalized: true, row };
}

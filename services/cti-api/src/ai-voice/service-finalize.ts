/**
 * The end of an AI call, driven by Twilio's terminal status callback (or the
 * stale-call sweeper, sweeper.ts).
 *
 * `finalizeAiCall` is idempotent: the row is closed by a compare-and-swap on
 * `ended_at is null`, so a re-delivered callback does nothing. Before the CAS
 * it tears down the live side (bridge, transcript flush, registry entry) so
 * the row it returns carries the whole transcript. The outcome a tool or
 * webhook set wins; otherwise it is derived from how the call ended. Status
 * `transferred` is set only by the transfer-result (the rep answered); the
 * CAS keeps it and never infers it.
 *
 * After the CAS, in order:
 *   1. a `do_not_call` or `wrong_number` outcome re-asserts the opt-out;
 *   2. a placed call (it has a CallSid) gets its `calls` row, linked through
 *      `ai_calls.cti_call_id` in the same transaction — so the dialer's daily
 *      cap and per-customer ceiling count AI calls, exactly once;
 *   3. `afterCall` (summary + Salesforce Tasks, `afterAiCall`) runs DETACHED:
 *      the webhook replies without waiting on Claude or Salesforce. The
 *      promise is returned as `after` (tests, the sweeper) and never rejects.
 * Nothing after the CAS throws out of finalize.
 */
import type { schema } from '@cti/db';
import type { AppConfig } from '../config.js';
import type { BridgeLog } from './bridge.js';
import { ctiDisposition } from './outcomes.js';
import { closeActiveCall } from './registry.js';
import { liveAiCallSf, logAiCallTask, logCallbackTask, type SfLogDeps } from './sf-logging.js';
import type { AiCallOutcome, AiCallRow, AiCallStatus, AiCallStore, NewCtiCall } from './store.js';
import { carriedLines, reformatSummary, summarizeAiCall, summaryClientFor, type SummaryDeps } from './summary.js';
import { taskLinks } from '../salesforce/dialer-connect-task.js';

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
  /** The callback's CallSid: stored if the row never got one (its write failed after placing the call). */
  callSid?: string | null;
}

/** Summary + Salesforce for a finalized call. Must not throw (finalize logs it if it does). */
export type AfterCall = (row: AiCallRow) => Promise<void>;

export interface FinalizeDeps {
  store: AiCallStore;
  log: BridgeLog;
  afterCall?: AfterCall;
}

export type FinalizeResult = { finalized: true; row: AiCallRow; after: Promise<void> } | { finalized: false };

type CtiCallStatus = (typeof schema.calls.$inferInsert)['status'];

/** Twilio's terminal CallStatus → the `calls.status` enum. */
export function ctiCallStatus(callStatus: string): CtiCallStatus {
  switch (callStatus) {
    case 'busy':
      return 'busy';
    case 'no-answer':
      return 'no_answer';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'completed';
  }
}

/**
 * The `calls` row of a placed AI call. Always dispositioned (an outbound
 * terminal row without one blocks the rep's next dial and is swept into a
 * second Salesforce Task — outcomes.ts). `talkSeconds: 0`: the talk-time
 * report reads coalesce(talk_seconds, duration_seconds), and the AI's
 * conversation is not the rep's talk time.
 */
export function ctiCallValues(row: AiCallRow, callStatus: string): NewCtiCall {
  // A test or practice call (plan 1D: is_test, with the record's ids) rang a test number: its calls row must never count
  // as a dial to the record's person (contact history, rollover), so it links to no record.
  const links = !row.isTest && row.sfObject && row.sfRecordId ? taskLinks(row.sfObject, row.sfRecordId) : null;
  return {
    orgId: row.orgId,
    userId: row.startedBy,
    provider: 'twilio',
    providerCallId: row.callSid,
    fromNumber: row.fromE164 ?? '',
    toNumber: row.toE164,
    normalizedToNumber: row.toE164,
    direction: 'outbound',
    status: ctiCallStatus(callStatus),
    startedAt: row.startedAt ?? row.createdAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    talkSeconds: 0,
    disposition: ctiDisposition(row.outcome),
    salesforceWhoId: links?.whoId ?? null,
    salesforceWhatId: links?.whatId ?? null,
    campaignKey: null,
    metadata: { ai: true, aiCallId: row.id, outcome: row.outcome },
    // The dialer's 24 h cap window reads calls.created_at: a late (sweeper) finalize must not move the call.
    createdAt: row.createdAt,
  };
}

export interface AfterCallDeps {
  store: AiCallStore;
  log: BridgeLog;
  summary: SummaryDeps;
  /** Null: no Salesforce (tests, or not configured). */
  sf: SfLogDeps | null;
}

/** The summary (stored on the row), then the call's Task and, for a promised call back, the callback Task. */
export async function afterAiCall(row: AiCallRow, deps: AfterCallDeps): Promise<void> {
  const drafted = await summarizeAiCall(
    { aiCallId: row.id, outcome: row.outcome, transcript: row.transcript, qualification: row.qualification, toolSummary: row.summary },
    deps.summary,
  );
  const { summary, outcome } = await withLateTransferFailure(row, drafted, deps);
  await deps.store
    .update(row.id, { summary })
    .catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: summary write failed'));
  if (!deps.sf) return;
  await logAiCallTask({ ...row, outcome }, summary, deps.sf);
  // The snapshot's outcome: a transfer that failed after finalize gets its callback Task from that late path.
  await logCallbackTask(row, summary, deps.sf);
}

/**
 * The one outcome change after finalize — qualified_transferred →
 * transfer_failed, from a transfer-result that lost the race to the status
 * callback — may land while the summary is being drafted. Re-read the row so
 * this (snapshot-based) write cannot put back the old outcome words or drop
 * the did-not-connect line.
 */
async function withLateTransferFailure(
  row: AiCallRow,
  drafted: string,
  deps: AfterCallDeps,
): Promise<{ summary: string; outcome: AiCallRow['outcome'] }> {
  if (row.outcome !== 'qualified_transferred') return { summary: drafted, outcome: row.outcome };
  const fresh = await deps.store.get(row.id).catch((e: unknown) => {
    deps.log.warn({ aiCallId: row.id, err: errText(e) }, 'ai-voice: summary re-read failed');
    return null;
  });
  if (fresh?.outcome !== 'transfer_failed') return { summary: drafted, outcome: row.outcome };
  const summary = reformatSummary(drafted, {
    qualification: fresh.qualification,
    outcome: fresh.outcome,
    aiCallId: row.id,
    extra: carriedLines(fresh.summary),
  });
  return { summary, outcome: fresh.outcome };
}

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
    callSid: input.callSid ?? null,
  });
  if (!row) return { finalized: false };

  if (row.outcome === 'do_not_call' || row.outcome === 'wrong_number') {
    // The tool already wrote it; re-assert in case that write failed mid-call.
    try {
      await store.upsertOptOut(row.orgId, row.toE164, row.outcome === 'do_not_call' ? 'ai call: do not call' : 'ai call: wrong number');
    } catch (e) {
      log.error({ aiCallId, err: errText(e) }, 'ai-voice: opt-out re-assert failed — add it by hand');
    }
  }
  const final = await withCtiCall(row, input.callStatus, deps);
  log.info({ aiCallId, status: final.status, outcome: final.outcome, ctiCallId: final.ctiCallId }, 'ai-voice: call finalized');
  return { finalized: true, row: final, after: runAfterCall(final, deps) };
}

/** Production wiring: Claude for the summary (when keyed), the rep-token Salesforce client. */
export function liveAfterCall(
  cfg: Pick<AppConfig, 'ANTHROPIC_API_KEY' | 'AI_SUMMARY_MODEL'>,
  store: AiCallStore,
  log: BridgeLog,
  now: () => Date = () => new Date(),
): { afterCall: AfterCall; sf: SfLogDeps } {
  const sf: SfLogDeps = { sf: liveAiCallSf(), store, log, now };
  const summary: SummaryDeps = { client: summaryClientFor(cfg), model: cfg.AI_SUMMARY_MODEL, log };
  return { sf, afterCall: (row) => afterAiCall(row, { store, log, summary, sf }) };
}

async function withCtiCall(row: AiCallRow, callStatus: string, deps: FinalizeDeps): Promise<AiCallRow> {
  if (!row.callSid) return row; // never placed: nothing rang, nothing to count
  try {
    const ctiCallId = await deps.store.recordCtiCall(row.id, ctiCallValues(row, callStatus));
    return { ...row, ctiCallId };
  } catch (e) {
    deps.log.error(
      { aiCallId: row.id, err: errText(e) },
      'ai-voice: calls row write failed — the daily cap still counts this call via ai_calls, the per-customer ceiling does not',
    );
    return row;
  }
}

function runAfterCall(row: AiCallRow, deps: FinalizeDeps): Promise<void> {
  if (!deps.afterCall) return Promise.resolve();
  return deps.afterCall(row).catch((e: unknown) => deps.log.error({ aiCallId: row.id, err: errText(e) }, 'ai-voice: after-call work failed'));
}

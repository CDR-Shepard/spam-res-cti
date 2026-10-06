/**
 * `ai_call.writeback` (plan 1D, spec §3.4): writes each counted AI call's result to Salesforce once, step by step, through
 * the tenant's integration connection. Rows are claimed one at a time (10 a tick, 50 s deadline, 5 min lease). Each step's
 * result is saved before the next, so a retry resumes and never redoes a step; transient failures back off (1 m … 24 h) and
 * a row fails after 6 attempts. Nothing is ever thrown out of the tick. Logs carry ids, step names and error codes only.
 */
import { SalesforceApiError } from '@cti/salesforce';
import { loadWritebackContext } from './context.js';
import { GONE_CODES, RecordGoneError, stepCode, type RowRun, type WritebackDeps } from './row-run.js';
import { convertStepRun, planStep } from './steps-plan.js';
import { appointmentStep, chatterStep, fieldsStep, taskStep } from './steps-write.js';
import { claimWritebacks, deferWriteback, finishWriteback, retryWriteback, type WritebackRow } from './store.js';
import type { WritePlan } from './plan.js';
import type { NotWritten } from './words.js';

export type { WritebackDeps } from './row-run.js';

export const WRITEBACK_BATCH = 10;
export const WRITEBACK_DEADLINE_MS = 50_000;

export interface WritebackCounts {
  done: number;
  partial: number;
  skipped: number;
  failed: number;
  retried: number;
}
type Ended = keyof WritebackCounts;

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Salesforce's code for an error: a SOAP fault's, a REST error body's first `errorCode`, or a RecordGoneError's. */
function errorCode(err: unknown): string | null {
  if (err instanceof RecordGoneError) return err.code;
  if (!(err instanceof SalesforceApiError)) return null;
  if (err.code) return err.code;
  const first = Array.isArray(err.body) ? (err.body[0] as { errorCode?: unknown } | undefined) : undefined;
  return typeof first?.errorCode === 'string' ? first.errorCode : null;
}

/** A hang-up or other call that learned nothing: no status move, nothing to fill, nothing booked (spec §3.4: skipped). */
const nothingToWrite = (plan: WritePlan): boolean =>
  plan.result === 'other' && Object.keys(plan.patch).length === 0 && plan.kept.length === 0 && plan.appointment === null && !plan.contactDnc;

const nextUtcMidnight = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));

/** A stored plan that no longer parses: the row fails at once with this last_error (no retries, no Salesforce write). */
export const STORED_PLAN_INVALID = 'STORED_PLAN_INVALID';

async function end(run: { deps: WritebackDeps; row: WritebackRow }, status: 'done' | 'partial' | 'skipped' | 'failed', error: string | null): Promise<Ended> {
  await finishWriteback(run.deps.db, run.row.id, status, run.deps.now, error);
  return status;
}

/** done when every step is done or skipped and nothing went unwritten; else partial, last_error the first refusal code. */
async function finish(run: RowRun): Promise<Ended> {
  const s = run.row.steps;
  const notWritten = (Array.isArray(s.fields?.data?.notWritten) ? s.fields.data.notWritten : []) as NotWritten[];
  const codes = [stepCode(s.convert), stepCode(s.appointment), notWritten[0]?.code ?? null, stepCode(s.task), stepCode(s.chatter)];
  const first = codes.find((c): c is string => c !== null) ?? null;
  return end(run, first === null ? 'done' : 'partial', first);
}

async function processRow(deps: WritebackDeps, row: WritebackRow, at: (step: string) => void): Promise<Ended> {
  at('context');
  const ctx = await loadWritebackContext(deps.db, row);
  if (ctx === null) return end({ deps, row }, 'skipped', 'ai call gone');
  // Second guard (Task 25 never enqueues one): a test or practice call never converts, books or writes. No Salesforce at all.
  if (ctx.call.isTest || ctx.call.practice) return end({ deps, row }, 'skipped', 'test call');
  // Turned off after this row was queued (or while it waited to retry): it stops here (sweep D-23 M5).
  if (!ctx.settings.aiCallWriteback) return end({ deps, row }, 'skipped', 'write-back is off');
  let run: RowRun = { deps, client: await deps.clients(row.orgId), ctx, row };

  at('convert');
  const converted = await convertStepRun(run);
  run = converted.run;
  if (converted.result === 'gone') return end(run, 'skipped', 'record gone');
  if (converted.result === 'no_opportunity') return end(run, 'partial', 'CONVERTED_WITHOUT_OPPORTUNITY');

  at('plan');
  const planned = await planStep(run);
  if (planned.kind === 'gone') return end(run, 'skipped', 'record gone or converted');
  if (planned.kind === 'invalid') {
    deps.log.error({ writebackId: row.id, aiCallId: row.aiCallId, step: 'plan' }, 'ai_call.writeback: the stored write plan no longer parses; failing the row');
    return end(run, 'failed', STORED_PLAN_INVALID);
  }
  if (planned.kind === 'budget') {
    await deferWriteback(deps.db, row.id, nextUtcMidnight(deps.now), deps.now, 'daily AI budget spent');
    return 'retried';
  }
  run = planned.run;
  const { plan } = planned;
  if (nothingToWrite(plan)) return end(run, 'skipped', 'nothing to write');

  at('appointment');
  const booked = await appointmentStep(run, plan);
  run = booked.run;
  at('task');
  run = await taskStep(run, plan, booked.result);
  at('fields');
  run = await fieldsStep(run, plan, booked.result);
  at('chatter');
  run = await chatterStep(run, plan, booked.result);
  return finish(run);
}

/** One row, never thrown: a gone record is skipped; anything else is retried with backoff (failed after 6 attempts). */
async function runRow(deps: WritebackDeps, row: WritebackRow): Promise<Ended> {
  let step = 'context';
  try {
    return await processRow(deps, row, (s) => {
      step = s;
    });
  } catch (err) {
    const code = errorCode(err);
    deps.log.warn({ writebackId: row.id, aiCallId: row.aiCallId, step, errName: errName(err), code }, 'ai_call.writeback: a step failed');
    try {
      if (code !== null && GONE_CODES.has(code)) return await end({ deps, row }, 'skipped', code);
      const r = await retryWriteback(deps.db, row.id, row.attempts, deps.now, code ? `${errName(err)}: ${code}` : errName(err));
      return r === 'retry' ? 'retried' : 'failed';
    } catch (dbErr) {
      // The lease runs out and the row is claimed again; nothing leaves the tick.
      deps.log.error({ writebackId: row.id, errName: errName(dbErr) }, 'ai_call.writeback: could not record a failure');
      return 'retried';
    }
  }
}

export async function runWritebacks(deps: WritebackDeps): Promise<WritebackCounts> {
  const counts: WritebackCounts = { done: 0, partial: 0, skipped: 0, failed: 0, retried: 0 };
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + WRITEBACK_DEADLINE_MS;
  for (let i = 0; i < WRITEBACK_BATCH && clock() < deadline; i += 1) {
    const [row] = await claimWritebacks(deps.db, deps.now, 1);
    if (!row) break;
    counts[await runRow(deps, row)] += 1;
  }
  return counts;
}

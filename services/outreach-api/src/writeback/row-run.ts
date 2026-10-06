/**
 * Plan 1D write-back: the state of one row while the tick runs it, and the helpers every step shares. Each step's result is
 * saved (saveProgress) right after its Salesforce call, so a retry resumes where this run stopped and never redoes a step.
 */
import type { Db } from '@cti/db';
import { SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { readUsers, type OwnerUser } from '../appointments/calendar.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { DescribeCache } from '../research/describe.js';
import type { WritebackContext } from './context.js';
import type { MappingModel } from './mapping-model.js';
import { callResult } from './outcome-tables.js';
import { saveProgress, type Progress, type StepName, type StepState, type Steps, type WritebackRow } from './store.js';

export interface WritebackDeps {
  db: Db;
  clients: SalesforceClientFactory;
  describes: DescribeCache;
  model: MappingModel | null;
  appPublicUrl: string;
  now: Date;
  log: RunnerLogger;
  clock?: () => number;
  /** AI_CALL_DEFAULT_SPECIALISTS: bookingSettings needs it (Part 3 fix: the only reader of aiCallBooking). */
  defaultSpecialists: readonly string[];
}

/** One row in flight: replaced (never edited) as each step's result is saved. */
export interface RowRun {
  deps: WritebackDeps;
  client: SalesforceClient;
  ctx: WritebackContext;
  row: WritebackRow;
  /** The appointment owner's Salesforce user, read once per run when a step needs it. */
  owner?: Promise<OwnerUser | null>;
}

/** The record is deleted or merged (ENTITY_IS_DELETED / NOT_FOUND): the row ends skipped. */
export class RecordGoneError extends Error {
  constructor(readonly code: string) {
    super(`the record is gone (${code})`);
    this.name = 'RecordGoneError';
  }
}

export const GONE_CODES: ReadonlySet<string> = new Set(['ENTITY_IS_DELETED', 'NOT_FOUND']);
/**
 * Result-level codes that a retry can fix (thrown as SalesforceApiError so the tick backs off). UNKNOWN_EXCEPTION is
 * Salesforce's own internal error, which a later attempt usually clears (final review): never a final "Not written".
 */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set(['UNABLE_TO_LOCK_ROW', 'REQUEST_LIMIT_EXCEEDED', 'SERVER_UNAVAILABLE', 'UNKNOWN_EXCEPTION']);

/** A result-level error code the run must not record as a refusal: gone → RecordGoneError, transient → SalesforceApiError. */
export function throwIfNotARefusal(code: string): void {
  if (GONE_CODES.has(code)) throw new RecordGoneError(code);
  if (TRANSIENT_CODES.has(code)) throw new SalesforceApiError(`Salesforce answered ${code}`, 503, null, code);
}

/**
 * A step that has run for good. `failed` is final too (sweep D-23 M7): a step saves `failed` only for a refusal Salesforce
 * would repeat (a transient failure throws and saves nothing), and the steps after it already acted on it (the "Salesforce
 * refused the Event: call the seller" Task, the changes text), so re-running it on a later retry would contradict them.
 */
export const isDone = (run: RowRun, step: StepName): boolean => {
  const s = run.row.steps[step]?.status;
  return s === 'done' || s === 'skipped' || s === 'failed';
};

/** Saves a step's result (and any ids) and returns the run with them applied. */
export async function saveStep(run: RowRun, step: StepName, state: StepState, extra: Omit<Progress, 'steps'> = {}): Promise<RowRun> {
  await saveProgress(run.deps.db, run.row.id, { ...extra, steps: { [step]: state } }, run.deps.now);
  const steps: Steps = { ...run.row.steps, [step]: state };
  const row: WritebackRow = {
    ...run.row,
    steps,
    plan: extra.plan === undefined ? run.row.plan : extra.plan,
    sfEventId: extra.sfEventId ?? run.row.sfEventId,
    sfTaskId: extra.sfTaskId ?? run.row.sfTaskId,
    sfFeedItemId: extra.sfFeedItemId ?? run.row.sfFeedItemId,
    convertedOpportunityId: run.row.convertedOpportunityId ?? extra.convertedOpportunityId ?? null,
    convertedAccountId: run.row.convertedAccountId ?? extra.convertedAccountId ?? null,
    convertedContactId: run.row.convertedContactId ?? extra.convertedContactId ?? null,
  };
  return { ...run, row };
}

/** The call booked an appointment that stands (D-20: keyed on the result, so a booking then a transfer counts). */
export function isAppointmentCall(run: RowRun): boolean {
  const c = run.ctx.call;
  return callResult(c.outcome, null, c.appointment !== null, { practice: c.practice }) === 'appointment';
}

/** The appointment owner (the booking's specialist), read once per run; null when Salesforce does not return them. */
export function ownerOf(run: RowRun): Promise<OwnerUser | null> {
  const id = run.ctx.call.appointment?.specialistSfUserId;
  if (!id) return Promise.resolve(null);
  run.owner ??= readUsers(run.client, [id]).then((users) => [...users.values()][0] ?? null);
  return run.owner;
}

/** The org's PT calendar date (a Task's ActivityDate). */
export function ptToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** The first statusCode among a step's saved refusals, for last_error. */
export function stepCode(state: StepState | undefined): string | null {
  if (state?.status !== 'failed') return null;
  const code = /^[A-Z_]+/.exec(state.detail ?? '')?.[0];
  return code ?? 'FAILED';
}

/**
 * Plan 1D write-back rows (`ai_call_writebacks`, migration 0056): one per counted real AI call, enqueued in the results
 * transaction, claimed by the `ai_call.writeback` tick with a lease, retried with backoff, and resumed step by step (each
 * step's result is saved before the next starts, so a retry never redoes a step).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@cti/db';

export const WRITEBACK_OUTCOMES = ['qualified_transferred', 'qualified_callback', 'appointment_set', 'transfer_failed', 'not_interested', 'do_not_call', 'wrong_number', 'hung_up', 'other'] as const;
export const WRITEBACK_LEASE_MS = 5 * 60_000;
export const WRITEBACK_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000, 24 * 3_600_000] as const;
export const WRITEBACK_MAX_ATTEMPTS = 6;

export type StepName = 'convert' | 'plan' | 'appointment' | 'fields' | 'task' | 'chatter';
/**
 * One step's saved result. `eventId` / `taskId` are what the step created (CF-1 ignores them); `data` is what a later step or a
 * retry needs without asking Salesforce again (the Lead's name before conversion, the record's address...).
 */
export interface StepState {
  status: 'done' | 'skipped' | 'failed';
  detail?: string;
  eventId?: string;
  taskId?: string;
  data?: Record<string, unknown>;
}
export interface Steps {
  [k: string]: StepState;
}
export interface WritebackRow {
  id: string;
  orgId: string;
  aiCallId: string;
  touchId: string | null;
  enrollmentId: string | null;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  outcome: string;
  status: string;
  attempts: number;
  plan: unknown;
  steps: Steps;
  sfEventId: string | null;
  sfTaskId: string | null;
  sfFeedItemId: string | null;
  convertedOpportunityId: string | null;
  convertedAccountId: string | null;
  convertedContactId: string | null;
}

/** Where every step after `convert` writes: the new Opportunity when the Lead was converted, else the call's record. */
export function writeTarget(row: WritebackRow): { sobject: 'Lead' | 'Opportunity'; id: string } {
  return row.convertedOpportunityId !== null ? { sobject: 'Opportunity', id: row.convertedOpportunityId } : { sobject: row.sfObject, id: row.sfRecordId };
}

const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const core = (id: string): string => id.slice(0, 15);

/** Inside the results transaction: one row per call, ever. Writeback off → the row is born 'skipped' with last_error 'write-back is off'. */
export function enqueueWritebackSql(i: { touchId: string; now: Date; writebackOn: boolean }): SQL {
  const outcomes = sql.join(WRITEBACK_OUTCOMES.map((o) => sql`${o}`), sql`, `);
  return sql`
    insert into ai_call_writebacks (org_id, ai_call_id, touch_id, enrollment_id, sf_object, sf_record_id, outcome, status, last_error, next_attempt_at)
    select t.org_id, a.id, t.id, t.enrollment_id, r.sf_object, r.sf_record_id, a.outcome,
           case when ${i.writebackOn}::boolean then 'pending' else 'skipped' end,
           case when ${i.writebackOn}::boolean then null else 'write-back is off' end, ${iso(i.now)}
    from touches t
    join ai_calls a on a.id = t.ai_call_id and a.org_id = t.org_id
    join campaign_enrollments e on e.id = t.enrollment_id
    join crm_records r on r.id = e.crm_record_id
    where t.id = ${i.touchId}::uuid and a.is_test = false and a.outcome in (${outcomes})
      and r.sf_object in ('Lead', 'Opportunity')
    on conflict (ai_call_id) do nothing`;
}

interface RawRow {
  id: string;
  org_id: string;
  ai_call_id: string;
  touch_id: string | null;
  enrollment_id: string | null;
  sf_object: 'Lead' | 'Opportunity';
  sf_record_id: string;
  outcome: string;
  status: string;
  attempts: number;
  plan: unknown;
  steps: unknown;
  sf_event_id: string | null;
  sf_task_id: string | null;
  sf_feed_item_id: string | null;
  converted_opportunity_id: string | null;
  converted_account_id: string | null;
  converted_contact_id: string | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Saved steps, tolerantly: an entry that is not a step is dropped (the step then runs again). */
function stepsOf(raw: unknown): Steps {
  if (!isObject(raw)) return {};
  const out: Steps = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isObject(v) && (v.status === 'done' || v.status === 'skipped' || v.status === 'failed')) out[k] = v as unknown as StepState;
  }
  return out;
}

const toRow = (r: RawRow): WritebackRow => ({
  id: r.id,
  orgId: r.org_id,
  aiCallId: r.ai_call_id,
  touchId: r.touch_id,
  enrollmentId: r.enrollment_id,
  sfObject: r.sf_object,
  sfRecordId: r.sf_record_id,
  outcome: r.outcome,
  status: r.status,
  attempts: r.attempts,
  plan: r.plan,
  steps: stepsOf(r.steps),
  sfEventId: r.sf_event_id,
  sfTaskId: r.sf_task_id,
  sfFeedItemId: r.sf_feed_item_id,
  convertedOpportunityId: r.converted_opportunity_id,
  convertedAccountId: r.converted_account_id,
  convertedContactId: r.converted_contact_id,
});

/** Due rows (pending, or running with an expired lease), leased for WRITEBACK_LEASE_MS; concurrent claims never share a row. */
export async function claimWritebacks(db: Db, now: Date, limit: number): Promise<WritebackRow[]> {
  const result = await db.execute(sql`
    update ai_call_writebacks w
    set status = 'running', attempts = w.attempts + 1, locked_until = ${iso(new Date(now.getTime() + WRITEBACK_LEASE_MS))}, updated_at = ${iso(now)}
    where w.id in (
      select id from ai_call_writebacks
      where status in ('pending', 'running') and next_attempt_at <= ${iso(now)} and (locked_until is null or locked_until < ${iso(now)})
      order by next_attempt_at, id
      limit ${limit}
      for update skip locked)
    returning w.id, w.org_id, w.ai_call_id, w.touch_id, w.enrollment_id, w.sf_object, w.sf_record_id, w.outcome, w.status, w.attempts,
              w.plan, w.steps, w.sf_event_id, w.sf_task_id, w.sf_feed_item_id, w.converted_opportunity_id, w.converted_account_id, w.converted_contact_id`);
  return rows<RawRow>(result).map(toRow);
}

export interface Progress {
  plan?: unknown;
  /** Merged into the saved steps (top-level keys replace). */
  steps?: Steps;
  sfEventId?: string;
  sfTaskId?: string;
  sfFeedItemId?: string;
  convertedOpportunityId?: string;
  convertedAccountId?: string;
  convertedContactId?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** Saves a step's result. A `converted_*` id is set only while it is null: a saved conversion is never replaced. */
export async function saveProgress(db: Db, id: string, patch: Progress, now: Date): Promise<void> {
  const sets: SQL[] = [sql`updated_at = ${iso(now)}`];
  if (patch.plan !== undefined) sets.push(sql`plan = ${JSON.stringify(patch.plan)}::jsonb`);
  if (patch.steps !== undefined) sets.push(sql`steps = (case when jsonb_typeof(steps) = 'object' then steps else '{}'::jsonb end) || ${JSON.stringify(patch.steps)}::jsonb`);
  if (patch.sfEventId !== undefined) sets.push(sql`sf_event_id = ${patch.sfEventId}`);
  if (patch.sfTaskId !== undefined) sets.push(sql`sf_task_id = ${patch.sfTaskId}`);
  if (patch.sfFeedItemId !== undefined) sets.push(sql`sf_feed_item_id = ${patch.sfFeedItemId}`);
  if (patch.convertedOpportunityId !== undefined) sets.push(sql`converted_opportunity_id = coalesce(converted_opportunity_id, ${patch.convertedOpportunityId})`);
  if (patch.convertedAccountId !== undefined) sets.push(sql`converted_account_id = coalesce(converted_account_id, ${patch.convertedAccountId})`);
  if (patch.convertedContactId !== undefined) sets.push(sql`converted_contact_id = coalesce(converted_contact_id, ${patch.convertedContactId})`);
  if (patch.model !== undefined) sets.push(sql`model = ${patch.model}`);
  if (patch.inputTokens !== undefined) sets.push(sql`input_tokens = ${patch.inputTokens}`);
  if (patch.outputTokens !== undefined) sets.push(sql`output_tokens = ${patch.outputTokens}`);
  await db.execute(sql`update ai_call_writebacks set ${sql.join(sets, sql`, `)} where id = ${id}::uuid`);
}

export async function finishWriteback(db: Db, id: string, status: 'done' | 'partial' | 'skipped' | 'failed', now: Date, error?: string | null): Promise<void> {
  await db.execute(sql`
    update ai_call_writebacks set status = ${status}, completed_at = ${iso(now)}, locked_until = null, last_error = ${error ?? null}, updated_at = ${iso(now)}
    where id = ${id}::uuid`);
}

/** A transient failure: back to pending after the backoff for this attempt, or `failed` once WRITEBACK_MAX_ATTEMPTS are used. */
export async function retryWriteback(db: Db, id: string, attempts: number, now: Date, error: string): Promise<'retry' | 'failed'> {
  if (attempts >= WRITEBACK_MAX_ATTEMPTS) {
    await finishWriteback(db, id, 'failed', now, error);
    return 'failed';
  }
  const wait: number = WRITEBACK_BACKOFF_MS[Math.min(Math.max(0, attempts - 1), WRITEBACK_BACKOFF_MS.length - 1)]!;
  await db.execute(sql`
    update ai_call_writebacks
    set status = 'pending', next_attempt_at = ${iso(new Date(now.getTime() + wait))}, locked_until = null, last_error = ${error}, updated_at = ${iso(now)}
    where id = ${id}::uuid`);
  return 'retry';
}

/** The row waits until `until` without using an attempt (the daily AI budget is spent: it resumes the next UTC day). */
export async function deferWriteback(db: Db, id: string, until: Date, now: Date, reason: string): Promise<void> {
  await db.execute(sql`
    update ai_call_writebacks
    set status = 'pending', attempts = greatest(attempts - 1, 0), next_attempt_at = ${iso(until)}, locked_until = null, last_error = ${reason}, updated_at = ${iso(now)}
    where id = ${id}::uuid`);
}

/**
 * CF-1: the Salesforce Event and Task ids the write-back created on these records (or on the Opportunity a Lead became),
 * from the columns and from every step, as 15-character cores (the activity check compares cores).
 */
export async function writebackActivityIds(db: Db, orgId: string, sfRecordIds: readonly string[]): Promise<Set<string>> {
  if (sfRecordIds.length === 0) return new Set();
  const ids = sql.join(sfRecordIds.map((id) => sql`${id}`), sql`, `);
  const result = await db.execute(sql`
    select x.id from ai_call_writebacks w,
      lateral (
        select w.sf_event_id union all select w.sf_task_id
        union all select s.value->>'eventId' from jsonb_each(case when jsonb_typeof(w.steps) = 'object' then w.steps else '{}'::jsonb end) s where jsonb_typeof(s.value) = 'object'
        union all select s.value->>'taskId' from jsonb_each(case when jsonb_typeof(w.steps) = 'object' then w.steps else '{}'::jsonb end) s where jsonb_typeof(s.value) = 'object'
      ) x(id)
    where w.org_id = ${orgId}::uuid and (w.sf_record_id in (${ids}) or w.converted_opportunity_id in (${ids})) and x.id is not null`);
  return new Set(rows<{ id: string }>(result).map((r) => core(r.id)));
}

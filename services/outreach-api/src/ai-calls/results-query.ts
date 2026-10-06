/**
 * The campaign's AI call results table and a call's transcript (read-only; `ai_calls` is
 * cti-api's table). A call is visible here only through an outreach touch of this tenant,
 * so a test call, or another tenant's call, is never listed or opened.
 */
import { sql } from 'drizzle-orm';
import {
  AiCallOutcome,
  AiCallStatus,
  BookedAppointment,
  TranscriptLine,
  WritebackStatus,
  type AiCallResult,
  type AiCallResultsResponse,
  type AiCallTranscript,
  type WritebackChange,
  type WritebackSummary,
} from '@cti/contracts';
import type { Db } from '@cti/db';
import { decodeCardCursor, encodeCardCursor } from '../call-plans/cards.js';
import { loadConnection } from '../crm/connection-store.js';
import { mayDecide, mayDecideWith, ownSfUserId } from '../tenancy/record-owner.js';
import type { RequestContext } from '../tenancy/scope.js';
import { StoredWritePlan, type Skipped } from '../writeback/plan.js';

export const RESULTS_PAGE_SIZE = 50;

interface ResultRow {
  touch_id: string;
  enrollment_id: string;
  touch_status: AiCallResult['touchStatus'];
  due_at: Date | string;
  attempts: number;
  last_block_reason: string | null;
  ai_call_id: string | null;
  created_cursor: string;
  name: string | null;
  sf_object: AiCallResult['sfObject'];
  sf_record_id: string;
  owner_sf_user_id: string | null;
  enrollment_status: string;
  exit_reason: string | null;
  call_status: string | null;
  outcome: string | null;
  summary: string | null;
  qualification: unknown;
  duration_seconds: number | null;
  started_at: Date | string | null;
  appointment: unknown;
  w_status: string | null;
  w_plan: unknown;
  w_steps: unknown;
  w_last_error: string | null;
  w_event_id: string | null;
  w_task_id: string | null;
  w_feed_item_id: string | null;
  w_converted_opportunity_id: string | null;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
/** Raw SQL rows give timestamps as strings. */
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function qualificationOf(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return Object.keys(v).length > 0 ? (v as Record<string, unknown>) : null;
}

/** A record's Salesforce link on the tenant's instance; null without a connection. */
const recordUrl = (instanceUrl: string | null, id: string | null): string | null => (instanceUrl && id ? `${instanceUrl.replace(/\/$/, '')}/${id}` : null);

function toResult(r: ResultRow, ctx: RequestContext, mine: string | null, instanceUrl: string | null): AiCallResult {
  const status = AiCallStatus.safeParse(r.call_status);
  const outcome = AiCallOutcome.safeParse(r.outcome);
  return {
    touchId: r.touch_id,
    enrollmentId: r.enrollment_id,
    name: r.name,
    sfObject: r.sf_object,
    sfRecordId: r.sf_record_id,
    recordUrl: recordUrl(instanceUrl, r.sf_record_id),
    touchStatus: r.touch_status,
    dueAt: iso(r.due_at)!,
    attempts: r.attempts,
    lastBlockReason: r.last_block_reason,
    aiCallId: r.ai_call_id,
    callStatus: status.success ? status.data : null,
    outcome: outcome.success ? outcome.data : null,
    summary: r.summary,
    qualification: qualificationOf(r.qualification),
    durationSeconds: r.duration_seconds,
    startedAt: iso(r.started_at),
    enrollmentStatus: r.enrollment_status,
    exitReason: r.exit_reason,
    mayReadTranscript: r.ai_call_id !== null && mayDecideWith(ctx, mine, r.owner_sf_user_id),
    // D-6: each row's JSON is read on its own; a drifted row reads as null and never breaks the page.
    appointment: parsed(BookedAppointment, r.appointment),
    writeback: writebackSummary(r, isAdmin(ctx), instanceUrl),
  };
}

const isAdmin = (ctx: RequestContext): boolean => ctx.session.isAdmin || ctx.session.isSuperAdmin;
const parsed = <T>(s: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | null => {
  const out = s.safeParse(v);
  return out.success ? out.data : null;
};
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const entry = (kind: WritebackChange['kind'], label: unknown, before: unknown, after: unknown): WritebackChange => ({
  kind,
  label: str(label) ?? '(field)',
  before: str(before),
  after: str(after),
});

/** A plan entry the write-back did not write, in words (the web shows `after` as the reason of a not_written entry). */
export const SKIPPED_WORDS: Readonly<Record<Skipped['why'], string>> = {
  not_writable: "the connected Salesforce user can't edit it",
  invalid_value: 'Salesforce has no such value for it',
  moved_since_research: 'changed in Salesforce since the research',
  not_from_state: 'not moved from the status it is in',
};
export const MAX_WRITEBACK_CHANGES = 80;

/** The created records and the conversion, from the row's ids and step results. */
function createdChanges(r: ResultRow, steps: Record<string, unknown>): WritebackChange[] {
  const convert = obj(steps.convert);
  const hold = obj(steps.appointment).detail === 'lead_hold';
  return [
    ...(r.w_converted_opportunity_id ? [entry('converted', 'Lead converted to an Opportunity', r.sf_record_id, r.w_converted_opportunity_id)] : []),
    ...(!r.w_converted_opportunity_id && (convert.status === 'failed' || convert.status === 'skipped') ? [entry('not_written', 'Lead conversion', null, convert.detail)] : []),
    ...(r.w_event_id ? [entry('created', hold ? 'Calendar hold' : 'Appointment Event', null, r.w_event_id)] : []),
    ...(r.w_task_id ? [entry('created', 'Task', null, r.w_task_id)] : []),
    ...(r.w_feed_item_id ? [entry('created', 'Chatter post', null, r.w_feed_item_id)] : []),
  ];
}

/**
 * The write-back as the results page shows it: what was changed (what the fields step wrote, or the plan before it ran),
 * kept (a rep's value kept over the seller's answer, or edited since the call), not written (with why), created and
 * converted, capped at 80. A plan that no longer parses lists nothing; it never throws.
 */
export function writebackSummary(r: ResultRow, admin: boolean, instanceUrl: string | null = null): WritebackSummary | null {
  const status = WritebackStatus.safeParse(r.w_status);
  if (!status.success) return null;
  const plan = r.w_plan === null ? null : StoredWritePlan.safeParse(r.w_plan);
  const steps = obj(r.w_steps);
  const fields = obj(obj(steps.fields).data);
  const changes: WritebackChange[] =
    plan && !plan.success
      ? []
      : [
          ...createdChanges(r, steps),
          ...(Array.isArray(fields.written) ? list(fields.written) : (plan?.data.changes ?? [])).map((c) => entry('changed', c.label, c.before, c.after)),
          ...(plan?.data.kept ?? []).map((k) => entry('kept', k.label, k.current, k.proposed)),
          ...list(fields.notChanged).map((n) => entry('kept', n.label, n.now, null)),
          ...(plan?.data.skipped ?? []).map((k) => entry('not_written', k.label, null, SKIPPED_WORDS[k.why])),
          ...list(fields.notWritten).map((n) => entry('not_written', n.label, null, n.reason)),
        ];
  return {
    status: status.data,
    changes: changes.slice(0, MAX_WRITEBACK_CHANGES),
    // Final review: last_error is for admins only; it may carry Salesforce's own words.
    error: admin ? r.w_last_error : null,
    mayRetry: status.data === 'failed' && admin,
    convertedOpportunityId: r.w_converted_opportunity_id,
    convertedOpportunityUrl: recordUrl(instanceUrl, r.w_converted_opportunity_id),
  };
}

/** Newest first, 50 a page, keyset on (created_at, id). The caller checked the campaign is this tenant's. */
export async function listAiCallResults(db: Db, ctx: RequestContext, campaignId: string, cursor: string | null): Promise<AiCallResultsResponse> {
  const after = decodeCardCursor(cursor);
  const result = await db.execute(sql`
    select t.id as touch_id, t.enrollment_id, t.status as touch_status, t.due_at, t.attempts, t.last_block_reason, t.ai_call_id,
           to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_cursor,
           r.name, r.sf_object, r.sf_record_id, r.owner_sf_user_id,
           e.status as enrollment_status, e.exit_reason,
           a.status as call_status, a.outcome, a.summary, a.qualification, a.duration_seconds, a.started_at, a.appointment,
           w.status as w_status, w.plan as w_plan, w.steps as w_steps, w.last_error as w_last_error, w.sf_event_id as w_event_id,
           w.sf_task_id as w_task_id, w.sf_feed_item_id as w_feed_item_id, w.converted_opportunity_id as w_converted_opportunity_id
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    left join ai_calls a on a.id = t.ai_call_id and a.org_id = t.org_id
    left join ai_call_writebacks w on w.ai_call_id = a.id and w.org_id = t.org_id
    where t.org_id = ${ctx.orgId}::uuid and e.campaign_id = ${campaignId}::uuid and t.channel = 'ai_call'
      ${after ? sql`and (t.created_at, t.id) < (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
    order by t.created_at desc, t.id desc
    limit ${RESULTS_PAGE_SIZE + 1}`);
  const page = rows<ResultRow>(result);
  const items = page.slice(0, RESULTS_PAGE_SIZE);
  const [mine, conn] = await Promise.all([ownSfUserId(db, ctx.session.userId), loadConnection(db, ctx.orgId)]);
  const last = items.at(-1);
  return {
    items: items.map((r) => toResult(r, ctx, mine, conn?.instanceUrl ?? null)),
    nextCursor: page.length > RESULTS_PAGE_SIZE && last ? encodeCardCursor(last.created_cursor, last.touch_id) : null,
  };
}

/** Well-formed entries of `ai_calls.transcript`, in order; anything else is dropped. */
export function transcriptLines(raw: unknown): TranscriptLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const line = TranscriptLine.safeParse({ ...(typeof entry === 'object' && entry !== null ? entry : {}), at: (entry as { at?: unknown } | null)?.at ?? null });
    return line.success ? [line.data] : [];
  });
}

/**
 * The owner of the record or an admin may read it; null when no outreach touch of this tenant carries the call. Plan 1D: a
 * practice call of this tenant (ai_practice_calls) is readable by its admins only.
 */
export async function loadTranscript(db: Db, ctx: RequestContext, aiCallId: string): Promise<AiCallTranscript | 'forbidden' | null> {
  const result = await db.execute(sql`
    select a.transcript, r.owner_sf_user_id
    from ai_calls a
    join touches t on t.ai_call_id = a.id and t.org_id = a.org_id and t.channel = 'ai_call'
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    where a.id = ${aiCallId}::uuid and a.org_id = ${ctx.orgId}::uuid
    limit 1`);
  const row = rows<{ transcript: unknown; owner_sf_user_id: string | null }>(result)[0];
  if (!row) return loadPracticeTranscript(db, ctx, aiCallId);
  if (!(await mayDecide(db, ctx, row.owner_sf_user_id))) return 'forbidden';
  return { aiCallId, lines: transcriptLines(row.transcript) };
}

/** A practice call (plan 1D) or a Test a record call (plan 1E): admins of its tenant only. */
async function loadPracticeTranscript(db: Db, ctx: RequestContext, aiCallId: string): Promise<AiCallTranscript | 'forbidden' | null> {
  const result = await db.execute(sql`
    select a.transcript
    from ai_calls a
    where a.id = ${aiCallId}::uuid and a.org_id = ${ctx.orgId}::uuid
      and (exists (select 1 from ai_practice_calls p where p.ai_call_id = a.id and p.org_id = a.org_id)
        -- P6 M-10: a practice row whose answer was lost is linked by its key (cti-api stored the call under it).
        or exists (select 1 from ai_practice_calls p join ai_call_requests q on q.org_id = p.org_id and q.idempotency_key = p.idempotency_key
                   where p.ai_call_id is null and p.org_id = a.org_id and q.ai_call_id = a.id)
        -- Plan 1E: a Test a record call, by the call it stored or (a lost answer) by its rtest: key.
        or exists (select 1 from ai_record_test_calls c where c.ai_call_id = a.id and c.org_id = a.org_id)
        or exists (select 1 from ai_record_test_calls c join ai_call_requests q on q.org_id = c.org_id and q.idempotency_key = c.idempotency_key
                   where c.ai_call_id is null and c.org_id = a.org_id and q.ai_call_id = a.id))
    limit 1`);
  const row = rows<{ transcript: unknown }>(result)[0];
  if (!row) return null;
  if (!(ctx.session.isAdmin || ctx.session.isSuperAdmin)) return 'forbidden';
  return { aiCallId, lines: transcriptLines(row.transcript) };
}

/**
 * The campaign's AI call results table and a call's transcript (read-only; `ai_calls` is
 * cti-api's table). A call is visible here only through an outreach touch of this tenant,
 * so a test call, or another tenant's call, is never listed or opened.
 */
import { sql } from 'drizzle-orm';
import { AiCallOutcome, AiCallStatus, TranscriptLine, type AiCallResult, type AiCallResultsResponse, type AiCallTranscript } from '@cti/contracts';
import type { Db } from '@cti/db';
import { decodeCardCursor, encodeCardCursor } from '../call-plans/cards.js';
import { loadConnection } from '../crm/connection-store.js';
import { mayDecide, mayDecideWith, ownSfUserId } from '../tenancy/record-owner.js';
import type { RequestContext } from '../tenancy/scope.js';

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
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
/** Raw SQL rows give timestamps as strings. */
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());

function qualificationOf(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  return Object.keys(v).length > 0 ? (v as Record<string, unknown>) : null;
}

function toResult(r: ResultRow, ctx: RequestContext, mine: string | null, instanceUrl: string | null): AiCallResult {
  const status = AiCallStatus.safeParse(r.call_status);
  const outcome = AiCallOutcome.safeParse(r.outcome);
  return {
    touchId: r.touch_id,
    enrollmentId: r.enrollment_id,
    name: r.name,
    sfObject: r.sf_object,
    sfRecordId: r.sf_record_id,
    recordUrl: instanceUrl ? `${instanceUrl.replace(/\/$/, '')}/${r.sf_record_id}` : null,
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
    // Plan 1D Task 29 fills these from ai_calls.appointment and ai_call_writebacks.
    appointment: null,
    writeback: null,
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
           a.status as call_status, a.outcome, a.summary, a.qualification, a.duration_seconds, a.started_at
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    left join ai_calls a on a.id = t.ai_call_id and a.org_id = t.org_id
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

async function loadPracticeTranscript(db: Db, ctx: RequestContext, aiCallId: string): Promise<AiCallTranscript | 'forbidden' | null> {
  const result = await db.execute(sql`
    select a.transcript
    from ai_calls a
    join ai_practice_calls p on p.ai_call_id = a.id and p.org_id = a.org_id
    where a.id = ${aiCallId}::uuid and a.org_id = ${ctx.orgId}::uuid
    limit 1`);
  const row = rows<{ transcript: unknown }>(result)[0];
  if (!row) return null;
  if (!(ctx.session.isAdmin || ctx.session.isSuperAdmin)) return 'forbidden';
  return { aiCallId, lines: transcriptLines(row.transcript) };
}

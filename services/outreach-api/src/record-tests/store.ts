/**
 * Test a record (plan 1E): the ai_record_tests rows. A preview is inserted `running` (under the limits' lock, limits.ts),
 * finished once by runPreview (preview.ts), and read back org-scoped. A row a restart left `running` READS as
 * failed: interrupted after PREVIEW_STALE_MS; nothing rewrites it. Every JSON column is read with safeParse, so a drifted
 * row shows nulls and never throws (1D D-6). Plan 1E Part 2: the test calls run from a preview (ai_record_test_calls),
 * joined to the ai_calls rows cti-api wrote.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import {
  AiCallOutcome,
  AiCallStatus,
  AppointmentSlots,
  BookedAppointment,
  CallPlan,
  InternalAiCallResponse,
  RecordTestDryRun,
  RecordTestError,
  type AppointmentSlot,
  type RecordTest,
  type RecordTestCall,
  type RecordTestsResponse,
  type SfObject,
} from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { ResearchSnapshot } from '../research/snapshot.js';

/** A `running` preview older than this reads as failed: interrupted (the model call itself aborts at 4 minutes). */
export const PREVIEW_STALE_MS = 6 * 60_000;
/** The list shows the tenant's latest this many. */
export const RECORD_TEST_LIST_LIMIT = 20;

/** What a finished preview stores. */
export interface PreviewResult {
  name: string | null;
  research: ResearchSnapshot;
  plan: CallPlan;
  /** The exact text the voice agent gets; null when the plan text check refused it. */
  planText: string | null;
  /** describePlanTextIssues words when planText is null. */
  planTextIssues: string[];
  slots: AppointmentSlot[];
  offerNote: string | null;
  ownerSfUserId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

/** A failed preview: the code, and what the model call cost when one was paid for. */
export interface PreviewFailure {
  error: Exclude<RecordTestError, 'interrupted'>;
  usage?: { model: string; inputTokens: number; outputTokens: number; costMicros: number };
}

export type RecordTestRow = typeof schema.aiRecordTests.$inferSelect & { requestedByName: string | null };

const isFailure = (v: PreviewResult | PreviewFailure): v is PreviewFailure => 'error' in v;

export async function insertRecordTest(db: Db, v: { orgId: string; requestedBy: string; sfObject: SfObject; sfRecordId: string }): Promise<string> {
  const [row] = await db
    .insert(schema.aiRecordTests)
    .values({ orgId: v.orgId, requestedBy: v.requestedBy, sfObject: v.sfObject, sfRecordId: v.sfRecordId })
    .returning({ id: schema.aiRecordTests.id });
  return row!.id;
}

/**
 * Ends a preview once: only a row still `running`, and not yet old enough to read as failed: interrupted, is written. So
 * a late finish never overwrites an earlier one, and a slow run never turns an "interrupted" the admin saw (after which
 * another preview may have started) into a ready one.
 */
export async function finishRecordTest(db: Db, id: string, v: PreviewResult | PreviewFailure, now: Date): Promise<void> {
  const t = schema.aiRecordTests;
  const set = isFailure(v)
    ? {
        status: 'failed' as const,
        error: v.error,
        ...(v.usage ? { model: v.usage.model, inputTokens: v.usage.inputTokens, outputTokens: v.usage.outputTokens, costMicros: v.usage.costMicros } : {}),
        completedAt: now,
      }
    : {
        status: 'ready' as const,
        name: v.name,
        research: v.research,
        plan: v.plan,
        planText: v.planText,
        planTextIssues: v.planTextIssues,
        slots: v.slots,
        offerNote: v.offerNote,
        ownerSfUserId: v.ownerSfUserId,
        model: v.model,
        inputTokens: v.inputTokens,
        outputTokens: v.outputTokens,
        costMicros: v.costMicros,
        completedAt: now,
      };
  const notStale = gte(t.createdAt, new Date(now.getTime() - PREVIEW_STALE_MS));
  await db.update(t).set(set).where(and(eq(t.id, id), eq(t.status, 'running'), notStale));
}

/** A `running` row older than PREVIEW_STALE_MS reads as failed: interrupted. A new object; the stored row is untouched. */
function asRead<T extends { status: string; error: string | null; createdAt: Date }>(row: T, now: Date): T {
  const stale = row.status === 'running' && now.getTime() - row.createdAt.getTime() > PREVIEW_STALE_MS;
  return stale ? { ...row, status: 'failed', error: 'interrupted' } : row;
}

/** The org's Salesforce instance URL alone (the page polls; the connection row also holds the tokens). */
export async function loadInstanceUrl(db: Db, orgId: string): Promise<string | null> {
  const c = schema.crmConnections;
  const [row] = await db.select({ instanceUrl: c.instanceUrl }).from(c).where(eq(c.orgId, orgId)).limit(1);
  return row?.instanceUrl ?? null;
}

const requestedByName = sql<string | null>`coalesce(${schema.users.displayName}, ${schema.users.email})`;

/** The org's test `id` (null for another org's), with a stale `running` read as failed: interrupted. */
export async function loadRecordTest(db: Db, orgId: string, id: string, now: Date): Promise<RecordTestRow | null> {
  const t = schema.aiRecordTests;
  const [row] = await db
    .select({ test: t, requestedByName })
    .from(t)
    .leftJoin(schema.users, eq(schema.users.id, t.requestedBy))
    .where(and(eq(t.orgId, orgId), eq(t.id, id)));
  return row ? asRead({ ...row.test, requestedByName: row.requestedByName }, now) : null;
}

/** The tenant's latest RECORD_TEST_LIST_LIMIT tests, newest first. */
export async function listRecordTests(db: Db, orgId: string, now: Date = new Date()): Promise<RecordTestsResponse> {
  const t = schema.aiRecordTests;
  const rows = await db
    .select({ id: t.id, sfObject: t.sfObject, sfRecordId: t.sfRecordId, name: t.name, status: t.status, error: t.error, createdAt: t.createdAt, requestedByName })
    .from(t)
    .leftJoin(schema.users, eq(schema.users.id, t.requestedBy))
    .where(eq(t.orgId, orgId))
    .orderBy(sql`${t.createdAt} desc`, sql`${t.id} desc`)
    .limit(RECORD_TEST_LIST_LIMIT);
  return {
    items: rows.map((r) => {
      const read = asRead(r, now);
      return {
        id: read.id,
        sfObject: read.sfObject,
        sfRecordId: read.sfRecordId,
        name: read.name,
        status: read.status,
        createdAt: read.createdAt.toISOString(),
        requestedByName: read.requestedByName,
      };
    }),
  };
}

const parsedOrNull = <T>(schemaOf: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | null => {
  const parsed = schemaOf.safeParse(v);
  return parsed.success ? parsed.data : null;
};
const words = (v: unknown): string[] => (Array.isArray(v) && v.every((w) => typeof w === 'string') ? v : []);

/** The API shape of a test row. `instanceUrl` builds "Open in Salesforce" (as call-plans/cards.ts does). */
export function toRecordTest(row: RecordTestRow, calls: RecordTestCall[], instanceUrl: string | null): RecordTest {
  const research = parsedOrNull(ResearchSnapshot, row.research);
  const plan = parsedOrNull(CallPlan, row.plan);
  return {
    id: row.id,
    sfObject: row.sfObject,
    sfRecordId: row.sfRecordId,
    recordUrl: instanceUrl ? `${instanceUrl.replace(/\/$/, '')}/${row.sfRecordId}` : null,
    name: row.name,
    status: row.status,
    error: parsedOrNull(RecordTestError, row.error),
    consent: research?.consent ?? null,
    plan,
    planText: row.planText,
    planTextWords: words(row.planTextIssues),
    returning: plan?.reengagement?.lastContact != null,
    slots: parsedOrNull(AppointmentSlots, row.slots) ?? [],
    offerNote: row.offerNote,
    ownerSfUserId: row.ownerSfUserId,
    sources: research?.sources ?? [],
    costMicros: row.costMicros,
    requestedByName: row.requestedByName,
    createdAt: row.createdAt.toISOString(),
    calls,
  };
}

interface CallRow {
  id: string;
  mode: RecordTestCall['mode'];
  to_e164: string | null;
  created_at: Date | string;
  ai_call_id: string | null;
  result: unknown;
  dry_run: unknown;
  call_status: string | null;
  outcome: string | null;
  summary: string | null;
  duration_seconds: number | null;
  callback_at: Date | string | null;
  qualification: unknown;
  appointment: unknown;
  offered_slots: unknown;
}

/** What the call learned: only string answers are kept (a drifted value never breaks the page). */
function stringsOnly(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** The first name of the specialist on the offered slot the seller booked (as cti-api stored both); null when not found. */
function bookedWith(appointment: BookedAppointment | null, offered: unknown): string | null {
  if (!appointment) return null;
  const slots = parsedOrNull(AppointmentSlots, offered) ?? [];
  const slot = slots.find((s) => s.id === appointment.slotId && s.specialistSfUserId === appointment.specialistSfUserId);
  return slot?.specialistFirstName ?? null;
}

function toRecordTestCall(r: CallRow): RecordTestCall {
  const appointment = parsedOrNull(BookedAppointment, r.appointment);
  return {
    id: r.id,
    mode: r.mode,
    toE164: r.to_e164,
    createdAt: new Date(r.created_at).toISOString(),
    aiCallId: r.ai_call_id,
    result: parsedOrNull(InternalAiCallResponse, r.result),
    callStatus: parsedOrNull(AiCallStatus, r.call_status),
    outcome: parsedOrNull(AiCallOutcome, r.outcome),
    summary: r.summary,
    durationSeconds: r.duration_seconds,
    callbackAt: r.callback_at === null ? null : new Date(r.callback_at).toISOString(),
    qualification: stringsOnly(r.qualification),
    appointment,
    appointmentWith: bookedWith(appointment, r.offered_slots),
    dryRun: parsedOrNull(RecordTestDryRun, r.dry_run),
  };
}

/**
 * The calls run from test `testId` in this org, newest first, each joined to its ai_calls row. A call whose cti-api
 * answer was lost (a timeout after it placed the call) finds its call and answer by its rtest: key in ai_call_requests,
 * where cti-api stores every answer (as 1D listPracticeCalls does).
 */
export async function loadRecordTestCalls(db: Db, orgId: string, testId: string): Promise<RecordTestCall[]> {
  const result = await db.execute(sql`
    select c.id, c.mode, c.to_e164, c.created_at, coalesce(c.ai_call_id, q.ai_call_id) as ai_call_id, coalesce(c.result, q.response) as result,
           c.dry_run, a.status as call_status, a.outcome, a.summary, a.duration_seconds, a.callback_at, a.qualification, a.appointment,
           a.offered_slots
    from ai_record_test_calls c
    left join ai_call_requests q on c.ai_call_id is null and q.org_id = c.org_id and q.idempotency_key = c.idempotency_key
    left join ai_calls a on a.id = coalesce(c.ai_call_id, q.ai_call_id) and a.org_id = c.org_id
    where c.org_id = ${orgId}::uuid and c.record_test_id = ${testId}::uuid
    order by c.created_at desc, c.id desc`);
  return (result as unknown as { rows: CallRow[] }).rows.map(toRecordTestCall);
}

/**
 * Test a record (plan 1E): the ai_record_tests rows. A preview is inserted `running` (under the limits' lock, limits.ts),
 * finished once by runPreview (preview.ts), and read back org-scoped. A row a restart left `running` READS as
 * failed: interrupted after PREVIEW_STALE_MS; nothing rewrites it. Every JSON column is read with safeParse, so a drifted
 * row shows nulls and never throws (1D D-6).
 */
import { and, eq, sql } from 'drizzle-orm';
import {
  AppointmentSlots,
  CallPlan,
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

/** Ends a preview once: only a row still `running` is written, so a late finish never overwrites an earlier one. */
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
  await db.update(t).set(set).where(and(eq(t.id, id), eq(t.status, 'running')));
}

/** A `running` row older than PREVIEW_STALE_MS reads as failed: interrupted. A new object; the stored row is untouched. */
function asRead<T extends { status: string; error: string | null; createdAt: Date }>(row: T, now: Date): T {
  const stale = row.status === 'running' && now.getTime() - row.createdAt.getTime() > PREVIEW_STALE_MS;
  return stale ? { ...row, status: 'failed', error: 'interrupted' } : row;
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

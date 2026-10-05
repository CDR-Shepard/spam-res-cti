/**
 * Research and plan versions per enrollment, and the record_triage row a plan's do-not-contact flag becomes.
 *
 * Versions only ever grow. An enrollment has at most one current plan (`proposed` or
 * `approved`, partial unique `call_plans_current_unique`); writers supersede it and insert
 * the next version in one transaction. A lead re-enrolled after it was deselected starts
 * with no current plan (campaigns/reenroll.ts supersedes it), and `latestResearch` reads the
 * research behind the current plan, so nothing from before the reactivation is ever used.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { TriageResult, type CallPlan, type DoNotContactCategory } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { snapshotHash, snapshotSize, type ResearchSnapshot } from '../research/snapshot.js';
import { cutUtf16 } from '../research/text.js';

/** `@cti/db` declares these row types but does not export them from its index. */
export type CallPlanRow = typeof schema.callPlans.$inferSelect;
export type CallResearchRow = typeof schema.callResearch.$inferSelect;

const UNIQUE_VIOLATION = '23505';
const CURRENT_STATUSES = ['proposed', 'approved'] as const;
const TRIAGE_SUMMARY_MAX = 600;
const FALLBACK_SUMMARY = 'Do-not-contact signal found while researching a call.';

const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === UNIQUE_VIOLATION;
const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

/**
 * Runs `fn` in a savepoint (a transaction when `tx` is the pool), retrying once when a
 * concurrent writer took the same version: the failed attempt rolls back to the savepoint,
 * so the caller's transaction stays usable, and the retry computes the next max(version) + 1.
 */
async function withVersionRetry<T>(tx: Db, fn: (sp: Db) => Promise<T>): Promise<T> {
  try {
    return await tx.transaction((sp) => fn(sp as unknown as Db));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return tx.transaction((sp) => fn(sp as unknown as Db));
  }
}

export async function saveResearch(
  tx: Db,
  a: { orgId: string; enrollmentId: string; crmRecordId: string; snapshot: ResearchSnapshot },
): Promise<{ id: string; version: number }> {
  return withVersionRetry(tx, async (sp) => {
    const result = await sp.execute(sql`
      insert into call_research (org_id, enrollment_id, crm_record_id, version, snapshot, sources, size_chars, content_hash)
      select ${a.orgId}::uuid, ${a.enrollmentId}::uuid, ${a.crmRecordId}::uuid,
             coalesce((select max(version) from call_research where enrollment_id = ${a.enrollmentId}::uuid), 0) + 1,
             ${JSON.stringify(a.snapshot)}::jsonb, ${JSON.stringify(a.snapshot.sources)}::jsonb, ${snapshotSize(a.snapshot)}, ${snapshotHash(a.snapshot)}
      returning id, version`);
    return rows<{ id: string; version: number }>(result)[0]!;
  });
}

export interface SavePlanInput {
  orgId: string;
  enrollmentId: string;
  researchId: string;
  source: 'model' | 'edit';
  model: string | null;
  plan: CallPlan;
  dncFlagged: boolean;
  inputTokens: number;
  outputTokens: number;
  createdBy: string | null;
}

/**
 * Supersedes the current plan and inserts the next version (`proposed`). Run it inside the
 * caller's transaction: a concurrent writer makes one of the two fail on
 * `call_plans_current_unique`, and that caller sees the error.
 */
export async function savePlan(tx: Db, a: SavePlanInput): Promise<{ id: string; version: number }> {
  await tx
    .update(schema.callPlans)
    .set({ status: 'superseded' })
    .where(and(eq(schema.callPlans.enrollmentId, a.enrollmentId), inArray(schema.callPlans.status, [...CURRENT_STATUSES])));
  const result = await tx.execute(sql`
    insert into call_plans (org_id, enrollment_id, research_id, version, status, source, model, plan, dnc_flagged, input_tokens, output_tokens, created_by)
    select ${a.orgId}::uuid, ${a.enrollmentId}::uuid, ${a.researchId}::uuid,
           coalesce((select max(version) from call_plans where enrollment_id = ${a.enrollmentId}::uuid), 0) + 1,
           'proposed', ${a.source}, ${a.model}, ${JSON.stringify(a.plan)}::jsonb, ${a.dncFlagged}, ${a.inputTokens}, ${a.outputTokens}, ${a.createdBy}::uuid
    returning id, version`);
  return rows<{ id: string; version: number }>(result)[0]!;
}

export async function currentPlan(db: Db, enrollmentId: string): Promise<CallPlanRow | null> {
  const [row] = await db
    .select()
    .from(schema.callPlans)
    .where(and(eq(schema.callPlans.enrollmentId, enrollmentId), inArray(schema.callPlans.status, [...CURRENT_STATUSES])));
  return row ?? null;
}

/**
 * The research the current plan was made from. Research and its plan are written in one
 * transaction (call.prepare), so this is the newest research of the enrollment's current
 * life; research from before a reactivation (whose plans were superseded) is never returned.
 */
export async function latestResearch(db: Db, enrollmentId: string): Promise<CallResearchRow | null> {
  const r = schema.callResearch;
  const p = schema.callPlans;
  const [row] = await db
    .select({ research: r })
    .from(p)
    .innerJoin(r, eq(r.id, p.researchId))
    .where(and(eq(p.enrollmentId, enrollmentId), inArray(p.status, [...CURRENT_STATUSES])));
  return row?.research ?? null;
}

/** The plan model's do-not-contact flag, stored the way 1A's dnc-hold reads flags (a record_triage row). */
export async function storeDncTriage(
  tx: Db,
  a: {
    orgId: string;
    crmRecordId: string;
    notesHash: string;
    model: string;
    summary: string;
    flag: { category: DoNotContactCategory; quote: string };
    inputTokens: number;
    outputTokens: number;
    /** Defaults to the database clock; the tick passes its `now`, as triage does. */
    createdAt?: Date;
  },
): Promise<string> {
  const result = TriageResult.parse({
    summary: cutUtf16(a.summary.trim() || FALLBACK_SUMMARY, TRIAGE_SUMMARY_MAX),
    channels: [],
    timing: null,
    tags: [],
    doNotContact: a.flag,
  });
  const [row] = await tx
    .insert(schema.recordTriage)
    .values({
      orgId: a.orgId,
      crmRecordId: a.crmRecordId,
      notesHash: a.notesHash,
      model: a.model,
      result,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      ...(a.createdAt ? { createdAt: a.createdAt } : {}),
    })
    .returning({ id: schema.recordTriage.id });
  return row!.id;
}

/**
 * After a person dismisses a do-not-contact flag: the lead goes back on the board for a fresh approval.
 * `by` records who dismissed the flag of a plan the model itself flagged (`dnc_flagged`): `dnc_dismissed_by`
 * and `dnc_dismissed_at` on that plan, which the board shows (CF-7). An approved plan that goes back to
 * `proposed` loses its approval (`decided_*`) but keeps the dismissal. A pending "Research again" stays pending.
 */
export async function resetCallStageAfterDismiss(tx: Db, enrollmentId: string, by?: { userId: string; at: Date }): Promise<void> {
  // Sequence enrollments (call_stage null) are none of this function's business: nothing is written for them.
  const aiCall = await tx.execute(sql`
    select 1 from campaign_enrollments where id = ${enrollmentId}::uuid and call_stage is not null and call_stage <> 'done'`);
  if (rows<unknown>(aiCall).length === 0) return;
  await tx
    .update(schema.callPlans)
    .set({ status: 'proposed', decidedBy: null, decidedAt: null })
    .where(and(eq(schema.callPlans.enrollmentId, enrollmentId), eq(schema.callPlans.status, 'approved')));
  if (by) {
    await tx
      .update(schema.callPlans)
      .set({ dncDismissedBy: by.userId, dncDismissedAt: by.at })
      .where(and(eq(schema.callPlans.enrollmentId, enrollmentId), eq(schema.callPlans.status, 'proposed'), eq(schema.callPlans.dncFlagged, true)));
  }
  // "Research again" leaves the old plan current until the new one supersedes it, so a lead in `research` that still has a plan
  // is waiting for new research: a dismissal must not send it back to review (M-6), nor release a prepare already claimed.
  await tx.execute(sql`
    update campaign_enrollments e
    set call_stage = case
          when e.call_stage = 'research' then 'research'
          when exists (select 1 from call_plans p where p.enrollment_id = e.id and p.status = 'proposed') then 'review'
          else 'research' end,
        call_prepare_attempted_at = case
          when e.call_stage = 'research' and exists (select 1 from call_plans p where p.enrollment_id = e.id and p.status in ('proposed', 'approved')) then e.call_prepare_attempted_at
          else null end,
        updated_at = now()
    where e.id = ${enrollmentId}::uuid and e.call_stage is not null and e.call_stage <> 'done'`);
}

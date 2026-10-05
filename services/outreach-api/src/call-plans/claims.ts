/**
 * Claims for the `call.prepare` tick: AI call campaign leads waiting in `research`.
 * The claim sets `call_prepare_attempted_at = now`; that value is the claim's token, so a
 * write at the end of the work can check the claim still stands (call-plans/prepare.ts).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';

export const PREPARE_PER_ORG_CAP = 3;
export const PREPARE_BACKOFF_MS = 30 * 60_000;

export interface DuePrep {
  enrollmentId: string;
  orgId: string;
  campaignId: string;
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
}

/**
 * Fair per-tenant claim of enrollments waiting for research (same shape as triage's
 * claimDueRecords): ranked per tenant, oldest enrollment first, then locked with
 * FOR UPDATE SKIP LOCKED in a second step that re-checks the due condition, so two ticks
 * never take the same lead.
 */
export async function claimDuePreparations(db: Db, now: Date, batch: number): Promise<DuePrep[]> {
  const nowIso = now.toISOString();
  const stale = new Date(now.getTime() - PREPARE_BACKOFF_MS).toISOString();
  const result = await db.execute(sql`
    WITH ranked AS (
      SELECT e.id, ROW_NUMBER() OVER (PARTITION BY e.org_id ORDER BY e.enrolled_at, e.id) AS rn
      FROM campaign_enrollments e JOIN campaigns c ON c.id = e.campaign_id AND c.org_id = e.org_id
      WHERE e.status = 'active' AND e.call_stage = 'research'
        AND c.mode = 'ai_call' AND c.status IN ('dry_run', 'active')
        AND (e.call_prepare_attempted_at IS NULL OR e.call_prepare_attempted_at < ${stale}::timestamptz)
    ), picked AS (
      SELECT id FROM ranked WHERE rn <= ${PREPARE_PER_ORG_CAP} ORDER BY rn, id LIMIT ${batch}
    ), locked AS (
      SELECT e.id FROM campaign_enrollments e
      WHERE e.id IN (SELECT id FROM picked) AND e.status = 'active' AND e.call_stage = 'research'
        AND (e.call_prepare_attempted_at IS NULL OR e.call_prepare_attempted_at < ${stale}::timestamptz)
      FOR UPDATE SKIP LOCKED
    )
    UPDATE campaign_enrollments e SET call_prepare_attempted_at = ${nowIso}::timestamptz
    FROM locked, crm_records r
    WHERE e.id = locked.id AND r.id = e.crm_record_id AND r.org_id = e.org_id
    RETURNING e.id AS "enrollmentId", e.org_id AS "orgId", e.campaign_id AS "campaignId", e.crm_record_id AS "crmRecordId",
              r.sf_object AS "sfObject", r.sf_record_id AS "sfRecordId"`);
  return (result as unknown as { rows: DuePrep[] }).rows;
}

/** Claims this tick never started go back immediately (only attempted ones wait out the backoff). */
export async function releasePreparations(db: Db, now: Date, enrollmentIds: readonly string[]): Promise<void> {
  if (enrollmentIds.length === 0) return;
  const e = schema.campaignEnrollments;
  await db
    .update(e)
    .set({ callPrepareAttemptedAt: null })
    .where(and(inArray(e.id, [...enrollmentIds]), eq(e.callPrepareAttemptedAt, now)));
}

/**
 * Re-enrolling a lead an admin deselected and then ticked again (AI call campaigns).
 *
 * The refresh exits an `active` enrollment whose lead left the picker (`deselected`). The
 * unique (campaign, record) index would keep that row, so ticking the lead again could never
 * enroll it. Instead the SAME enrollment row comes back: only an exit with reason
 * `deselected` is reactivated, never `left_query`, `closed`, an opt-out and so on.
 */
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { isActiveKeyConflict, selectionExists } from './enroll.js';

const DAY_MS = 86_400_000;
/** `exit_reason` of an AI call enrollment whose lead an admin deselected. */
export const DESELECTED_EXIT_REASON = 'deselected';

export interface ReenrollCandidate {
  enrollmentId: string;
  sfRecordId: string;
  /** Contact keys of the record as it is now (the old key rows are replaced). */
  keys: string[];
}

/**
 * One transaction per lead, like `enrollRecords`:
 * 1. a compare-and-swap UPDATE (still `exited` for `deselected`, and the lead is selected
 *    right now, decided by the statement itself) back to `active` at `call_stage = 'research'`;
 * 2. the plans of its earlier life are superseded, so no plan or research from before the
 *    reactivation is ever offered, approved or called (call-plans/store.ts);
 * 3. the old key rows go and the current keys are claimed. A key held by another active
 *    enrollment raises the unique violation, the transaction rolls back and the enrollment
 *    stays exited, exactly like a fresh enrollment that loses the key.
 */
export async function reenrollDeselected(
  db: Db,
  input: { campaignId: string; touchDays: number[]; now: Date; candidates: ReenrollCandidate[] },
): Promise<{ reenrolled: number; skippedInOtherCampaign: number; skippedNoKeys: number }> {
  const nextTouchAt = new Date(input.now.getTime() + (input.touchDays[0] ?? 0) * DAY_MS);
  let reenrolled = 0;
  let skippedInOtherCampaign = 0;
  let skippedNoKeys = 0;
  for (const candidate of input.candidates) {
    const keys = [...new Set(candidate.keys)].sort();
    if (keys.length === 0) {
      skippedNoKeys += 1;
      continue;
    }
    try {
      const done = await db.transaction(async (tx) => {
        const result = await tx.execute(sql`
          UPDATE campaign_enrollments
          SET status = 'active', exit_reason = NULL, call_stage = 'research', next_touch_at = ${nextTouchAt.toISOString()}::timestamptz,
              call_prepare_attempted_at = NULL, call_prepare_error = NULL, updated_at = now()
          WHERE id = ${candidate.enrollmentId}::uuid AND campaign_id = ${input.campaignId}::uuid
            AND status = 'exited' AND exit_reason = ${DESELECTED_EXIT_REASON}
            AND ${selectionExists(sql`campaign_enrollments.campaign_id`, sql`${candidate.sfRecordId}`)}
          RETURNING org_id`);
        const row = (result as unknown as { rows: Array<{ org_id: string }> }).rows[0];
        if (!row) return false;
        await tx
          .update(schema.callPlans)
          .set({ status: 'superseded' })
          .where(sql`${schema.callPlans.enrollmentId} = ${candidate.enrollmentId}::uuid AND ${schema.callPlans.status} IN ('proposed', 'approved')`);
        await tx.delete(schema.enrollmentContactKeys).where(sql`${schema.enrollmentContactKeys.enrollmentId} = ${candidate.enrollmentId}::uuid`);
        await tx
          .insert(schema.enrollmentContactKeys)
          .values(keys.map((key) => ({ enrollmentId: candidate.enrollmentId, orgId: row.org_id, key, active: true })));
        return true;
      });
      if (done) reenrolled += 1;
    } catch (err) {
      if (!isActiveKeyConflict(err)) throw err;
      skippedInOtherCampaign += 1;
    }
  }
  return { reenrolled, skippedInOtherCampaign, skippedNoKeys };
}

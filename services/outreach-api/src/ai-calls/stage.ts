/**
 * Where a lead goes when its queued call must not go ahead as planned, short of leaving the campaign.
 * Every write is a compare-and-swap on a lead still `active` at `queued`, so a lead that moved on (held,
 * exited, reactivated at `research`) is never pulled back.
 *
 *  - parkPlan (CF-12): the plan can't be used: cti-api refused its text (`plan_rejected`), or the approver
 *    can't place AI calls (`unknown_user`). The approval is withdrawn and the lead waits on the board with
 *    the reason; nothing retries until a person approves a plan again.
 *  - backToResearch (CF-1): Salesforce has activity the research never saw. New research, then a new plan
 *    for a person to approve. The current plan stays on the card until the new one supersedes it, exactly
 *    as after "Research again".
 *  - planNoLongerApproved: the touch's plan is not the approved plan any more (an approval withdrawn, or a
 *    touch left from before a reactivation, CF-3). The touch is skipped; a lead still at `queued` goes back
 *    to review when a proposed plan waits, to research when there is no plan at all, and stays put when
 *    another approved plan carries its own touch.
 *  - skipNotClaimable (M-1): the claim keeps refusing the touch although its plan is still approved: the lead is no longer
 *    at `queued` (held and dismissed, then approved again: the old touch would block the release forever), or something
 *    else stopped the claim for NOT_CLAIMABLE_MAX_DEFERRALS refusals in a row. The touch is skipped; a lead still at `queued`
 *    with no other open touch goes back to `approved`, so "Call all approved" can make a fresh touch once it is callable.
 *
 * planNoLongerApproved and skipNotClaimable first ask what cti-api did with a key the touch kept (key-resolution.ts, round
 * 2): a placed call is linked instead of skipped (a fresh touch would call the person again), and a request cti-api may
 * still be handling leaves the touch and its key alone (`pending`). Only then is the touch skipped.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { settleKeptKey } from './key-resolution.js';
import type { ParkReason } from './pacing-rules.js';
import { NOT_CLAIMABLE_REASON, skipTouch } from './touches.js';

export const PARK_WORDS: Readonly<Record<ParkReason, string>> = {
  plan_rejected: "The voice agent refused this plan's text. Edit the plan, then approve it again.",
  unknown_user: 'The approver cannot place AI calls (no CTI user). Someone who can must approve the plan again.',
};
export const BACK_TO_RESEARCH_WORDS = 'New activity in Salesforce since the research: researching again before any call.';
export const NEW_ACTIVITY_SKIP_REASON = 'new_salesforce_activity';
export const PLAN_NOT_APPROVED_SKIP_REASON = 'plan_not_approved';

const queuedLead = (enrollmentId: string) => {
  const e = schema.campaignEnrollments;
  return and(eq(e.id, enrollmentId), eq(e.status, 'active'), eq(e.callStage, 'queued'));
};

export async function parkPlan(db: Db, t: { touchId: string; enrollmentId: string; planId: string | null }, reason: ParkReason, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.touches)
      .set({ status: 'failed', lastBlockReason: reason, triggerKey: null, updatedAt: now })
      .where(and(eq(schema.touches.id, t.touchId), inArray(schema.touches.status, ['planned', 'dialing'])));
    const back = await tx
      .update(schema.campaignEnrollments)
      .set({ callStage: 'review', callPrepareError: PARK_WORDS[reason], updatedAt: now })
      .where(queuedLead(t.enrollmentId))
      .returning({ id: schema.campaignEnrollments.id });
    if (back.length === 0 || !t.planId) return;
    await tx
      .update(schema.callPlans)
      .set({ status: 'proposed', decidedBy: null, decidedAt: null })
      .where(and(eq(schema.callPlans.id, t.planId), eq(schema.callPlans.enrollmentId, t.enrollmentId), eq(schema.callPlans.status, 'approved')));
  });
}

export async function backToResearch(db: Db, t: { touchId: string; enrollmentId: string }, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await skipTouch(tx as unknown as Db, t.touchId, NEW_ACTIVITY_SKIP_REASON, now))) return;
    await tx
      .update(schema.campaignEnrollments)
      .set({ callStage: 'research', callPrepareAttemptedAt: null, callPrepareError: BACK_TO_RESEARCH_WORDS, callPrepareFailures: 0, updatedAt: now })
      .where(queuedLead(t.enrollmentId));
  });
}

/**
 * What a skip did to the touch: `skipped`; `placed` (its kept key had placed a call, now linked: not skipped); `pending`
 * (cti-api may still be handling its kept key until `until`: left alone, key kept); `unchanged` (no longer planned).
 */
export type SkipOutcome = { kind: 'skipped' } | { kind: 'placed' } | { kind: 'pending'; until: Date } | { kind: 'unchanged' };

/** Skips a planned touch unless its kept key says otherwise (see SkipOutcome). Run inside the caller's transaction. */
async function skipUnlessKeyPlaced(tx: Db, touchId: string, reason: string, now: Date): Promise<SkipOutcome> {
  const kept = await settleKeptKey(tx, touchId, now);
  if (kept.kind === 'pending') return { kind: 'pending', until: kept.until };
  if (kept.kind === 'placed') return { kind: 'placed' };
  return (await skipTouch(tx, touchId, reason, now)) ? { kind: 'skipped' } : { kind: 'unchanged' };
}

export async function planNoLongerApproved(db: Db, t: { touchId: string; enrollmentId: string }, now: Date): Promise<SkipOutcome> {
  return db.transaction(async (tx) => {
    const out = await skipUnlessKeyPlaced(tx as unknown as Db, t.touchId, PLAN_NOT_APPROVED_SKIP_REASON, now);
    // A linked call leaves the lead with no approved plan just the same: it goes back to review or research as after a skip.
    if (out.kind !== 'skipped' && out.kind !== 'placed') return out;
    await tx.execute(sql`
      update campaign_enrollments e
      set call_stage = case
            when exists (select 1 from call_plans p where p.enrollment_id = e.id and p.status = 'proposed') then 'review'
            else 'research' end,
          updated_at = ${now.toISOString()}::timestamptz
      where e.id = ${t.enrollmentId}::uuid and e.status = 'active' and e.call_stage = 'queued'
        and not exists (select 1 from call_plans p where p.enrollment_id = e.id and p.status = 'approved')`);
    return out;
  });
}

export async function skipNotClaimable(db: Db, t: { touchId: string; enrollmentId: string }, now: Date): Promise<SkipOutcome> {
  return db.transaction(async (tx) => {
    const out = await skipUnlessKeyPlaced(tx as unknown as Db, t.touchId, NOT_CLAIMABLE_REASON, now);
    // A linked call keeps the lead at `queued` (put back there if it was `approved`): the results tick takes it from here.
    if (out.kind !== 'skipped') return out;
    await tx.execute(sql`
      update campaign_enrollments e
      set call_stage = 'approved', updated_at = ${now.toISOString()}::timestamptz
      where e.id = ${t.enrollmentId}::uuid and e.status = 'active' and e.call_stage = 'queued'
        and exists (select 1 from call_plans p where p.enrollment_id = e.id and p.status = 'approved')
        and not exists (
          select 1 from touches x where x.enrollment_id = e.id and x.channel = 'ai_call' and x.status in ('planned', 'held', 'queued', 'dialing'))`);
    return out;
  });
}

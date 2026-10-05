/**
 * A person's decisions on a call plan. Every one is a compare-and-swap inside a transaction
 * that locks the enrollment row, so two people (or a person and a tick) never both win.
 * "Call all approved" lives in release.ts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { SellingSignal, type ApproveCallPlanRequest, type EditCallPlanRequest } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { pendingDncFlag } from '../campaigns/dnc-hold.js';
import { exitEnrollment } from '../campaigns/enroll.js';
import { mayDecide } from '../tenancy/record-owner.js';
import type { RequestContext } from '../tenancy/scope.js';
import { RECORD_BLOCK_COLUMNS, recordIsBlocked, type BlockableRecord } from './record-block.js';
import { currentPlan, savePlan, type CallPlanRow } from './store.js';

export const PLAN_REJECTED_EXIT_REASON = 'plan_rejected';

export type DecisionCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'PLAN_CHANGED'
  | 'NOT_IN_REVIEW'
  | 'NO_AI_CONSENT'
  | 'CONSENT_UNKNOWN'
  | 'DNC_PENDING'
  | 'DNC_NOT_DISMISSED'
  | 'RECORD_BLOCKED'
  | 'CAMPAIGN_NOT_ACTIVE'
  | 'NOT_AI_CALL_CAMPAIGN';

const STATUS: Readonly<Record<DecisionCode, 403 | 404 | 409>> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  PLAN_CHANGED: 409,
  NOT_IN_REVIEW: 409,
  NO_AI_CONSENT: 409,
  CONSENT_UNKNOWN: 409,
  DNC_PENDING: 409,
  DNC_NOT_DISMISSED: 409,
  RECORD_BLOCKED: 409,
  CAMPAIGN_NOT_ACTIVE: 409,
  NOT_AI_CALL_CAMPAIGN: 409,
};

export const DECISION_WORDS: Readonly<Record<DecisionCode, string>> = {
  NOT_FOUND: 'That lead is not in this workspace.',
  FORBIDDEN: 'Only the record owner in Salesforce or an admin can decide on this plan.',
  PLAN_CHANGED: 'The plan changed since you opened it. Reload and look again.',
  NOT_IN_REVIEW: 'This lead is not waiting for a decision any more.',
  NO_AI_CONSENT: "Can't call: no AI consent in Salesforce.",
  CONSENT_UNKNOWN: "Can't approve: consent could not be read — research again.",
  DNC_PENDING: 'A do-not-contact flag on this person is waiting in Needs Review.',
  DNC_NOT_DISMISSED: "Can't approve: the research flagged this person do-not-contact and nobody has dismissed the flag.",
  RECORD_BLOCKED: "Can't approve: the call would be refused as things stand. Check the warnings on the card.",
  CAMPAIGN_NOT_ACTIVE: 'Calls start only from an active campaign. Activate it first.',
  NOT_AI_CALL_CAMPAIGN: 'This campaign does not place AI calls.',
};

export class DecisionError extends Error {
  readonly status: 403 | 404 | 409;
  constructor(readonly code: DecisionCode) {
    super(DECISION_WORDS[code]);
    this.status = STATUS[code];
    this.name = 'DecisionError';
  }
}

interface Locked extends BlockableRecord {
  id: string;
  status: string;
  callStage: string | null;
  crmRecordId: string;
  ownerSfUserId: string | null;
}

/** Locks the enrollment (FOR UPDATE) and checks the viewer may decide on it. */
async function lockForDecision(tx: Db, ctx: RequestContext, enrollmentId: string): Promise<Locked> {
  const result = await tx.execute(sql`
    select e.id, e.status, e.call_stage as "callStage", e.crm_record_id as "crmRecordId", r.owner_sf_user_id as "ownerSfUserId",
           ${RECORD_BLOCK_COLUMNS}
    from campaign_enrollments e join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    where e.id = ${enrollmentId}::uuid and e.org_id = ${ctx.orgId}::uuid and e.call_stage is not null
    for update of e`);
  const row = (result as unknown as { rows: Locked[] }).rows[0];
  if (!row) throw new DecisionError('NOT_FOUND');
  if (!(await mayDecide(tx, ctx, row.ownerSfUserId))) throw new DecisionError('FORBIDDEN');
  return row;
}

/** A held enrollment (a do-not-contact flag, CF-10) is refused with its own code; anything else out of stage is NOT_IN_REVIEW. */
function inStage(row: Locked, stages: readonly string[]): void {
  if (row.status === 'needs_review') throw new DecisionError('DNC_PENDING');
  if (row.status !== 'active' || !row.callStage || !stages.includes(row.callStage)) throw new DecisionError('NOT_IN_REVIEW');
}

const setStage = (tx: Db, id: string, callStage: 'research' | 'review' | 'approved' | 'done', now: Date) =>
  tx.update(schema.campaignEnrollments).set({ callStage, updatedAt: now }).where(eq(schema.campaignEnrollments.id, id));

/** The consent the plan's OWN research read (CF-6): only an explicit 'yes' is consent (CF-5). */
async function planConsent(tx: Db, plan: CallPlanRow): Promise<unknown> {
  const [research] = await tx.select({ snapshot: schema.callResearch.snapshot }).from(schema.callResearch).where(eq(schema.callResearch.id, plan.researchId));
  return (research?.snapshot as { consent?: unknown } | null)?.consent;
}

function requireConsent(consent: unknown): void {
  if (consent === 'yes') return;
  throw new DecisionError(consent === 'no' || consent === 'field_missing' ? 'NO_AI_CONSENT' : 'CONSENT_UNKNOWN');
}

export async function editPlan(db: Db, ctx: RequestContext, enrollmentId: string, req: EditCallPlanRequest, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockForDecision(tx, ctx, enrollmentId);
    inStage(row, ['review', 'approved']);
    const plan = await currentPlan(tx, enrollmentId);
    if (!plan || plan.version !== req.version) throw new DecisionError('PLAN_CHANGED');
    // A person's edit is a new version of the same research. It keeps the plan's do-not-contact history (CF-7):
    // the board keeps saying the flag was raised and dismissed, and a flag nobody dismissed still blocks approval.
    // The signals, their evidence and sources are the research's, never the client's: an edit carries them over untouched (M-3).
    const sellingSignals = z.array(SellingSignal).max(8).catch([]).parse((plan.plan as { sellingSignals?: unknown } | null)?.sellingSignals);
    const saved = await savePlan(tx, {
      orgId: ctx.orgId,
      enrollmentId,
      researchId: plan.researchId,
      source: 'edit',
      model: null,
      plan: { ...req.plan, sellingSignals, doNotContact: null },
      dncFlagged: plan.dncFlagged,
      inputTokens: 0,
      outputTokens: 0,
      createdBy: ctx.session.userId,
    });
    if (plan.dncFlagged && plan.dncDismissedAt) {
      await tx
        .update(schema.callPlans)
        .set({ dncDismissedBy: plan.dncDismissedBy, dncDismissedAt: plan.dncDismissedAt })
        .where(eq(schema.callPlans.id, saved.id));
    }
    await setStage(tx, enrollmentId, 'review', now);
  });
}

export async function approvePlan(db: Db, ctx: RequestContext, enrollmentId: string, req: ApproveCallPlanRequest, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockForDecision(tx, ctx, enrollmentId);
    inStage(row, ['review']);
    const plan = await currentPlan(tx, enrollmentId);
    if (!plan || plan.version !== req.version || plan.status !== 'proposed') throw new DecisionError('PLAN_CHANGED');
    const consent = await planConsent(tx, plan);
    requireConsent(consent);
    // A flag nobody dismissed holds the person; a plan the model flagged goes ahead only once a person dismissed THAT flag,
    // which the plan's own columns record (CF-7, CF-10). A dismissal of some other flag on the record is not it.
    if (await pendingDncFlag(tx, row.crmRecordId)) throw new DecisionError('DNC_PENDING');
    if (plan.dncFlagged && !plan.dncDismissedAt) throw new DecisionError('DNC_NOT_DISMISSED');
    // The board shows these as blocking warnings; the same rule stops an approval nobody could act on (M-7).
    if (await recordIsBlocked(tx, ctx.orgId, row, 'yes', now)) throw new DecisionError('RECORD_BLOCKED');
    await tx.update(schema.callPlans).set({ status: 'approved', decidedBy: ctx.session.userId, decidedAt: now }).where(eq(schema.callPlans.id, plan.id));
    await setStage(tx, enrollmentId, 'approved', now);
  });
}

export async function rejectPlan(db: Db, ctx: RequestContext, enrollmentId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockForDecision(tx, ctx, enrollmentId);
    inStage(row, ['research', 'review', 'approved']);
    await tx
      .update(schema.callPlans)
      .set({ status: 'rejected', decidedBy: ctx.session.userId, decidedAt: now })
      .where(and(eq(schema.callPlans.enrollmentId, enrollmentId), inArray(schema.callPlans.status, ['proposed', 'approved'])));
    await setStage(tx, enrollmentId, 'done', now);
    await exitEnrollment(tx, enrollmentId, { from: ['active'], reason: PLAN_REJECTED_EXIT_REASON });
  });
}

export async function researchAgain(db: Db, ctx: RequestContext, enrollmentId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await lockForDecision(tx, ctx, enrollmentId);
    inStage(row, ['research', 'review', 'approved']);
    await tx
      .update(schema.campaignEnrollments)
      .set({ callStage: 'research', callPrepareAttemptedAt: null, callPrepareError: null, callPrepareFailures: 0, updatedAt: now })
      .where(eq(schema.campaignEnrollments.id, enrollmentId));
  });
}

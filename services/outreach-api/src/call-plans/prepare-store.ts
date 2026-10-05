/**
 * What `call.prepare` writes for one lead, every write guarded by the tick's claim
 * (`call_prepare_attempted_at = now`): a lead that moved on since the claim (pressed "Research
 * again", reactivated, exited, held) is never touched, and a result for it is discarded whole.
 */
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DoNotContactCategory } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { CallPlanResult } from '../ai/call-plan-model.js';
import { holdForReview } from '../campaigns/dnc-hold.js';
import { snapshotHash, type ResearchSnapshot } from '../research/snapshot.js';
import { cutUtf16, wellFormed, wellFormedDeep } from '../research/text.js';
import { MAX_PREPARE_FAILURES, type DuePrep } from './claims.js';
import { savePlan, saveResearch, storeDncTriage } from './store.js';

export const ERR_RECORD_GONE = 'The Salesforce record was not found or the integration user cannot see it.';
export const ERR_PLAN_INVALID = "The AI's plan did not pass checks; it will try again.";
export const ERR_PLAN_PARKED = 'Could not draft a plan — research again';
export const ERR_PREPARE_FAILED = 'Research or planning failed; it will try again.';

const QUOTE_MAX = 300;

/** The claim no longer stands (or the lead moved on): the result is discarded. */
export class StaleStageError extends Error {}

/** This tick's claim on the enrollment still stands. */
export function claimed(p: DuePrep, now: Date) {
  const e = schema.campaignEnrollments;
  return and(eq(e.id, p.enrollmentId), eq(e.callPrepareAttemptedAt, now));
}

/** The error shows on the card; written only while the claim stands, so a lead that moved on keeps a clean card. */
export async function setError(db: Db, p: DuePrep, now: Date, message: string): Promise<void> {
  await db.update(schema.campaignEnrollments).set({ callPrepareError: message, updatedAt: now }).where(claimed(p, now));
}

/**
 * The model answered with a plan that failed validation: count it. At `MAX_PREPARE_FAILURES` in a row the
 * lead is parked: the claim query skips it until "Research again" resets the count, and the card says so.
 */
export async function recordPlanFailure(db: Db, p: DuePrep, now: Date): Promise<void> {
  const e = schema.campaignEnrollments;
  await db
    .update(e)
    .set({
      callPrepareFailures: sql`${e.callPrepareFailures} + 1`,
      callPrepareError: sql`case when ${e.callPrepareFailures} + 1 >= ${MAX_PREPARE_FAILURES} then ${ERR_PLAN_PARKED} else ${ERR_PLAN_INVALID} end`,
      updatedAt: now,
    })
    .where(claimed(p, now));
}

/** Research, plan and stage move in one transaction; a do-not-contact flag also holds the person. Returns true when held. */
export async function storePrepared(db: Db, p: DuePrep, now: Date, snapshot: ResearchSnapshot, raw: CallPlanResult): Promise<boolean> {
  // B2: the model can answer a lone surrogate, which JSON.stringify writes as an escape jsonb refuses; that would fail the
  // store and repeat a paid call. Every plan string is made well-formed first (U+FFFD; the board then shows the issue).
  const out = { ...raw, plan: wellFormedDeep(raw.plan) };
  return db.transaction(async (tx) => {
    const research = await saveResearch(tx, { orgId: p.orgId, enrollmentId: p.enrollmentId, crmRecordId: p.crmRecordId, snapshot });
    const flag = out.plan.doNotContact;
    await savePlan(tx, {
      orgId: p.orgId,
      enrollmentId: p.enrollmentId,
      researchId: research.id,
      source: 'model',
      model: out.model,
      plan: out.plan,
      dncFlagged: flag !== null,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      createdBy: null,
    });
    const e = schema.campaignEnrollments;
    const moved = await tx
      .update(e)
      .set({ callStage: 'review', callPrepareError: null, callPrepareFailures: 0, updatedAt: now })
      .where(and(claimed(p, now), eq(e.status, 'active'), eq(e.callStage, 'research')))
      .returning({ id: e.id });
    if (moved.length === 0) throw new StaleStageError();
    if (!flag) return false;
    await holdWithTriage(tx, p, now, snapshot, out, flag, out.plan.situationSummary);
    return true;
  });
}

async function holdWithTriage(
  tx: Db,
  p: DuePrep,
  now: Date,
  snapshot: ResearchSnapshot,
  out: { model: string; inputTokens: number; outputTokens: number },
  flag: { category: DoNotContactCategory; quote: string },
  summary: string,
): Promise<void> {
  const triageId = await storeDncTriage(tx, {
    orgId: p.orgId,
    crmRecordId: p.crmRecordId,
    notesHash: snapshotHash(snapshot),
    model: out.model,
    summary,
    flag,
    inputTokens: out.inputTokens,
    outputTokens: out.outputTokens,
    createdAt: now,
  });
  await holdForReview(tx, { enrollmentId: p.enrollmentId }, { triageId, category: flag.category, quote: flag.quote }, now);
}

const SalvagedFlag = z.object({ category: DoNotContactCategory, quote: z.string() });

/**
 * A `doNotContact` from a plan that failed validation, when it is a usable flag on its own: a known
 * category and a non-empty quote (cut to 300 without splitting a surrogate pair). Null otherwise.
 */
export function salvageFlag(raw: unknown): { category: DoNotContactCategory; quote: string } | null {
  const parsed = SalvagedFlag.safeParse(raw);
  if (!parsed.success) return null;
  const quote = cutUtf16(wellFormed(parsed.data.quote).trim(), QUOTE_MAX).trim();
  return quote ? { category: parsed.data.category, quote } : null;
}

/**
 * The plan was unusable but carried a do-not-contact flag: hold the person for a human anyway
 * (no research or plan is stored). The claim is checked in the same transaction as the triage row.
 */
export async function storeSalvagedFlag(
  db: Db,
  p: DuePrep,
  now: Date,
  snapshot: ResearchSnapshot,
  usage: { model: string; inputTokens: number; outputTokens: number },
  flag: { category: DoNotContactCategory; quote: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const e = schema.campaignEnrollments;
    // B3: the hold replaces whatever the card said before (an earlier failed plan's error).
    const still = await tx
      .update(e)
      .set({ callPrepareError: null, updatedAt: now })
      .where(and(claimed(p, now), eq(e.status, 'active'), eq(e.callStage, 'research')))
      .returning({ id: e.id });
    if (still.length === 0) throw new StaleStageError();
    await holdWithTriage(tx, p, now, snapshot, usage, flag, '');
  });
}

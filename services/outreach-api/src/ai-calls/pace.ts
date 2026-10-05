/**
 * `ai_call.place`: triggers approved AI calls in cti-api, inside calling hours, a few at a
 * time per tenant. The engine gates every call; this tick only paces them and applies the
 * answer (decision 10). Per-touch work lives in placeOne; what the tick reads first lives in
 * pace-context.ts.
 *
 * One touch, in order: a pending do-not-contact flag holds the person; the fresh Salesforce
 * read (Do Not Call, Skip on Dialer, the record gone) can end the enrollment; the touch's plan
 * must still be the approved plan and pass the voice agent's text check; outside the window
 * the touch waits (nothing claimed); new Salesforce activity since the research sends the lead
 * back to research (CF-1); then the claim (CF-2, CF-10, CF-11), the trigger, and the answer.
 */
import type { Db } from '@cti/db';
import { holdIfFlagged } from '../campaigns/dnc-hold.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { CtiClient } from './cti-client.js';
import { decideTrigger, windowCheck, type TriggerDecision } from './pacing-rules.js';
import { loadOrgTick, type OrgTick, type PlanForCall } from './pace-context.js';
import { renderPlanForAgent } from './plan-text.js';
import { backToResearch, parkPlan, planNoLongerApproved } from './stage.js';
import { claimAiTouch, deferTouch, finishAiEnrollment, orgsWithDueAiCalls, reapStaleDialing, settleTouch, type AiTouchCandidate } from './touches.js';

export const PLACE_DEADLINE_MS = 50_000;
/** A touch the claim refused (it changed under us): look again later rather than every minute. */
export const NOT_CLAIMABLE_DEFER_MS = 15 * 60_000;

export interface PaceDeps {
  db: Db;
  clients: SalesforceClientFactory;
  cti: CtiClient;
  now: Date;
  log: RunnerLogger;
  /** Wall clock in ms for the tick deadline; tests inject one. Defaults to `Date.now`. */
  clock?: () => number;
}

export interface PaceCounts {
  placed: number;
  retried: number;
  failed: number;
  deferred: number;
  held: number;
  /** Back on the board: the plan was refused or its approver can't call (CF-12), or it is no longer approved. */
  parked: number;
  /** Back to research: Salesforce activity the plan never saw (CF-1). */
  researched: number;
}

type Result = keyof PaceCounts;

export async function placeDueAiCalls(deps: PaceDeps): Promise<PaceCounts> {
  const counts: PaceCounts = { placed: 0, retried: 0, failed: 0, deferred: 0, held: 0, parked: 0, researched: 0 };
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + PLACE_DEADLINE_MS;
  const reaped = await reapStaleDialing(deps.db, deps.now);
  if (reaped > 0) deps.log.warn({ reaped }, 'ai_call.place: dialing touches with no answer went back to planned');
  for (const orgId of await orgsWithDueAiCalls(deps.db, deps.now)) {
    if (clock() > deadline) break;
    await placeForOrg(deps, orgId, counts, () => clock() <= deadline);
  }
  return counts;
}

async function placeForOrg(deps: PaceDeps, orgId: string, counts: PaceCounts, inTime: () => boolean): Promise<void> {
  const tick = await loadOrgTick(deps, orgId);
  if (!tick) return;
  let slots = tick.slots;
  for (const c of tick.candidates) {
    if (slots <= 0 || !inTime()) break;
    const result = await placeOne(deps, tick, c);
    counts[result] += 1;
    if (result === 'placed') slots -= 1;
  }
}

async function placeOne(deps: PaceDeps, tick: OrgTick, c: AiTouchCandidate): Promise<Result> {
  const { db, now } = deps;
  if (await holdIfFlagged(db, { enrollmentId: c.enrollmentId, crmRecordId: c.crmRecordId, now })) return 'held';
  const fresh = tick.fresh(c.sfRecordId);
  if (!fresh) return finish(deps, c, 'record_not_found');
  if (fresh.sfDoNotCall) return finish(deps, c, 'sf_do_not_call');
  if (fresh.skipOnDialer) return finish(deps, c, 'skip_on_dialer');
  const plan: PlanForCall | null = c.callPlanId ? (tick.plans.get(c.callPlanId) ?? null) : null;
  if (!plan || plan.status !== 'approved' || plan.enrollmentId !== c.enrollmentId || !plan.plan) {
    await planNoLongerApproved(db, c, now);
    return 'parked';
  }
  const rendered = renderPlanForAgent(plan.plan);
  if (!rendered.ok) {
    deps.log.warn({ orgId: c.orgId, touchId: c.touchId, issues: rendered.issues }, 'ai_call.place: the plan fails the voice agent text check');
    await parkPlan(db, { touchId: c.touchId, enrollmentId: c.enrollmentId, planId: plan.id }, 'plan_rejected', now);
    return 'parked';
  }
  const to = fresh.phones[0]?.e164 ?? c.phones[0]?.e164 ?? null;
  const window = windowCheck(to, now, c.firstAiTouch && c.attempts === 0 ? plan.plan.bestTimeToCall.window : 'any');
  if (!window.ok) {
    await deferTouch(db, c.touchId, window.at, 'outside_window');
    return 'deferred';
  }
  if (tick.newActivity.has(c.sfRecordId)) {
    await backToResearch(db, c, now);
    return 'researched';
  }
  if (!c.requestedBy) {
    await parkPlan(db, { touchId: c.touchId, enrollmentId: c.enrollmentId, planId: plan.id }, 'unknown_user', now);
    return 'parked';
  }
  const claim = await claimAiTouch(db, c.touchId, now);
  if (!claim) {
    await deferTouch(db, c.touchId, new Date(now.getTime() + NOT_CLAIMABLE_DEFER_MS), 'not_claimable');
    return 'deferred';
  }
  const outcome = await deps.cti.trigger({
    orgId: c.orgId,
    userId: c.requestedBy,
    idempotencyKey: claim.triggerKey,
    target: { kind: 'record', objectType: c.sfObject, recordId: c.sfRecordId, planText: rendered.text },
  });
  const decision = decideTrigger(outcome, claim.attempts, to, now);
  // Never the plan text or a phone number.
  deps.log.info({ orgId: c.orgId, touchId: c.touchId, attempt: claim.attempts, result: resultWords(decision) }, 'ai_call.place: trigger answered');
  return apply(deps, c, plan.id, decision);
}

const resultWords = (d: TriggerDecision): string => (d.kind === 'placed' ? 'placed' : `${d.kind}:${d.reason}`);

async function apply(deps: PaceDeps, c: AiTouchCandidate, planId: string, d: TriggerDecision): Promise<Result> {
  const { db, now } = deps;
  switch (d.kind) {
    case 'placed':
      await settleTouch(db, c.touchId, { kind: 'placed', aiCallId: d.aiCallId }, now);
      return 'placed';
    case 'retry':
      await settleTouch(db, c.touchId, { kind: 'retry', at: d.at, reason: d.reason, keepKey: d.keepKey }, now);
      return 'retried';
    case 'park':
      await parkPlan(db, { touchId: c.touchId, enrollmentId: c.enrollmentId, planId }, d.reason, now);
      return 'parked';
    case 'final':
      await settleTouch(db, c.touchId, { kind: 'failed', reason: d.reason, aiCallId: d.aiCallId }, now);
      await finishAiEnrollment(db, c.enrollmentId, `ai_call_${d.reason}`, 'exited');
      return 'failed';
  }
}

/** The fresh read says this person cannot be called: the enrollment exits and its planned touch is skipped with the reason. */
async function finish(deps: PaceDeps, c: AiTouchCandidate, reason: string): Promise<Result> {
  await finishAiEnrollment(deps.db, c.enrollmentId, `ai_call_${reason}`, 'exited');
  return 'failed';
}

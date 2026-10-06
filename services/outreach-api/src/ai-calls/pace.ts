/**
 * `ai_call.place`: triggers approved AI calls in cti-api, inside calling hours, a few at a
 * time per tenant. The engine gates every call; this tick only paces them and applies the
 * answer (decision 10). Per-touch work lives in placeOne; what the tick reads first lives in
 * pace-context.ts.
 *
 * First, once a tick, cti-api is asked whether AI calling is on at all (I-1): off or unreachable, nothing is claimed.
 * One touch, in order: a pending do-not-contact flag holds the person; the fresh Salesforce
 * read (Do Not Call, Skip on Dialer, AI call consent not checked, the record gone) can end the enrollment; the touch's plan
 * must still be the approved plan and pass the voice agent's text check; outside the window
 * the touch waits (nothing claimed); new Salesforce activity since the research sends the lead
 * back to research (CF-1); then the claim (CF-2, CF-10, CF-11), the trigger, and the answer.
 *
 * Plan 1D: every trigger carries `context.returning` (the plan has a last real contact). A touch without a kept key is
 * offered the appointment owner's free times just before the claim, and they go only with a freshly minted key: a kept key
 * is re-sent with the body it had, so no slots (CF-13).
 *
 * Round 2: a touch that kept its idempotency key may already have reached cti-api. Before anything else, and so before any
 * path could drop that key, cti-api's request store is read (key-resolution.ts): a call placed under the key is linked (the
 * touch is sent, nothing is triggered), and a request cti-api may still be handling waits, keeping its key. A 409 is resolved
 * the same way before a new key is minted.
 */
import type { Db } from '@cti/db';
import { holdIfFlagged } from '../campaigns/dnc-hold.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { CtiClient, TriggerOutcome } from './cti-client.js';
import { resolveKey, settleKeptKey } from './key-resolution.js';
import { decideTrigger, windowCheck, type TriggerDecision } from './pacing-rules.js';
import { loadOrgTick, tickOffer, type OrgTick, type PlanForCall } from './pace-context.js';
import { renderPlanForAgent } from './plan-text.js';
import { backToResearch, parkPlan, planNoLongerApproved, skipNotClaimable, type SkipOutcome } from './stage.js';
import {
  claimAiTouch,
  deferNotClaimable,
  deferTouch,
  finishAiEnrollment,
  orgsWithDueAiCalls,
  reapStaleDialing,
  refusedTouchState,
  settleTouch,
  type AiTouchCandidate,
} from './touches.js';

export const PLACE_DEADLINE_MS = 50_000;
/** A touch the claim refused (it changed under us): look again later rather than every minute. */
export const NOT_CLAIMABLE_DEFER_MS = 15 * 60_000;
/** M-1: refused this many times in a row (this many NOT_CLAIMABLE_DEFER_MS since the first), the touch is skipped instead. */
export const NOT_CLAIMABLE_MAX_DEFERRALS = 8;

export interface PaceDeps {
  db: Db;
  clients: SalesforceClientFactory;
  cti: CtiClient;
  now: Date;
  log: RunnerLogger;
  /** Wall clock in ms for the tick deadline; tests inject one. Defaults to `Date.now`. */
  clock?: () => number;
  /** Plan 1D: AI_CALL_DEFAULT_SPECIALISTS, the appointment owner list of a tenant that has saved none (required: Fix 1, M-4). */
  defaultSpecialists: readonly string[];
}

export interface PaceCounts {
  placed: number;
  retried: number;
  failed: number;
  deferred: number;
  held: number;
  /** Back on the board: the plan was refused or its approver can't call (CF-12), it is no longer approved, or the claim can never take the touch (M-1). */
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
  const orgs = await orgsWithDueAiCalls(deps.db, deps.now);
  if (orgs.length === 0 || !(await aiCallingOn(deps))) return counts;
  for (const orgId of orgs) {
    if (clock() > deadline) break;
    try {
      await placeForOrg(deps, orgId, counts, () => clock() <= deadline);
    } catch (err) {
      // A4: one tenant's failure never stops the others. Its org id and the error's name only: never plan text or a phone.
      deps.log.error({ orgId, errName: errName(err) }, 'ai_call.place: the tick failed for this tenant; the next tenant goes on');
    }
  }
  return counts;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/**
 * I-1: cti-api's own switch (AI_VOICE, OUTREACH_KILL_SWITCH, the OpenAI key) is the same for every tenant, so it is asked
 * once a tick. Off, or no answer at all: nothing is claimed this tick, so no lead uses an attempt; the touches stay due.
 */
async function aiCallingOn(deps: PaceDeps): Promise<boolean> {
  const answer = await deps.cti.availability();
  if (answer?.available) return true;
  deps.log.warn({ availability: answer ? 'off' : 'unreachable' }, 'ai_call.place: cti-api says AI calling is off, or did not answer; nothing is placed this tick');
  return false;
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

/** `touches.last_block_reason` of a touch waiting because cti-api may still be handling its kept key. */
const IN_FLIGHT_REASON = 'in_flight';

/** The tick's word for a skip that asked about a kept key first (stage.ts SkipOutcome). M-b: nothing changed is not `parked`. */
async function skipResult(deps: PaceDeps, c: AiTouchCandidate, out: SkipOutcome): Promise<Result> {
  switch (out.kind) {
    case 'skipped':
      return 'parked';
    case 'placed':
      return 'placed';
    case 'pending':
      await deferTouch(deps.db, c.touchId, out.until, IN_FLIGHT_REASON);
      return 'deferred';
    case 'unchanged':
      return 'deferred';
  }
}

/**
 * Round 2: a kept key is resolved before any path below can drop it. Placed: linked (the touch is sent). Pending: the touch
 * waits, keeping its key, until cti-api would take the request over. Otherwise (never reached cti-api, or refused) null:
 * the touch goes on, and a claim re-sends the same key, so cti-api replays a stored refusal.
 */
async function keptKeyFirst(deps: PaceDeps, c: AiTouchCandidate): Promise<Result | null> {
  if (c.triggerKey === null) return null;
  const kept = await settleKeptKey(deps.db, c.touchId, deps.now);
  if (kept.kind === 'free') return null;
  deps.log.info({ orgId: c.orgId, touchId: c.touchId, keptKey: kept.kind }, 'ai_call.place: kept key resolved in cti-api\'s request store');
  return skipResult(deps, c, kept.kind === 'placed' ? { kind: 'placed' } : kept);
}

/**
 * M-3 and round 2: a 409 means cti-api holds this key for another request body, which may have placed a call. Its request
 * store says what happened: a stored (or rebuilt) answer is applied as if the trigger had returned it; a request still in
 * flight is `in_flight` (the key is kept); only a key cti-api has no call for is dropped for a new one.
 */
async function conflictOutcome(deps: PaceDeps, c: AiTouchCandidate, key: string): Promise<{ outcome: TriggerOutcome; resolved: string }> {
  const r = await resolveKey(deps.db, { orgId: c.orgId, key, sfRecordId: c.sfRecordId }, deps.now);
  if (r.kind === 'answered') return { outcome: { kind: 'response', response: r.answer }, resolved: 'answered' };
  if (r.kind === 'pending') return { outcome: { kind: 'response', response: { result: 'failed', reason: 'in_flight', aiCallId: null } }, resolved: 'pending' };
  return { outcome: { kind: 'conflict' }, resolved: 'none' };
}

async function placeOne(deps: PaceDeps, tick: OrgTick, c: AiTouchCandidate): Promise<Result> {
  const { db, now } = deps;
  const kept = await keptKeyFirst(deps, c);
  if (kept) return kept;
  if (await holdIfFlagged(db, { enrollmentId: c.enrollmentId, crmRecordId: c.crmRecordId, now })) return 'held';
  const fresh = tick.fresh(c.sfRecordId);
  if (!fresh) return finish(deps, c, 'record_not_found');
  if (fresh.sfDoNotCall) return finish(deps, c, 'sf_do_not_call');
  if (fresh.skipOnDialer) return finish(deps, c, 'skip_on_dialer');
  // A5 (CF-5): consent read fresh from Salesforce must be exactly yes; false or unknown is no consent, and nothing is triggered.
  if (fresh.consentAiCall !== true) return finish(deps, c, 'no_consent');
  const plan: PlanForCall | null = c.callPlanId ? (tick.plans.get(c.callPlanId) ?? null) : null;
  if (!plan || plan.status !== 'approved' || plan.enrollmentId !== c.enrollmentId || !plan.plan) {
    return skipResult(deps, c, await planNoLongerApproved(db, c, now));
  }
  const rendered = renderPlanForAgent(plan.plan, now);
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
  const context = { returning: plan.plan.reengagement?.lastContact != null };
  const offer = c.triggerKey === null ? await tickOffer(deps, tick, c) : null;
  const claim = await claimAiTouch(db, c.touchId, now);
  if (!claim) return refused(deps, c);
  // CF-13: only a freshly minted key carries slots (the claim, not the candidate row, says whether the key was kept).
  const slots = offer && !claim.keptKey ? offer.slots : [];
  const answered = await deps.cti.trigger({
    orgId: c.orgId,
    userId: c.requestedBy,
    idempotencyKey: claim.triggerKey,
    target: { kind: 'record', objectType: c.sfObject, recordId: c.sfRecordId, planText: rendered.text, context, ...(slots.length ? { slots } : {}) },
  });
  const conflict = answered.kind === 'conflict' ? await conflictOutcome(deps, c, claim.triggerKey) : null;
  const outcome = conflict?.outcome ?? answered;
  const decision = decideTrigger(outcome, claim.attempts, to, now);
  // Never the plan text or a phone number. A transport failure names what went wrong (F1): "HTTP <status> [cti-api's error
  // code]", "timeout", "network" or "bad_response" (cti-client.ts builds it; the code is [a-z_] only, never body text).
  // A 409 says what cti-api's request store had under the key: answered, pending or none.
  const transport = outcome.kind === 'transport' ? { transport: outcome.error } : {};
  const conflictWords = conflict ? { conflict: conflict.resolved } : {};
  deps.log.info(
    { orgId: c.orgId, touchId: c.touchId, attempt: claim.attempts, result: resultWords(decision), ...transport, ...conflictWords },
    'ai_call.place: trigger answered',
  );
  return apply(deps, c, plan.id, decision);
}

/**
 * M-1: the claim refused a touch the tick found callable. A plan no longer approved goes as planNoLongerApproved. A lead no
 * longer at `queued` (an old touch left behind, e.g. reaped during a hold that was dismissed and the plan approved again)
 * can never be claimed: skipped, so the release can make a fresh touch. Otherwise it waits NOT_CLAIMABLE_DEFER_MS, and after
 * NOT_CLAIMABLE_MAX_DEFERRALS refusals in a row it is skipped too, never deferred forever.
 */
async function refused(deps: PaceDeps, c: AiTouchCandidate): Promise<Result> {
  const { db, now } = deps;
  const state = await refusedTouchState(db, c.touchId, now);
  if (!state) return 'deferred';
  if (!state.planApproved) return skipResult(deps, c, await planNoLongerApproved(db, c, now));
  const limit = now.getTime() - NOT_CLAIMABLE_MAX_DEFERRALS * NOT_CLAIMABLE_DEFER_MS;
  if (!state.queued || (state.refusedSince !== null && state.refusedSince.getTime() <= limit)) {
    return skipResult(deps, c, await skipNotClaimable(db, c, now));
  }
  await deferNotClaimable(db, c.touchId, new Date(now.getTime() + NOT_CLAIMABLE_DEFER_MS), now);
  return 'deferred';
}

const resultWords = (d: TriggerDecision): string => (d.kind === 'placed' ? 'placed' : `${d.kind}:${d.reason}`);

async function apply(deps: PaceDeps, c: AiTouchCandidate, planId: string, d: TriggerDecision): Promise<Result> {
  const { db, now } = deps;
  switch (d.kind) {
    case 'placed':
      await settleTouch(db, c.touchId, { kind: 'placed', aiCallId: d.aiCallId }, now);
      return 'placed';
    case 'retry':
      await settleTouch(db, c.touchId, { kind: 'retry', at: d.at, reason: d.reason, keepKey: d.keepKey, refundAttempt: d.refundAttempt }, now);
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

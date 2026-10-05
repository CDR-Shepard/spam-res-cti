/**
 * `call.prepare`: for each AI call campaign lead waiting in `research`, read the whole
 * record and its surroundings from Salesforce, ask Claude for a call plan, and store both,
 * versioned. A do-not-contact signal holds the person in Needs Review (1A dnc-hold) and no
 * plan is offered. Everything else waits on the board (`review`) for a person.
 *
 * Mirrors `triage/run.ts`: an unpriced model claims nothing; per tenant the daily AI budget
 * is checked first (a spent one pauses the tenant's campaigns, `ai_budget`); the tick stops
 * starting leads after `PREPARE_DEADLINE_MS`; claims it never started are released.
 *
 * The claim's time (`call_prepare_attempted_at = now`) is its token. The result is stored
 * only while the lead is still `active`, still in `research` and still claimed by this tick,
 * all checked by the UPDATE inside the storing transaction. "Research again" and a
 * re-enrollment clear the claim, so a plan drafted from research that started before either
 * is discarded rather than offered.
 */
import { and, eq } from 'drizzle-orm';
import { FieldMap } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { CallPlanOutputError, type CallPlanModel, type CallPlanResult } from '../ai/call-plan-model.js';
import { costMicros, isPricedModel } from '../ai/model.js';
import { holdForReview, holdIfFlagged } from '../campaigns/dnc-hold.js';
import { pauseOrgCampaigns } from '../campaigns/pause.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { DescribeCache } from '../research/describe.js';
import { researchRecord, snapshotHash, type ResearchSnapshot } from '../research/snapshot.js';
import { outreachSettings } from '../settings.js';
import { claimDuePreparations, releasePreparations, type DuePrep } from './claims.js';
import { buildCallPlanPrompt } from './prompt.js';
import { savePlan, saveResearch, storeDncTriage } from './store.js';

export const PREPARE_BATCH = 6;
export const PREPARE_DEADLINE_MS = 5 * 60_000;
export const ERR_RECORD_GONE = 'The Salesforce record was not found or the integration user cannot see it.';
export const ERR_PLAN_INVALID = "The AI's plan did not pass checks; it will try again.";
export const ERR_PREPARE_FAILED = 'Research or planning failed; it will try again.';

export interface PrepareDeps {
  db: Db;
  clients: SalesforceClientFactory;
  model: CallPlanModel;
  describes: DescribeCache;
  now: Date;
  log: RunnerLogger;
  /** Wall clock in ms for the tick deadline; tests inject one. Defaults to `Date.now`. */
  clock?: () => number;
  batch?: number;
}

export interface PrepareCounts {
  planned: number;
  held: number;
  failed: number;
}

class StaleStageError extends Error {}
type Outcome = { kind: 'planned' | 'held' | 'failed'; costMicros: number } | { kind: 'skip_org' };
interface OrgContext {
  client: SalesforceClient;
  fieldMap: FieldMap;
  companyName: string;
}
interface TickState {
  startedAt: number;
  attempted: Set<string>;
  counts: PrepareCounts;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** This tick's claim on the enrollment still stands. */
function claimed(p: DuePrep, now: Date) {
  const e = schema.campaignEnrollments;
  return and(eq(e.id, p.enrollmentId), eq(e.callPrepareAttemptedAt, now));
}

/** The error shows on the card; written only while the claim stands, so a lead that moved on keeps a clean card. */
async function setError(db: Db, p: DuePrep, now: Date, message: string): Promise<void> {
  await db.update(schema.campaignEnrollments).set({ callPrepareError: message, updatedAt: now }).where(claimed(p, now));
}

/** Research, plan and stage move in one transaction; a do-not-contact flag also holds the person. Returns true when held. */
async function storePrepared(db: Db, p: DuePrep, now: Date, snapshot: ResearchSnapshot, out: CallPlanResult): Promise<boolean> {
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
      .set({ callStage: 'review', callPrepareError: null, updatedAt: now })
      .where(and(claimed(p, now), eq(e.status, 'active'), eq(e.callStage, 'research')))
      .returning({ id: e.id });
    if (moved.length === 0) throw new StaleStageError();
    if (!flag) return false;
    const triageId = await storeDncTriage(tx, {
      orgId: p.orgId,
      crmRecordId: p.crmRecordId,
      notesHash: snapshotHash(snapshot),
      model: out.model,
      summary: out.plan.situationSummary,
      flag,
      inputTokens: out.inputTokens,
      outputTokens: out.outputTokens,
      createdAt: now,
    });
    await holdForReview(tx, { enrollmentId: p.enrollmentId }, { triageId, category: flag.category, quote: flag.quote }, now);
    return true;
  });
}

async function prepareOne(deps: PrepareDeps, org: OrgContext, p: DuePrep): Promise<Outcome> {
  const { db, now, log } = deps;
  if (await holdIfFlagged(db, { enrollmentId: p.enrollmentId, crmRecordId: p.crmRecordId, now })) return { kind: 'held', costMicros: 0 };
  let snapshot: ResearchSnapshot | null;
  try {
    snapshot = await researchRecord(
      { client: org.client, describes: deps.describes, orgId: p.orgId },
      { sfObject: p.sfObject, sfRecordId: p.sfRecordId, consentField: org.fieldMap[p.sfObject].consent, now },
    );
  } catch (err) {
    if (err instanceof SalesforceAuthError || err instanceof CrmNotConnectedError) return { kind: 'skip_org' };
    log.warn({ enrollmentId: p.enrollmentId, errName: errName(err) }, 'call.prepare: research failed');
    await setError(db, p, now, ERR_PREPARE_FAILED);
    return { kind: 'failed', costMicros: 0 };
  }
  if (!snapshot) {
    await setError(db, p, now, ERR_RECORD_GONE);
    return { kind: 'failed', costMicros: 0 };
  }
  let out: CallPlanResult;
  try {
    out = await deps.model.plan(buildCallPlanPrompt(snapshot, { companyName: org.companyName, today: now }));
  } catch (err) {
    if (err instanceof CallPlanOutputError) {
      // Paid for, but unusable: the spend counts, and the lead is tried again after the backoff.
      const cost = costMicros(err.usage.model, err.usage.inputTokens, err.usage.outputTokens);
      await addSpend(db, p.orgId, now, cost);
      log.warn({ enrollmentId: p.enrollmentId, err: err.message }, 'call.prepare: plan output rejected');
      await setError(db, p, now, ERR_PLAN_INVALID);
      return { kind: 'failed', costMicros: cost };
    }
    log.warn({ enrollmentId: p.enrollmentId, errName: errName(err) }, 'call.prepare: model call failed');
    await setError(db, p, now, ERR_PREPARE_FAILED);
    return { kind: 'failed', costMicros: 0 };
  }
  const cost = costMicros(out.model, out.inputTokens, out.outputTokens);
  // Spend first: the call is paid for even if storing the result fails or is discarded.
  await addSpend(db, p.orgId, now, cost);
  try {
    const held = await storePrepared(db, p, now, snapshot, out);
    return { kind: held ? 'held' : 'planned', costMicros: cost };
  } catch (err) {
    if (err instanceof StaleStageError) {
      log.info({ enrollmentId: p.enrollmentId }, 'call.prepare: the lead moved on while planning; result discarded');
      return { kind: 'failed', costMicros: cost };
    }
    // One lead's failed store must not abort the tick after a paid model call: the transaction rolled back, so the lead retries after the backoff.
    log.warn({ enrollmentId: p.enrollmentId, errName: errName(err) }, 'call.prepare: storing the plan failed');
    await setError(db, p, now, ERR_PREPARE_FAILED);
    return { kind: 'failed', costMicros: cost };
  }
}

async function pauseForBudget(deps: PrepareDeps, orgId: string, spent: number, budget: number): Promise<void> {
  const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget');
  deps.log.warn({ orgId, spentMicros: spent, budgetMicros: budget, paused }, 'daily AI budget spent; paused the tenant campaigns');
}

async function orgContext(deps: PrepareDeps, orgId: string, name: string): Promise<OrgContext | null> {
  try {
    const client = await deps.clients(orgId);
    const parsed = FieldMap.safeParse((await loadConnection(deps.db, orgId))?.fieldMap);
    if (!parsed.success) throw new Error('the Salesforce field map is missing or invalid');
    return { client, fieldMap: parsed.data, companyName: name };
  } catch (err) {
    // The campaign.refresh tick pauses the tenant's campaigns for a broken connection.
    deps.log.warn({ orgId, errName: errName(err) }, 'call.prepare: no usable salesforce connection; skipping tenant');
    return null;
  }
}

/** Returns false when the whole tick must stop (the deadline passed). */
async function prepareOrg(deps: PrepareDeps, tick: TickState, orgId: string, preps: DuePrep[]): Promise<boolean> {
  const { db, now, log } = deps;
  const clock = deps.clock ?? Date.now;
  const [row] = await db
    .select({ name: schema.organizations.name, settings: schema.organizations.settings })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const budget = budgetMicros(outreachSettings({ settings: row?.settings ?? {} }));
  let spent = await spentTodayMicros(db, orgId, now);
  if (spent >= budget) {
    await pauseForBudget(deps, orgId, spent, budget);
    return true;
  }
  const org = await orgContext(deps, orgId, row?.name ?? '');
  if (!org) return true;
  for (const p of preps) {
    if (clock() - tick.startedAt >= PREPARE_DEADLINE_MS) {
      log.warn({ orgId }, 'call.prepare: tick deadline reached; leaving the rest for the next tick');
      return false;
    }
    if (spent >= budget) {
      await pauseForBudget(deps, orgId, spent, budget);
      return true;
    }
    tick.attempted.add(p.enrollmentId);
    const outcome = await prepareOne(deps, org, p);
    if (outcome.kind === 'skip_org') {
      // Not this lead's fault: its claim goes back with the tenant's unstarted ones.
      tick.attempted.delete(p.enrollmentId);
      log.warn({ orgId }, 'call.prepare: salesforce connection unusable; skipping tenant');
      return true;
    }
    tick.counts[outcome.kind] += 1;
    spent += outcome.costMicros;
  }
  return true;
}

export async function prepareDueCalls(deps: PrepareDeps): Promise<PrepareCounts> {
  const tick: TickState = { startedAt: (deps.clock ?? Date.now)(), attempted: new Set(), counts: { planned: 0, held: 0, failed: 0 } };
  // Spend is priced per model; an unpriced one would pay for calls it could not record. Check before any claim.
  if (!isPricedModel(deps.model.modelId)) {
    deps.log.error({ model: deps.model.modelId }, 'call.prepare: no price configured for the plan model');
    return tick.counts;
  }
  const due = await claimDuePreparations(deps.db, deps.now, deps.batch ?? PREPARE_BATCH);
  const byOrg = new Map<string, DuePrep[]>();
  for (const p of due) byOrg.set(p.orgId, [...(byOrg.get(p.orgId) ?? []), p]);
  try {
    for (const [orgId, preps] of byOrg) {
      if (!(await prepareOrg(deps, tick, orgId, preps))) break;
    }
  } finally {
    // Runs on the way out of an error too: a failure here is logged, never allowed to replace that error.
    try {
      await releasePreparations(deps.db, deps.now, due.filter((p) => !tick.attempted.has(p.enrollmentId)).map((p) => p.enrollmentId));
    } catch (err) {
      deps.log.error({ errName: errName(err) }, 'call.prepare: releasing unstarted claims failed; they are retried after the backoff');
    }
  }
  return { ...tick.counts };
}

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
 *
 * A plan the model answers but that fails validation counts towards parking (`call_prepare_failures`):
 * after MAX_PREPARE_FAILURES in a row the lead is skipped until a person presses "Research again". A
 * do-not-contact flag in such a plan still holds the person, when it validates on its own.
 */
import { eq } from 'drizzle-orm';
import { FieldMap } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { addSpend, budgetMicros, spentTodayMicros } from '../ai/budget.js';
import { CallPlanOutputError, type CallPlanModel, type CallPlanResult } from '../ai/call-plan-model.js';
import { costMicros, isPricedModel } from '../ai/model.js';
import { holdIfFlagged } from '../campaigns/dnc-hold.js';
import { pauseOrgCampaigns } from '../campaigns/pause.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { DescribeCache } from '../research/describe.js';
import { researchRecord, type ResearchSnapshot } from '../research/snapshot.js';
import { outreachSettings } from '../settings.js';
import { claimDuePreparations, releasePreparations, type DuePrep } from './claims.js';
import { abortable } from './abortable.js';
import { buildCallPlanPrompt } from './prompt.js';
import {
  ERR_PLAN_INVALID,
  ERR_PLAN_PARKED,
  ERR_PREPARE_FAILED,
  ERR_RECORD_GONE,
  recordPlanFailure,
  salvageFlag,
  setError,
  StaleStageError,
  storePrepared,
  storeSalvagedFlag,
} from './prepare-store.js';

export { ERR_PLAN_INVALID, ERR_PLAN_PARKED, ERR_PREPARE_FAILED, ERR_RECORD_GONE };

export const PREPARE_BATCH = 6;
export const PREPARE_DEADLINE_MS = 5 * 60_000;
/**
 * One lead's research and model call together. The tick stops STARTING leads at PREPARE_DEADLINE_MS, so
 * without this a lead started just before it could run on for the model's own timeout and retries.
 */
export const LEAD_TIMEOUT_MS = 4 * 60_000;

export interface PrepareDeps {
  db: Db;
  clients: SalesforceClientFactory;
  model: CallPlanModel;
  describes: DescribeCache;
  now: Date;
  log: RunnerLogger;
  /** Wall clock in ms for the tick deadline; tests inject one. Defaults to `Date.now`. */
  clock?: () => number;
  /** The signal bounding one lead's research and model call; tests inject one. Defaults to `AbortSignal.timeout`. */
  leadSignal?: (ms: number) => AbortSignal;
  batch?: number;
}

export interface PrepareCounts {
  planned: number;
  held: number;
  failed: number;
}

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

/**
 * B4: a bookkeeping write (the spend, the failure count) that fails is logged at error level and never aborts the tick:
 * the model call it records is already paid for, and the next lead must still be planned. Names only, never the text.
 */
async function bookkeeping(deps: PrepareDeps, p: DuePrep, what: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (err) {
    deps.log.error({ orgId: p.orgId, enrollmentId: p.enrollmentId, errName: errName(err) }, `call.prepare: recording ${what} failed`);
  }
}

/**
 * Runs a store. A lead that moved on since the claim has its result discarded; any other failure fails
 * this lead only (the store's transaction rolled back, so it retries after the backoff) and the tick goes on.
 */
async function guardedStore(deps: PrepareDeps, p: DuePrep, cost: number, store: () => Promise<'planned' | 'held'>): Promise<Outcome> {
  const { db, now, log } = deps;
  try {
    return { kind: await store(), costMicros: cost };
  } catch (err) {
    if (err instanceof StaleStageError) {
      log.info({ enrollmentId: p.enrollmentId }, 'call.prepare: the lead moved on while planning; result discarded');
      return { kind: 'failed', costMicros: cost };
    }
    log.warn({ enrollmentId: p.enrollmentId, errName: errName(err) }, 'call.prepare: storing the result failed');
    await setError(db, p, now, ERR_PREPARE_FAILED);
    return { kind: 'failed', costMicros: cost };
  }
}

/** The model answered, but not with a usable plan: paid for, counted towards parking, and a do-not-contact flag is never lost with it. */
async function planRejected(deps: PrepareDeps, p: DuePrep, snapshot: ResearchSnapshot, err: CallPlanOutputError): Promise<Outcome> {
  const { db, now, log } = deps;
  const cost = costMicros(err.usage.model, err.usage.inputTokens, err.usage.outputTokens);
  await bookkeeping(deps, p, 'the AI spend', () => addSpend(db, p.orgId, now, cost));
  // Paths and codes only: never the validator's messages, which can quote what the model wrote.
  log.warn({ enrollmentId: p.enrollmentId, issues: err.issues }, 'call.prepare: plan output rejected');
  const flag = salvageFlag(err.rawDoNotContact);
  if (flag) {
    const held = await guardedStore(deps, p, cost, async () => {
      await storeSalvagedFlag(db, p, now, snapshot, err.usage, flag);
      return 'held';
    });
    // B1: the flag could not be stored (the lead moved on, or the write failed and retries after the backoff). That is
    // not the model's fault: no strike is counted, and the card keeps guardedStore's error.
    return held;
  }
  await bookkeeping(deps, p, 'the failed plan', () => recordPlanFailure(db, p, now));
  return { kind: 'failed', costMicros: cost };
}

async function prepareOne(deps: PrepareDeps, org: OrgContext, p: DuePrep): Promise<Outcome> {
  const { db, now, log } = deps;
  if (await holdIfFlagged(db, { enrollmentId: p.enrollmentId, crmRecordId: p.crmRecordId, now })) return { kind: 'held', costMicros: 0 };
  const signal = (deps.leadSignal ?? ((ms: number) => AbortSignal.timeout(ms)))(LEAD_TIMEOUT_MS);
  let snapshot: ResearchSnapshot | null;
  try {
    snapshot = await abortable(
      researchRecord(
        { client: org.client, describes: deps.describes, orgId: p.orgId },
        { sfObject: p.sfObject, sfRecordId: p.sfRecordId, consentField: org.fieldMap[p.sfObject].consent, now },
      ),
      signal,
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
    out = await deps.model.plan(buildCallPlanPrompt(snapshot, { companyName: org.companyName, today: now }), { signal });
  } catch (err) {
    if (err instanceof CallPlanOutputError) return planRejected(deps, p, snapshot, err);
    log.warn({ enrollmentId: p.enrollmentId, errName: errName(err) }, 'call.prepare: model call failed');
    await setError(db, p, now, ERR_PREPARE_FAILED);
    return { kind: 'failed', costMicros: 0 };
  }
  const cost = costMicros(out.model, out.inputTokens, out.outputTokens);
  // Spend first: the call is paid for even if storing the result fails or is discarded.
  await bookkeeping(deps, p, 'the AI spend', () => addSpend(db, p.orgId, now, cost));
  const snap = snapshot;
  return guardedStore(deps, p, cost, async () => ((await storePrepared(db, p, now, snap, out)) ? 'held' : 'planned'));
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
  // Spent is tracked locally after this read: a tenant can overshoot its budget by up to PREPARE_PER_ORG_CAP (3) plans in one tick.
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

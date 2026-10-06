/**
 * Test a record (plan 1E, spec §4.2): "how I'll approach this call" for any Lead or Opportunity, without a campaign.
 * The same research, plan writer, agent text and appointment offer a campaign call gets:
 *
 *   researchRecord → planFacts → plan model → withPlanFacts → renderPlanForAgent → practiceOffer → the row, ready
 *
 * Runs in process after POST /api/record-tests answered 202. It never throws: every failure ends the row `failed` with a
 * short code. What it never does (G-1): no enrollment, touch, call_plans, call_research or crm_records row, no hold, and no
 * Salesforce write (research and the offer are describe and SOQL reads through the tenant's integration connection).
 * Logs carry ids and codes only, never record text.
 */
import { and, eq } from 'drizzle-orm';
import { EditableCallPlan, FieldMap } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { addSpend } from '../ai/budget.js';
import { CallPlanOutputError, type CallPlanModel, type CallPlanResult } from '../ai/call-plan-model.js';
import { costMicros } from '../ai/model.js';
import { renderPlanForAgent } from '../ai-calls/plan-text.js';
import { practiceOffer } from '../ai-calls/practice.js';
import { abortable } from '../call-plans/abortable.js';
import { planFacts, withPlanFacts } from '../call-plans/plan-context.js';
import { describePlanTextIssues } from '../call-plans/plan-text-words.js';
import { LEAD_TIMEOUT_MS } from '../call-plans/prepare.js';
import { buildCallPlanPrompt } from '../call-plans/prompt.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import type { DescribeCache } from '../research/describe.js';
import { researchRecord, type ResearchSnapshot } from '../research/snapshot.js';
import { finishRecordTest, type PreviewFailure, type PreviewResult } from './store.js';

export interface PreviewDeps {
  db: Db;
  clients: SalesforceClientFactory;
  model: CallPlanModel;
  describes: DescribeCache;
  now: () => Date;
  log: RunnerLogger;
  /** AI_CALL_DEFAULT_SPECIALISTS: the appointment owner list of a tenant that has saved none. */
  defaultSpecialists: readonly string[];
  /** Bounds research and the model call; tests inject one. Defaults to AbortSignal.timeout(LEAD_TIMEOUT_MS). */
  signal?: () => AbortSignal;
}

interface Job {
  id: string;
  orgId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  companyName: string;
  settings: unknown;
}

/** A step's early end: the row fails with this. */
class PreviewStop extends Error {
  constructor(readonly failure: PreviewFailure) {
    super(failure.error);
    this.name = 'PreviewStop';
  }
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
const notConnected = (err: unknown): boolean => err instanceof CrmNotConnectedError || err instanceof SalesforceAuthError;

async function loadJob(db: Db, testId: string): Promise<Job | null> {
  const t = schema.aiRecordTests;
  const o = schema.organizations;
  const [row] = await db
    .select({ id: t.id, orgId: t.orgId, sfObject: t.sfObject, sfRecordId: t.sfRecordId, companyName: o.name, settings: o.settings })
    .from(t)
    .innerJoin(o, eq(o.id, t.orgId))
    .where(and(eq(t.id, testId), eq(t.status, 'running')));
  return row ?? null;
}

/** The tenant's integration client and field map: no connection (or a revoked one, or no field map) is not_connected; any other fault, salesforce_error. */
async function connect(deps: PreviewDeps, orgId: string): Promise<{ client: SalesforceClient; fieldMap: FieldMap }> {
  try {
    const client = await deps.clients(orgId);
    const fieldMap = FieldMap.safeParse((await loadConnection(deps.db, orgId))?.fieldMap);
    if (!fieldMap.success) throw new CrmNotConnectedError();
    return { client, fieldMap: fieldMap.data };
  } catch (err) {
    const error = notConnected(err) ? 'not_connected' : 'salesforce_error';
    deps.log.warn({ orgId, errName: errName(err), code: error }, 'record-test: no usable salesforce connection');
    throw new PreviewStop({ error });
  }
}

async function research(deps: PreviewDeps, job: Job, conn: { client: SalesforceClient; fieldMap: FieldMap }, now: Date, signal: AbortSignal): Promise<ResearchSnapshot> {
  let snapshot: ResearchSnapshot | null;
  try {
    snapshot = await abortable(
      researchRecord(
        { client: conn.client, describes: deps.describes, orgId: job.orgId },
        { sfObject: job.sfObject, sfRecordId: job.sfRecordId, consentField: conn.fieldMap[job.sfObject].consent, now },
      ),
      signal,
    );
  } catch (err) {
    const error = signal.aborted ? 'timeout' : notConnected(err) ? 'not_connected' : 'salesforce_error';
    deps.log.warn({ testId: job.id, errName: errName(err), code: error }, 'record-test: research failed');
    throw new PreviewStop({ error });
  }
  if (!snapshot) throw new PreviewStop({ error: 'not_found' });
  return snapshot;
}

/** The spend is recorded whether or not the output validates; a failed write is logged, never fails the preview. */
async function charge(deps: PreviewDeps, job: Job, now: Date, cost: number): Promise<void> {
  try {
    await addSpend(deps.db, job.orgId, now, cost);
  } catch (err) {
    deps.log.error({ testId: job.id, errName: errName(err) }, 'record-test: recording the AI spend failed');
  }
}

async function plan(deps: PreviewDeps, job: Job, snapshot: ResearchSnapshot, now: Date, signal: AbortSignal): Promise<CallPlanResult & { costMicros: number }> {
  const facts = planFacts(snapshot, now);
  let out: CallPlanResult;
  try {
    out = await deps.model.plan(buildCallPlanPrompt(snapshot, { companyName: job.companyName, today: now, facts }), { signal });
  } catch (err) {
    if (err instanceof CallPlanOutputError) {
      const cost = costMicros(err.usage.model, err.usage.inputTokens, err.usage.outputTokens);
      await charge(deps, job, now, cost);
      // Paths and codes only: never the validator's messages, which can quote what the model wrote.
      deps.log.warn({ testId: job.id, issues: err.issues }, 'record-test: plan output rejected');
      const usage = { model: err.usage.model, inputTokens: err.usage.inputTokens, outputTokens: err.usage.outputTokens, costMicros: cost };
      throw new PreviewStop({ error: 'plan_failed', usage });
    }
    const error = signal.aborted ? 'timeout' : 'plan_failed';
    deps.log.warn({ testId: job.id, errName: errName(err), code: error }, 'record-test: model call failed');
    throw new PreviewStop({ error });
  }
  const cost = costMicros(out.model, out.inputTokens, out.outputTokens);
  await charge(deps, job, now, cost);
  // 1D: the computed facts win over what the model wrote for them.
  return { ...out, plan: withPlanFacts(out.plan, facts), costMicros: cost };
}

/** The self block's Name, else FirstName LastName. */
function recordName(snapshot: ResearchSnapshot): string | null {
  const self = snapshot.records.find((b) => b.relation === 'self');
  const field = (name: string) => self?.fields.find((f) => f.name.toLowerCase() === name.toLowerCase())?.value.trim() || null;
  const parts = [field('FirstName'), field('LastName')].filter((p): p is string => p !== null);
  return field('Name') ?? (parts.length > 0 ? parts.join(' ') : null);
}

async function steps(deps: PreviewDeps, job: Job, now: Date): Promise<PreviewResult> {
  const signal = (deps.signal ?? (() => AbortSignal.timeout(LEAD_TIMEOUT_MS)))();
  const conn = await connect(deps, job.orgId);
  const snapshot = await research(deps, job, conn, now, signal);
  const planned = await plan(deps, job, snapshot, now, signal);
  const editable = EditableCallPlan.parse(planned.plan);
  const rendered = renderPlanForAgent(editable, now);
  const offerDeps = { db: deps.db, clients: deps.clients, now, log: deps.log, defaultSpecialists: deps.defaultSpecialists };
  const offer = await practiceOffer(offerDeps, job.orgId, job.settings, 'record-test.preview');
  return {
    name: recordName(snapshot),
    research: snapshot,
    plan: planned.plan,
    planText: rendered.ok ? rendered.text : null,
    planTextIssues: rendered.ok ? [] : describePlanTextIssues(editable, rendered.issues),
    slots: offer.slots,
    offerNote: offer.slots.length > 0 ? null : offer.note,
    ownerSfUserId: offer.ownerSfUserId,
    model: planned.model,
    inputTokens: planned.inputTokens,
    outputTokens: planned.outputTokens,
    costMicros: planned.costMicros,
  };
}

/** Runs one `running` preview to its end. Never throws: every failure ends the row `failed`. */
export async function runPreview(deps: PreviewDeps, testId: string): Promise<void> {
  const now = deps.now();
  let job: Job | null = null;
  try {
    job = await loadJob(deps.db, testId);
    if (!job) {
      deps.log.warn({ testId }, 'record-test: no running preview to run');
      return;
    }
    const result = await steps(deps, job, now);
    await finishRecordTest(deps.db, testId, result, deps.now());
    deps.log.info({ testId, planText: result.planText !== null, slots: result.slots.length }, 'record-test: preview ready');
  } catch (err) {
    const failure: PreviewFailure = err instanceof PreviewStop ? err.failure : { error: 'internal_error' };
    if (!(err instanceof PreviewStop)) deps.log.error({ testId, errName: errName(err) }, 'record-test: preview crashed');
    try {
      await finishRecordTest(deps.db, testId, failure, deps.now());
      if (job) deps.log.info({ testId, code: failure.error }, 'record-test: preview failed');
    } catch (finishErr) {
      // The row stays running and reads as failed: interrupted after PREVIEW_STALE_MS.
      deps.log.error({ testId, errName: errName(finishErr) }, 'record-test: recording the failure failed');
    }
  }
}

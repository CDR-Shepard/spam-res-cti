/**
 * Test a record (plan 1E, spec §4.2), admins only: start a preview of how the AI would call any Lead or Opportunity,
 * read it (the page polls while it runs), and list the tenant's latest. A preview runs in this process after the 202
 * (record-tests/preview.ts); it never creates an enrollment, touch or plan row and never writes to Salesforce.
 *
 * Part 2: run a ready preview as a practice call to one of the admin test numbers or to the admin's own browser
 * (record-tests/run.ts), relay the browser's incoming-only Voice token from cti-api (never logged, never cached), and
 * read the test's calls back with the preview.
 *
 * Task 11: "What would be written to Salesforce" for one finished test call (record-tests/dry-run.ts): reads and one
 * mapping-model call, nothing sent, stored on the call row.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreateRecordTestRequest, FieldMap, parseSalesforceRecordRef, RECORD_REF_ERROR_WORDS, RecordTestCallRequest } from '@cti/contracts';
import type { Db } from '@cti/db';
import { budgetMicros } from '../ai/budget.js';
import type { CallPlanModel } from '../ai/call-plan-model.js';
import { isPricedModel } from '../ai/model.js';
import type { BrowserTokenOutcome, CtiClient } from '../ai-calls/cti-client.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import { sendError } from '../http/errors.js';
import type { DescribeCache } from '../research/describe.js';
import { CALLS_PER_HOUR, PREVIEWS_PER_DAY, PREVIEWS_PER_HOUR, withPreviewLimit, type LimitRefusal } from '../record-tests/limits.js';
import { dryRunTestCall, type DryRunResult } from '../record-tests/dry-run.js';
import { runPreview } from '../record-tests/preview.js';
import { startRecordTestCall, type RunError } from '../record-tests/run.js';
import { insertRecordTest, listRecordTests, loadInstanceUrl, loadRecordTest, loadRecordTestCalls, toRecordTest } from '../record-tests/store.js';
import { outreachSettings } from '../settings.js';
import type { MappingModel } from '../writeback/mapping-model.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

const IdParams = z.object({ id: z.string().uuid() });
const CallParams = z.object({ callId: z.string().uuid() });

export interface RecordTestRouteDeps {
  db: Db;
  clients: SalesforceClientFactory;
  /** The signed cti-api client: running a test call (plan 1E Part 2). Null until AI calls are configured. */
  cti: CtiClient | null;
  /** The plan model; null (or unpriced) means previews are not configured. */
  model: CallPlanModel | null;
  describes: DescribeCache;
  /** The write-back's answer-mapping model, for "What would be written" (Task 11); absent or null answers 503 NO_MODEL. */
  mappingModel?: MappingModel | null;
  /** APP_PUBLIC_URL: the dry run's Chatter text links to the test page. */
  appPublicUrl?: string;
  /** AI_CALL_DEFAULT_SPECIALISTS (the offer's appointment owner list when a tenant saved none). */
  defaultSpecialists: readonly string[];
  now?: () => Date;
  /** Runs the preview after the reply; tests pass one that collects the work to await it. */
  background?: (work: () => Promise<void>) => void;
}

/** "3:42 PM PDT" in the tenant's own zone (the page shows retryAt in the viewer's). */
function tenantTime(at: Date, timeZone: string): string {
  try {
    return at.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch {
    return at.toLocaleTimeString('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  }
}

const RATE_WORDS: Readonly<Record<Extract<LimitRefusal, { code: 'RATE_LIMITED' }>['limit'], string>> = {
  previews_per_hour: `You've run ${PREVIEWS_PER_HOUR} previews in the last hour.`,
  previews_per_day: `Your team has run ${PREVIEWS_PER_DAY} previews today.`,
  calls_per_hour: `You've run ${CALLS_PER_HOUR} test calls in the last hour.`,
};

/** A limit refusal in words: 429 RATE_LIMITED (with retryAt, worded in the tenant's zone), or 409 with its code. */
export function sendLimitRefusal(reply: FastifyReply, refusal: LimitRefusal, timeZone: string): FastifyReply {
  switch (refusal.code) {
    case 'RATE_LIMITED':
      return sendError(reply, 429, 'RATE_LIMITED', `${RATE_WORDS[refusal.limit]} Try again at ${tenantTime(refusal.retryAt, timeZone)}.`, {
        retryAt: refusal.retryAt.toISOString(),
      });
    case 'PREVIEW_RUNNING':
      return sendError(reply, 409, 'PREVIEW_RUNNING', 'Your last preview is still running. Wait for it to finish.');
    case 'CALL_IN_PROGRESS':
      return sendError(reply, 409, 'CALL_IN_PROGRESS', 'Your last test call is still going. Wait for it to end.');
    case 'AI_BUDGET_SPENT':
      return sendError(reply, 409, 'AI_BUDGET_SPENT', "Today's AI budget is spent. Raise it in Settings or try again tomorrow.");
  }
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

const CTI_UNREACHABLE = 'The AI calling service did not answer. Try again in a minute.';
const NOT_CONFIGURED = 'AI calls are not set up on this server yet.';
/** The browser token route's own limiter, per address (spec §8.2). */
const TOKEN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

const RUN_ERRORS: Readonly<Record<Exclude<RunError, 'plan_text_rejected'>, [number, string, string]>> = {
  not_found: [404, 'NOT_FOUND', 'That test is not here. It may belong to another tenant.'],
  not_ready: [409, 'NOT_READY', 'That preview is not ready. Wait for it to finish, or run a new one.'],
  not_a_test_number: [400, 'NOT_A_TEST_NUMBER', 'That number is not one of the test numbers. Pick one from the list.'],
  not_your_browser: [403, 'NOT_YOUR_BROWSER', 'That browser is not registered to you. Start Talk in browser again.'],
  cti_unreachable: [502, 'CTI_UNREACHABLE', CTI_UNREACHABLE],
};

function sendRunError(reply: FastifyReply, error: RunError, words: readonly string[] = []): FastifyReply {
  if (error === 'plan_text_rejected') {
    const message = `Can't run this test: the voice agent can't be given this plan's text. ${words.join('; ')}.`;
    return sendError(reply, 409, 'PLAN_TEXT_REJECTED', message, { words });
  }
  const [status, code, message] = RUN_ERRORS[error];
  return sendError(reply, status, code, message);
}

const DRY_RUN_ERRORS: Readonly<Record<Extract<DryRunResult, { error: string }>['error'], [number, string, string]>> = {
  not_found: [404, 'NOT_FOUND', 'That test call is not here. It may belong to another tenant.'],
  not_finished: [409, 'NOT_FINISHED', 'That call is still going. Wait for it to end.'],
  no_model: [503, 'NO_MODEL', 'The answer-mapping model is not set up on this server.'],
  running: [409, 'DRY_RUN_RUNNING', 'This is already being worked out. Wait a few seconds and press again.'],
  salesforce_error: [502, 'SALESFORCE_ERROR', "Salesforce didn't answer while the record was read. Try again."],
  failed: [500, 'DRY_RUN_FAILED', "Something went wrong while working this out. Nothing was sent to Salesforce. Try again."],
};

/** cti-api's refusal of a browser token (or no answer), as an error reply. */
function sendTokenRefusal(reply: FastifyReply, answer: Exclude<BrowserTokenOutcome, { kind: 'token' }>): FastifyReply {
  if (answer.kind === 'transport') return sendError(reply, 502, 'CTI_UNREACHABLE', CTI_UNREACHABLE);
  if (answer.code === 'browser_calls_unavailable') {
    return sendError(reply, 503, 'BROWSER_CALLS_UNAVAILABLE', 'Talk in browser is not set up on the calling service. Use Ring my phone.');
  }
  if (answer.code === 'unknown_user') {
    // A super admin acting on another tenant (X-Org-Id) is an admin, just not a user cti-api knows there.
    return sendError(reply, 403, 'FORBIDDEN', "Talk in browser only works in your own tenant: the calling service doesn't know you here. Use Ring my phone.");
  }
  return sendError(reply, 403, 'FORBIDDEN', 'Only an admin can take a test call in the browser.');
}

export async function registerRecordTestRoutes(app: FastifyInstance, deps: RecordTestRouteDeps): Promise<void> {
  const { db, clients, model, describes, defaultSpecialists } = deps;
  const now = deps.now ?? (() => new Date());
  // runPreview never throws; this catch is a belt.
  const background =
    deps.background ??
    ((work: () => Promise<void>) => {
      void work().catch((err) => app.log.error({ errName: errName(err) }, 'record-test: preview crashed'));
    });

  app.post('/record-tests', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const body = CreateRecordTestRequest.safeParse(req.body ?? {});
    const ref = body.success ? parseSalesforceRecordRef(body.data.record) : ({ ok: false, error: 'no_id' } as const);
    if (!ref.ok) return sendError(reply, 400, 'INVALID_RECORD', RECORD_REF_ERROR_WORDS[ref.error], { reason: ref.error });
    if (!model || !isPricedModel(model.modelId)) return sendError(reply, 503, 'AI_CALLS_NOT_CONFIGURED', 'AI call plans are not set up on this server yet.');
    const conn = await loadConnection(db, ctx.orgId);
    if (!conn || !FieldMap.safeParse(conn.fieldMap).success) {
      return sendError(reply, 409, 'NOT_CONNECTED', 'Connect Salesforce (and save its field map) before testing a record.');
    }
    const userId = ctx.session.userId;
    const limited = await withPreviewLimit(db, { orgId: ctx.orgId, userId, now: now(), budgetMicros: budgetMicros(outreachSettings(ctx.tenant)) }, (tx) =>
      insertRecordTest(tx, { orgId: ctx.orgId, requestedBy: userId, sfObject: ref.sfObject, sfRecordId: ref.sfRecordId }),
    );
    if (!limited.ok) return sendLimitRefusal(reply, limited.refusal, ctx.tenant.timezone);
    const id = limited.value;
    req.log.info({ orgId: ctx.orgId, testId: id, sfObject: ref.sfObject }, 'record-test: preview started');
    background(() => runPreview({ db, clients, model, describes, now, log: req.log, defaultSpecialists }, id));
    return reply.code(202).send({ id });
  });

  app.get('/record-tests', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    return listRecordTests(db, ctx.orgId, now());
  });

  app.get('/record-tests/:id', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const params = IdParams.safeParse(req.params);
    const row = params.success ? await loadRecordTest(db, ctx.orgId, params.data.id, now()) : null;
    if (!row) return sendError(reply, 404, 'NOT_FOUND', 'That test is not here. It may belong to another tenant.');
    const [instanceUrl, calls] = await Promise.all([loadInstanceUrl(db, ctx.orgId), loadRecordTestCalls(db, ctx.orgId, row.id)]);
    return toRecordTest(row, calls, instanceUrl);
  });

  app.post('/record-tests/browser-token', { config: { rateLimit: TOKEN_RATE_LIMIT } }, async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    if (!deps.cti) return sendError(reply, 503, 'AI_CALLS_NOT_CONFIGURED', NOT_CONFIGURED);
    const answer = await deps.cti.browserToken({ orgId: ctx.orgId, userId: ctx.session.userId });
    req.log.info({ orgId: ctx.orgId, answer: answer.kind === 'refused' ? answer.code : answer.kind }, 'record-test: browser token');
    if (answer.kind !== 'token') return sendTokenRefusal(reply, answer);
    return reply.header('cache-control', 'no-store').send({ token: answer.token, identity: answer.identity, expiresAt: answer.expiresAt });
  });

  app.post('/record-tests/:id/calls', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const params = IdParams.safeParse(req.params);
    if (!params.success) return sendRunError(reply, 'not_found');
    const body = RecordTestCallRequest.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Pick one of the test numbers, or start Talk in browser again.');
    const cti = deps.cti;
    if (!cti) return sendError(reply, 503, 'AI_CALLS_NOT_CONFIGURED', NOT_CONFIGURED);
    const out = await startRecordTestCall({ db, clients, cti, now: now(), log: req.log, defaultSpecialists }, ctx, params.data.id, body.data);
    if ('refusal' in out) return sendLimitRefusal(reply, out.refusal, ctx.tenant.timezone);
    if (!out.ok) return sendRunError(reply, out.error, out.words);
    return { callId: out.callId, response: out.response };
  });

  app.post('/record-tests/calls/:callId/dry-run', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const params = CallParams.safeParse(req.params);
    if (!params.success) return sendError(reply, ...DRY_RUN_ERRORS.not_found);
    const dryDeps = { db, clients, model: deps.mappingModel ?? null, describes, now: now(), log: req.log, resultsBaseUrl: deps.appPublicUrl ?? '' };
    const out = await dryRunTestCall(dryDeps, ctx, params.data.callId);
    if ('refusal' in out) return sendLimitRefusal(reply, out.refusal, ctx.tenant.timezone);
    if (!out.ok) return sendError(reply, ...DRY_RUN_ERRORS[out.error]);
    return out.dryRun;
  });
}

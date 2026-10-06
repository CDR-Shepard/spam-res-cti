/**
 * Test a record (plan 1E, spec §4.2), admins only: start a preview of how the AI would call any Lead or Opportunity,
 * read it (the page polls while it runs), and list the tenant's latest. A preview runs in this process after the 202
 * (record-tests/preview.ts); it never creates an enrollment, touch or plan row and never writes to Salesforce.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreateRecordTestRequest, FieldMap, parseSalesforceRecordRef, RECORD_REF_ERROR_WORDS } from '@cti/contracts';
import type { Db } from '@cti/db';
import { budgetMicros } from '../ai/budget.js';
import type { CallPlanModel } from '../ai/call-plan-model.js';
import { isPricedModel } from '../ai/model.js';
import type { CtiClient } from '../ai-calls/cti-client.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import { sendError } from '../http/errors.js';
import type { DescribeCache } from '../research/describe.js';
import { CALLS_PER_HOUR, PREVIEWS_PER_DAY, PREVIEWS_PER_HOUR, withPreviewLimit, type LimitRefusal } from '../record-tests/limits.js';
import { runPreview } from '../record-tests/preview.js';
import { insertRecordTest, listRecordTests, loadRecordTest, toRecordTest } from '../record-tests/store.js';
import { outreachSettings } from '../settings.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

const IdParams = z.object({ id: z.string().uuid() });

export interface RecordTestRouteDeps {
  db: Db;
  clients: SalesforceClientFactory;
  /** The signed cti-api client: running a test call (plan 1E Part 2). Null until AI calls are configured. */
  cti: CtiClient | null;
  /** The plan model; null (or unpriced) means previews are not configured. */
  model: CallPlanModel | null;
  describes: DescribeCache;
  /** AI_CALL_DEFAULT_SPECIALISTS (the offer's appointment owner list when a tenant saved none). */
  defaultSpecialists: readonly string[];
  now?: () => Date;
  /** Runs the preview after the reply; tests pass one that collects the work to await it. */
  background?: (work: () => Promise<void>) => void;
}

const PT_TIME = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true });
/** "3:42 PM PT" (the page shows retryAt in the viewer's own zone). */
function ptTime(at: Date): string {
  const p: Record<string, string> = {};
  for (const part of PT_TIME.formatToParts(at)) if (part.type !== 'literal') p[part.type] = part.value;
  return `${p.hour}:${p.minute} ${p.dayPeriod} PT`;
}

const RATE_WORDS: Readonly<Record<Extract<LimitRefusal, { code: 'RATE_LIMITED' }>['limit'], string>> = {
  previews_per_hour: `You've run ${PREVIEWS_PER_HOUR} previews in the last hour.`,
  previews_per_day: `Your team has run ${PREVIEWS_PER_DAY} previews today.`,
  calls_per_hour: `You've run ${CALLS_PER_HOUR} test calls in the last hour.`,
};

/** A limit refusal in words: 429 RATE_LIMITED (with retryAt), or 409 with its code. */
export function sendLimitRefusal(reply: FastifyReply, refusal: LimitRefusal): FastifyReply {
  switch (refusal.code) {
    case 'RATE_LIMITED':
      return sendError(reply, 429, 'RATE_LIMITED', `${RATE_WORDS[refusal.limit]} Try again at ${ptTime(refusal.retryAt)}.`, {
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
    if (!limited.ok) return sendLimitRefusal(reply, limited.refusal);
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
    const conn = await loadConnection(db, ctx.orgId);
    return toRecordTest(row, [], conn?.instanceUrl ?? null);
  });
}

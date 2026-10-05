/** The call plan board's API: list, edit, approve, reject, research again, and "Call all approved". */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ApproveCallPlanRequest, CallStage, EditCallPlanRequest } from '@cti/contracts';
import type { Db } from '@cti/db';
import { loadCallPlanCard, loadCallPlanCards } from '../call-plans/cards.js';
import { DECISION_WORDS, DecisionError, approvePlan, editPlan, rejectPlan, researchAgain } from '../call-plans/decisions.js';
import { planTextIssues } from '../call-plans/plain-text.js';
import { releaseApprovedCalls } from '../call-plans/release.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext, type RequestContext } from '../tenancy/scope.js';
import { campaignId, campaignOr404 } from './campaigns.js';

const EnrollmentParams = z.object({ enrollmentId: z.string().uuid() });
const BoardQuery = z.object({ cursor: z.string().max(200).optional(), stage: CallStage.optional() });
const EditBody = EditCallPlanRequest.superRefine((v, ctx) => {
  for (const path of planTextIssues(v.plan)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Use plain text on one line here.', path: ['plan', ...path.split('.')] });
  }
});

function sendDecisionError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof DecisionError) return sendError(reply, err.status, err.code, DECISION_WORDS[err.code]);
  throw err;
}

export async function registerCallPlanRoutes(app: FastifyInstance, deps: { db: Db; now?: () => Date }): Promise<void> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  app.get('/campaigns/:id/call-plans', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return reply;
    const id = campaignId(req, reply);
    if (!id) return reply;
    const q = BoardQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'INVALID_QUERY', 'Check the filter and try again.');
    const campaign = await campaignOr404(db, ctx.orgId, id, reply);
    if (!campaign) return reply;
    if (campaign.mode !== 'ai_call') return sendError(reply, 409, 'NOT_AI_CALL_CAMPAIGN', DECISION_WORDS.NOT_AI_CALL_CAMPAIGN);
    return loadCallPlanCards(db, ctx, id, { cursor: q.data.cursor ?? null, stage: q.data.stage ?? null, now: now() });
  });

  const decide = (path: string, method: 'put' | 'post', run: (ctx: RequestContext, enrollmentId: string, body: unknown) => Promise<void>) =>
    app[method](path, async (req, reply) => {
      const ctx = await requireContext(db, req, reply);
      if (!ctx) return reply;
      const params = EnrollmentParams.safeParse(req.params);
      if (!params.success) return sendError(reply, 400, 'INVALID_ID', 'That lead id is not valid.');
      try {
        await run(ctx, params.data.enrollmentId, req.body);
      } catch (err) {
        if (err instanceof z.ZodError) return sendError(reply, 400, 'INVALID_BODY', 'Check the plan and try again.', err.flatten());
        return sendDecisionError(reply, err);
      }
      const card = await loadCallPlanCard(db, ctx, params.data.enrollmentId, now());
      return card ?? sendError(reply, 404, 'NOT_FOUND', DECISION_WORDS.NOT_FOUND);
    });

  decide('/call-plans/:enrollmentId', 'put', (ctx, id, body) => editPlan(db, ctx, id, EditBody.parse(body), now()));
  decide('/call-plans/:enrollmentId/approve', 'post', (ctx, id, body) => approvePlan(db, ctx, id, ApproveCallPlanRequest.parse(body), now()));
  decide('/call-plans/:enrollmentId/reject', 'post', (ctx, id) => rejectPlan(db, ctx, id, now()));
  decide('/call-plans/:enrollmentId/research', 'post', (ctx, id) => researchAgain(db, ctx, id, now()));

  app.post('/campaigns/:id/ai-calls/release', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const id = campaignId(req, reply);
    if (!id) return reply;
    try {
      return await releaseApprovedCalls(db, ctx, id, now());
    } catch (err) {
      return sendDecisionError(reply, err);
    }
  });
}

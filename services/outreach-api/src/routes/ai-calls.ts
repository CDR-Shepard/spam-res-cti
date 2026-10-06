/**
 * AI call results, transcripts, availability and the admin test call (plan 1C).
 *
 * The test call is relayed to cti-api's signed internal endpoint as `target.kind = 'test'`.
 * cti-api's own gate still decides it: the requesting user must be an admin and the number
 * must be in AI_VOICE_TEST_NUMBERS (else `blocked not_admin_for_test`), and it is gated and
 * dialed like any other AI call. This route only adds its own admin check in front.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { TestCallRequest, type AiAvailability } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { CtiClient } from '../ai-calls/cti-client.js';
import { listAiCallResults, loadTranscript } from '../ai-calls/results-query.js';
import { DECISION_WORDS } from '../call-plans/decisions.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext, type RequestContext } from '../tenancy/scope.js';
import { campaignId, campaignOr404 } from './campaigns.js';

const ResultsQuery = z.object({ cursor: z.string().max(200).optional() });
const CallParams = z.object({ aiCallId: z.string().uuid() });

const isAdmin = (ctx: RequestContext): boolean => ctx.session.isAdmin || ctx.session.isSuperAdmin;

export async function registerAiCallRoutes(app: FastifyInstance, deps: { db: Db; cti: CtiClient | null }): Promise<void> {
  const { db, cti } = deps;

  app.get('/campaigns/:id/ai-calls', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return reply;
    const id = campaignId(req, reply);
    if (!id) return reply;
    const q = ResultsQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'INVALID_QUERY', 'That page link is not valid.');
    const campaign = await campaignOr404(db, ctx.orgId, id, reply);
    if (!campaign) return reply;
    if (campaign.mode !== 'ai_call') return sendError(reply, 409, 'NOT_AI_CALL_CAMPAIGN', DECISION_WORDS.NOT_AI_CALL_CAMPAIGN);
    return listAiCallResults(db, ctx, id, q.data.cursor ?? null);
  });

  app.get('/ai-calls/:aiCallId/transcript', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return reply;
    const params = CallParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'NOT_FOUND', 'No such call.');
    const transcript = await loadTranscript(db, ctx, params.data.aiCallId);
    if (transcript === null) return sendError(reply, 404, 'NOT_FOUND', 'No such call.');
    if (transcript === 'forbidden') return sendError(reply, 403, 'FORBIDDEN', 'Only the record owner in Salesforce or an admin can read this transcript.');
    return transcript;
  });

  app.get('/ai-calls/availability', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return reply;
    if (!cti) return { available: false, testNumbers: [] } satisfies AiAvailability;
    const availability = await cti.availability();
    if (!availability) return sendError(reply, 503, 'CTI_UNREACHABLE', 'The AI calling service did not answer. Try again in a minute.');
    // The test numbers are an admin tool; nobody else sees them.
    return { available: availability.available, testNumbers: isAdmin(ctx) ? availability.testNumbers : [] } satisfies AiAvailability;
  });

  app.post('/ai-calls/test', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const body = TestCallRequest.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Pick one of the test numbers.');
    if (!cti) return sendError(reply, 503, 'AI_CALLS_NOT_CONFIGURED', 'AI calls are not set up on this server yet.');
    const outcome = await cti.trigger({
      orgId: ctx.orgId,
      userId: ctx.session.userId,
      idempotencyKey: `test:${randomUUID()}`,
      target: { kind: 'test', to: body.data.to, planText: null },
    });
    if (outcome.kind !== 'response') return sendError(reply, 502, 'CTI_UNREACHABLE', 'The AI calling service did not answer. Try again in a minute.');
    return outcome.response;
  });

  // Plan 1D: an admin sends a failed Salesforce write-back round again. Its step results are kept, so it resumes and never
  // redoes a step (an Event, a conversion, a post).
  app.post('/ai-calls/:aiCallId/writeback/retry', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const params = CallParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'NOT_FOUND', 'No such call.');
    const now = new Date().toISOString();
    const result = await db.execute(sql`
      update ai_call_writebacks
      set status = 'pending', attempts = 0, next_attempt_at = ${now}::timestamptz, locked_until = null, last_error = null, updated_at = ${now}::timestamptz
      where ai_call_id = ${params.data.aiCallId}::uuid and org_id = ${ctx.orgId}::uuid and status = 'failed'
      returning id`);
    if ((result as unknown as { rows: unknown[] }).rows.length === 0) {
      return sendError(reply, 409, 'NOT_RETRYABLE', 'Only a Salesforce write-back that failed can be sent again.');
    }
    return reply.code(204).send();
  });
}

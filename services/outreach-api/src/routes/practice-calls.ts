/**
 * Practice AI calls (plan 1D Task 28), admins only: ring an admin's test number with a lead's real record and plan, and the
 * campaign's latest practice calls. A practice call never books, converts or writes to Salesforce (ai-calls/practice.ts).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { PracticeCallRequest } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { CtiClient } from '../ai-calls/cti-client.js';
import { listPracticeCalls, startPractice, type PracticeError } from '../ai-calls/practice.js';
import { DECISION_WORDS } from '../call-plans/decisions.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';
import { campaignId, campaignOr404 } from './campaigns.js';

const EnrollmentParams = z.object({ enrollmentId: z.string().uuid() });

export interface PracticeRouteDeps {
  db: Db;
  clients: SalesforceClientFactory;
  cti: CtiClient | null;
  /** AI_CALL_DEFAULT_SPECIALISTS (the offer's appointment owner list when a tenant saved none). */
  defaultSpecialists: readonly string[];
  now?: () => Date;
}

const ERRORS: Readonly<Record<Exclude<PracticeError, 'plan_text_rejected'>, [number, string, string]>> = {
  not_found: [404, 'NOT_FOUND', DECISION_WORDS.NOT_FOUND],
  not_ai_call_campaign: [409, 'NOT_AI_CALL_CAMPAIGN', DECISION_WORDS.NOT_AI_CALL_CAMPAIGN],
  no_plan: [409, 'NO_PLAN', 'That plan version is not on the board any more.'],
  not_a_test_number: [400, 'NOT_A_TEST_NUMBER', 'That number is not one of the test numbers. Pick one from the list.'],
  cti_unreachable: [502, 'CTI_UNREACHABLE', 'The AI calling service did not answer. Try again in a minute.'],
};

function sendPracticeError(reply: FastifyReply, error: PracticeError, words: readonly string[] = []): FastifyReply {
  if (error === 'plan_text_rejected') {
    const message = `Can't practice: the voice agent can't be given this plan's text. Edit it first. ${words.join('; ')}.`;
    return sendError(reply, 409, 'PLAN_TEXT_REJECTED', message, { words });
  }
  const [status, code, message] = ERRORS[error];
  return sendError(reply, status, code, message);
}

export async function registerPracticeCallRoutes(app: FastifyInstance, deps: PracticeRouteDeps): Promise<void> {
  const { db, clients, cti, defaultSpecialists } = deps;
  const now = deps.now ?? (() => new Date());

  app.post('/call-plans/:enrollmentId/practice', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const params = EnrollmentParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'INVALID_ID', 'That lead id is not valid.');
    const body = PracticeCallRequest.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Pick a plan version and one of the test numbers.');
    if (!cti) return sendError(reply, 503, 'AI_CALLS_NOT_CONFIGURED', 'AI calls are not set up on this server yet.');
    const out = await startPractice({ db, clients, cti, now: now(), log: req.log, defaultSpecialists }, ctx, params.data.enrollmentId, body.data);
    if (!out.ok) return sendPracticeError(reply, out.error, out.words);
    return out.response;
  });

  app.get('/campaigns/:id/practice-calls', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const id = campaignId(req, reply);
    if (!id) return reply;
    const campaign = await campaignOr404(db, ctx.orgId, id, reply);
    if (!campaign) return reply;
    if (campaign.mode !== 'ai_call') return sendError(reply, 409, 'NOT_AI_CALL_CAMPAIGN', DECISION_WORDS.NOT_AI_CALL_CAMPAIGN);
    return listPracticeCalls(db, ctx.orgId, id);
  });
}

/**
 * One seller's conversation (plan 2026-10-19, Sam's email): the page that shows the seller's timeline, who is
 * handling them, why Sam may not email; a person taking over or giving the seller back; and Sam's first email,
 * drafted by Sam, edited by an admin, queued by the admin's Send.
 *
 * Who may do what: the record's owner in Salesforce or an admin sees the page and changes the handler (the same
 * rule as Needs Review and call plans, tenancy/record-owner.ts); only admins draft and send. A PRACTICE draft or
 * send is the same email to the admin's own sign-in address, on the admin's own practice conversation: the seller's
 * blocks do not apply (nothing reaches the seller), the server setup and the tenant's switch do.
 *
 * The send queues; it never sends. When the email is due, the send tick (email/send.ts, outbox.ts `sendBlock`) checks
 * again: the tenant's switch and pause, that the seller still has a call plan a person approved and an open record,
 * the conversation (stopped, booked, taken over, flagged), suppression, Salesforce Email Opt Out, the daily cap and
 * the seller's hours. So a seller who opts out, closes or loses their approval in between is never emailed. It does
 * not check the server setup or the address again (the email carries its own `to`). A practice email is checked
 * against the switch and the daily cap only. A second Send while the first is still queued or sending is refused
 * (EMAIL_ALREADY_QUEUED), so a double click never queues two first emails.
 *
 * Logs carry ids, codes and counts only: never an address, a name, a subject or the draft (which is returned to the
 * admin and nowhere else).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { EmailDraftRequest, EmailSendRequest, HandlerChangeRequest, type EmailBlock, type EmailDraftResponse, type EmailSendResponse } from '@cti/contracts';
import type { Db } from '@cti/db';
import { SF_ID } from '../campaigns/records.js';
import type { AppConfig } from '../config.js';
import {
  conversationView,
  findSeller,
  ownAddress,
  practiceEmailBlock,
  realConversation,
  sellerEmailBlock,
  type EmailSetup,
  type SellerRecord,
} from '../conversations/seller-view.js';
import { ensureConversation, setHandler } from '../conversations/store.js';
import { draftIssues } from '../email/draft-guard.js';
import { emailSendAt, queueEmailOnce } from '../email/outbox.js';
import { loadWriterContext } from '../email/writer-context.js';
import { writeEmail, type EmailWriter } from '../email/writer.js';
import { sendError } from '../http/errors.js';
import { isAdmin, mayDecide } from '../tenancy/record-owner.js';
import { requireAdmin, requireContext, type RequestContext } from '../tenancy/scope.js';

export interface SellerRouteDeps {
  db: Db;
  /** Sam's email writer; null when there is no Anthropic key or EMAIL_MODEL has no price (the page says not_configured). */
  writer: EmailWriter | null;
  cfg: Pick<AppConfig, 'emailEnabled' | 'EMAIL_FROM' | 'EMAIL_COMPANY_NAME'>;
  now?: () => Date;
}

/** How long an admin waits for Sam's draft before it is a MODEL_ERROR. */
export const DRAFT_WRITER_TIMEOUT_MS = 90_000;

const Params = z.object({ sfRecordId: z.string().regex(SF_ID) });

export const SELLER_WORDS = {
  INVALID_ID: 'That Salesforce record id is not valid.',
  INVALID_BODY: 'That request is not valid.',
  NOT_FOUND: 'No such seller in this tenant.',
  FORBIDDEN: "Only the record's owner in Salesforce or an admin can see or change this seller.",
  BLOCKED: 'Sam cannot email this seller right now.',
  DRAFT_REFUSED: 'Sam chose not to write to this seller. Read the timeline, then write it yourself or try again later.',
  AI_BUDGET: "Today's AI budget is spent. Try again tomorrow, or raise the budget.",
  MODEL_ERROR: "Sam's draft did not come back. Try again in a minute.",
  DRAFT_INVALID: 'Fix the draft before it is sent.',
  EMAIL_ALREADY_QUEUED: 'An email to this seller is already waiting to go out. Wait until it is sent, then try again.',
} as const;

/** Sends the error and answers null, for the helpers that either load something or refuse. */
function refuse(reply: FastifyReply, status: number, code: string, words: string, details?: unknown): null {
  sendError(reply, status, code, words, details);
  return null;
}

interface Loaded<T> {
  ctx: RequestContext;
  record: SellerRecord;
  body: T;
}

/** Where a first email goes and the writer that drafts it, or why it may not. */
type Target = { block: EmailBlock } | { to: string; writer: EmailWriter };

export async function registerSellerRoutes(app: FastifyInstance, deps: SellerRouteDeps): Promise<void> {
  const { db, writer, cfg } = deps;
  const now = deps.now ?? (() => new Date());
  const setupOf = (ctx: RequestContext): EmailSetup => ({ configured: cfg.emailEnabled && writer !== null, settings: ctx.tenant.settings });

  /**
   * The session, the record and the caller's right to it, each refused with its own error (sent here; null = done).
   * The id and the body are checked before the record is read; the record must be this tenant's.
   */
  async function load<T>(req: FastifyRequest, reply: FastifyReply, o: { adminOnly: boolean; body: z.ZodType<T> | null }): Promise<Loaded<T> | null> {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || (o.adminOnly && !requireAdmin(ctx, reply))) return null;
    const params = Params.safeParse(req.params);
    if (!params.success) return refuse(reply, 400, 'INVALID_ID', SELLER_WORDS.INVALID_ID);
    const body = o.body ? o.body.safeParse(req.body ?? null) : null;
    if (body && !body.success) return refuse(reply, 400, 'INVALID_BODY', SELLER_WORDS.INVALID_BODY, body.error.issues.map((i) => i.path.join('.')));
    const record = await findSeller(db, ctx.orgId, params.data.sfRecordId);
    if (!record) return refuse(reply, 404, 'NOT_FOUND', SELLER_WORDS.NOT_FOUND);
    if (!o.adminOnly && !(await mayDecide(db, ctx, record.ownerSfUserId))) return refuse(reply, 403, 'FORBIDDEN', SELLER_WORDS.FORBIDDEN);
    return { ctx, record, body: body?.data as T };
  }

  /** load() has already refused everyone who is neither the owner nor an admin, so whoever sees the page may change the handler. */
  const view = (s: Loaded<unknown>) =>
    conversationView(db, setupOf(s.ctx), { orgId: s.ctx.orgId, record: s.record, isAdmin: isAdmin(s.ctx), mayChangeHandler: true });

  /** The seller's address after every block (a real email), or the admin's own address after the setup checks (practice). */
  async function target(s: Loaded<unknown>, practice: boolean): Promise<Target> {
    const setup = setupOf(s.ctx);
    const to = practice ? await ownAddress(db, s.ctx.session.userId) : s.record.address;
    const block = practice
      ? practiceEmailBlock(setup, to)
      : await sellerEmailBlock(db, setup, { orgId: s.ctx.orgId, record: s.record, conversation: await realConversation(db, s.ctx.orgId, s.record.id) });
    // A null writer or address is already a block (not_configured, no_address); the second test only narrows the types.
    if (block !== null || writer === null || to === null) return { block: block ?? 'not_configured' };
    return { to, writer };
  }

  app.get('/sellers/:sfRecordId/conversation', async (req, reply) => {
    const s = await load(req, reply, { adminOnly: false, body: null });
    if (!s) return reply;
    return view(s);
  });

  app.put('/sellers/:sfRecordId/handler', async (req, reply) => {
    const s = await load(req, reply, { adminOnly: false, body: HandlerChangeRequest });
    if (!s) return reply;
    const conversation = await ensureConversation(db, { orgId: s.ctx.orgId, crmRecordId: s.record.id });
    if (await setHandler(db, { conversationId: conversation.id, handler: s.body.handler, userId: s.ctx.session.userId, now: now() })) {
      req.log.info({ orgId: s.ctx.orgId, conversationId: conversation.id, handler: s.body.handler }, 'seller handler changed');
    }
    return view(s);
  });

  app.post('/sellers/:sfRecordId/email/draft', async (req, reply) => {
    const s = await load(req, reply, { adminOnly: true, body: EmailDraftRequest });
    if (!s) return reply;
    const t = await target(s, s.body.practice);
    if ('block' in t) return sendError(reply, 409, t.block, SELLER_WORDS.BLOCKED);
    const at = now();
    // A practice draft is the seller's real first email (their real history), only addressed to the admin.
    const conversation = await realConversation(db, s.ctx.orgId, s.record.id);
    const context = await loadWriterContext(db, { orgId: s.ctx.orgId, crmRecordId: s.record.id, conversationId: conversation?.id ?? null, now: at, companyName: cfg.EMAIL_COMPANY_NAME });
    const result = await writeEmail(
      { db, writer: t.writer, orgId: s.ctx.orgId, settings: s.ctx.tenant.settings, now: at, signal: AbortSignal.timeout(DRAFT_WRITER_TIMEOUT_MS), log: req.log },
      { ...context, mode: 'first', inbound: null },
    );
    const outcome = result.kind === 'failed' ? `failed:${result.reason}` : result.kind;
    req.log.info({ orgId: s.ctx.orgId, crmRecordId: s.record.id, practice: s.body.practice, outcome }, 'email draft');
    if (result.kind === 'over_budget') return sendError(reply, 429, 'AI_BUDGET', SELLER_WORDS.AI_BUDGET);
    if (result.kind === 'failed') {
      return result.reason === 'declined' ? sendError(reply, 422, 'DRAFT_REFUSED', SELLER_WORDS.DRAFT_REFUSED) : sendError(reply, 502, 'MODEL_ERROR', SELLER_WORDS.MODEL_ERROR);
    }
    const draft: EmailDraftResponse = { subject: result.decision.subject, body: result.decision.body, to: t.to };
    return draft;
  });

  app.post('/sellers/:sfRecordId/email/send', async (req, reply) => {
    const s = await load(req, reply, { adminOnly: true, body: EmailSendRequest });
    if (!s) return reply;
    const { subject, body, practice } = s.body;
    const issues = draftIssues({ subject, body });
    if (issues.length > 0) return sendError(reply, 422, 'DRAFT_INVALID', SELLER_WORDS.DRAFT_INVALID, issues);
    const t = await target(s, practice);
    if ('block' in t) return sendError(reply, 409, t.block, SELLER_WORDS.BLOCKED);
    const at = now();
    const userId = s.ctx.session.userId;
    const conversation = await ensureConversation(db, { orgId: s.ctx.orgId, crmRecordId: s.record.id, practiceUserId: practice ? userId : null });
    // A practice email goes to the admin, so it is due now: the send tick does not hold it to the seller's hours.
    const sendAfter = practice ? at : emailSendAt(s.record.phones, at);
    const queued = await queueEmailOnce(db, {
      orgId: s.ctx.orgId,
      conversationId: conversation.id,
      to: t.to,
      from: cfg.EMAIL_FROM,
      subject,
      body,
      purpose: practice ? 'practice' : 'first',
      requestedBy: userId,
      inReplyTo: null,
      references: null,
      sendAfter,
    });
    if (queued === 'already_queued') return sendError(reply, 409, 'EMAIL_ALREADY_QUEUED', SELLER_WORDS.EMAIL_ALREADY_QUEUED);
    req.log.info({ orgId: s.ctx.orgId, conversationId: conversation.id, emailId: queued.emailId, practice }, 'email queued by an admin');
    const response: EmailSendResponse = { emailId: queued.emailId, sendAfter: sendAfter.toISOString(), to: t.to };
    return response;
  });
}

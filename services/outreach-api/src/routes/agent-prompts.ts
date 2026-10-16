/**
 * Editable agent prompts, admins only: read, check, preview, save and reset the text of the AI phone agent's instructions,
 * its voicemail message and its inbound-call instructions (what it follows when a test phone calls it). Versions are append-only rows in `ai_agent_prompts` (the active one is the newest per org and
 * kind; a NULL body is the built-in default). cti-api owns the placeholders, the defaults and the rendering, so every check
 * goes through `cti.checkPrompt`; this file stores versions and refuses what cti-api refuses. The template text is a
 * seller-facing script: it is never logged, and never put in an error.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AGENT_PROMPT_MAX_CHARS,
  AGENT_PROMPT_VERSIONS_SHOWN,
  AgentPromptKind,
  AgentPromptPreviewRequest,
  AgentPromptSaveRequest,
  type AgentPromptCheck,
  type AgentPromptState,
  type AgentPromptVersionBody,
  type AgentPromptsResponse,
} from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { CtiClient } from '../ai-calls/cti-client.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

export interface AgentPromptRouteDeps {
  db: Db;
  /** null when AI calls are not set up on this server: nothing can be checked, so the routes answer 503. */
  cti: Pick<CtiClient, 'checkPrompt'> | null;
}

export const CHECK_UNAVAILABLE_WORDS = "Can't check the prompt right now — try again in a minute";

const KINDS = AgentPromptKind.options;
const KIND_WORDS: Readonly<Record<AgentPromptKind, string>> = {
  instructions: "The agent's instructions",
  voicemail: 'The voicemail message',
  inbound: 'The inbound call instructions',
};
const KindParams = z.object({ kind: AgentPromptKind });
const VersionParams = KindParams.extend({ id: z.string().uuid() });
const prompts = schema.aiAgentPrompts;

const sendInvalidPrompt = (reply: FastifyReply, problems: readonly string[]): FastifyReply =>
  reply.code(400).send({ error: 'invalid_prompt', code: 'INVALID_PROMPT', problems, requestId: reply.request.id });

const sendCheckUnavailable = (reply: FastifyReply): FastifyReply =>
  reply.code(503).send({ error: 'prompt_check_unavailable', code: 'PROMPT_CHECK_UNAVAILABLE', message: CHECK_UNAVAILABLE_WORDS, requestId: reply.request.id });

/** The plain-words problem for a template over the kind's limit (counts only, never the text). */
const tooLongProblem = (kind: AgentPromptKind, chars: number): string =>
  `${KIND_WORDS[kind]} can be at most ${AGENT_PROMPT_MAX_CHARS[kind].toLocaleString('en-US')} characters; this one is ${chars.toLocaleString('en-US')}.`;

/** The `:kind` of the path, or the 400 that says it is not one of the three texts. */
function kindOf(req: FastifyRequest, reply: FastifyReply): AgentPromptKind | null {
  const params = KindParams.safeParse(req.params);
  if (params.success) return params.data.kind;
  sendError(reply, 400, 'INVALID_KIND', 'That is not one of the agent texts you can edit.');
  return null;
}

const isTooLong = (kind: AgentPromptKind, template: string): boolean => template.length > AGENT_PROMPT_MAX_CHARS[kind];

/** One version's row as the history list shows it: who, when, and how long, never the text. */
const versionRows = (db: Db, orgId: string, kind: AgentPromptKind) =>
  db
    .select({
      id: prompts.id,
      createdAt: prompts.createdAt,
      createdByEmail: schema.users.email,
      isDefault: sql<boolean>`${prompts.body} is null`,
      chars: sql<number>`coalesce(char_length(${prompts.body}), 0)::int`,
    })
    .from(prompts)
    .leftJoin(schema.users, eq(schema.users.id, prompts.createdBy))
    .where(and(eq(prompts.orgId, orgId), eq(prompts.kind, kind)))
    .orderBy(desc(prompts.createdAt))
    .limit(AGENT_PROMPT_VERSIONS_SHOWN);

/** The active version's text: the newest row, whose NULL body (a reset) means the default. */
const newestBody = async (db: Db, orgId: string, kind: AgentPromptKind): Promise<string | null> => {
  const [row] = await db
    .select({ body: prompts.body })
    .from(prompts)
    .where(and(eq(prompts.orgId, orgId), eq(prompts.kind, kind)))
    .orderBy(desc(prompts.createdAt))
    .limit(1);
  return row?.body ?? null;
};

async function stateOf(db: Db, orgId: string, kind: AgentPromptKind, check: AgentPromptCheck): Promise<AgentPromptState> {
  const [active, rows] = await Promise.all([newestBody(db, orgId, kind), versionRows(db, orgId, kind)]);
  const versions = rows.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), createdByEmail: r.createdByEmail, isDefault: r.isDefault, chars: r.chars }));
  const newest = versions[0];
  return {
    kind,
    active,
    defaultTemplate: check.defaultTemplate,
    placeholders: check.placeholders,
    updatedAt: newest?.createdAt ?? null,
    updatedByEmail: newest?.createdByEmail ?? null,
    versions,
  };
}

export async function registerAgentPromptRoutes(app: FastifyInstance, deps: AgentPromptRouteDeps): Promise<void> {
  const { db, cti } = deps;

  /** cti-api's check of a template (null = the built-in default), or null when it cannot be reached (logged without the text). */
  const check = async (req: FastifyRequest, kind: AgentPromptKind, template: string | null): Promise<AgentPromptCheck | null> => {
    const out = cti ? await cti.checkPrompt({ kind, template }) : ({ kind: 'transport', error: 'not_configured' } as const);
    if (out.kind === 'check') return out.check;
    req.log.warn({ kind, error: out.error }, 'agent prompt check unavailable');
    return null;
  };

  app.get('/settings/agent-prompts', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const checks = await Promise.all(KINDS.map((kind) => check(req, kind, null)));
    if (checks.some((c) => c === null)) return sendCheckUnavailable(reply);
    const [instructions, voicemail, inbound] = await Promise.all(KINDS.map((kind, i) => stateOf(db, ctx.orgId, kind, checks[i]!)));
    return { instructions: instructions!, voicemail: voicemail!, inbound: inbound! } satisfies AgentPromptsResponse;
  });

  app.post('/settings/agent-prompts/:kind/preview', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const kind = kindOf(req, reply);
    if (!kind) return reply;
    const body = AgentPromptPreviewRequest.safeParse(req.body ?? null);
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Send the text to preview as { "template": "…" }.');
    const { template } = body.data;
    if (isTooLong(kind, template)) return sendInvalidPrompt(reply, [tooLongProblem(kind, template.length)]);
    return (await check(req, kind, template)) ?? sendCheckUnavailable(reply);
  });

  app.put('/settings/agent-prompts/:kind', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const kind = kindOf(req, reply);
    if (!kind) return reply;
    const body = AgentPromptSaveRequest.safeParse(req.body ?? null);
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Send the new text as { "template": "…" }, or { "template": null } to go back to the default.');
    const { template } = body.data;
    if (template !== null && isTooLong(kind, template)) return sendInvalidPrompt(reply, [tooLongProblem(kind, template.length)]);
    // A reset needs no verdict, only the defaults the answer carries; a save must pass cti-api's check first, and stores nothing otherwise.
    const checked = await check(req, kind, template);
    if (!checked) return sendCheckUnavailable(reply);
    if (checked.problems.length > 0) return sendInvalidPrompt(reply, checked.problems);
    await db.insert(prompts).values({ orgId: ctx.orgId, kind, body: template, createdBy: ctx.session.userId });
    return stateOf(db, ctx.orgId, kind, checked);
  });

  app.get('/settings/agent-prompts/:kind/versions/:id', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const kind = kindOf(req, reply);
    if (!kind) return reply;
    const params = VersionParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 400, 'INVALID_ID', 'That version id is not valid.');
    const [row] = await db
      .select({ id: prompts.id, body: prompts.body })
      .from(prompts)
      .where(and(eq(prompts.id, params.data.id), eq(prompts.orgId, ctx.orgId), eq(prompts.kind, kind)));
    if (!row) return sendError(reply, 404, 'NOT_FOUND', 'No such version.');
    return row satisfies AgentPromptVersionBody;
  });
}

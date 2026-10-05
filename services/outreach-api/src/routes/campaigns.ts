import { and, desc, eq, ne } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CampaignStatusChange,
  CreateCampaignRequest,
  EnrollmentStatus,
  FieldMap,
  PreviewRequest,
  SfObject,
  UpdateCampaignRequest,
  type CampaignsResponse,
  type ListViewsResponse,
} from '@cti/contracts';
import { schema, type CampaignRow, type Db } from '@cti/db';
import { loadPlan } from '../campaigns/plan.js';
import { previewCampaign } from '../campaigns/preview.js';
import { CampaignSourceError, membershipSoql } from '../campaigns/source.js';
import { canTransition, pauseReasonAfter, toCampaignDto } from '../campaigns/state.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';
import { CRM_NOT_CONNECTED_MESSAGE, sendCrmError } from './crm-errors.js';

export interface CampaignRouteDeps {
  db: Db;
  clients: SalesforceClientFactory;
}

const MAX_CAMPAIGNS_LISTED = 500;
const IdParams = z.object({ id: z.string().uuid() });
const ListViewsQuery = z.object({ object: SfObject });
const ListQuery = z.object({ archived: z.enum(['0', '1']).optional() });
const PlanQuery = z.object({ cursor: z.string().uuid().optional(), status: EnrollmentStatus.optional() });

/** A malformed id can never match a row: 404, not 400 (same rule as team.ts). */
export function campaignId(req: FastifyRequest, reply: FastifyReply): string | null {
  const params = IdParams.safeParse(req.params);
  if (params.success) return params.data.id;
  sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'No such campaign');
  return null;
}

/** The tenant's campaign or null — a row for another tenant is never returned, even if a query bug let one through. */
async function loadCampaign(db: Db, orgId: string, id: string): Promise<CampaignRow | null> {
  const row = await db.query.campaigns.findFirst({ where: and(eq(schema.campaigns.id, id), eq(schema.campaigns.orgId, orgId)) });
  return row && row.id === id && row.orgId === orgId ? row : null;
}

export async function campaignOr404(db: Db, orgId: string, id: string, reply: FastifyReply): Promise<CampaignRow | null> {
  const row = await loadCampaign(db, orgId, id);
  if (!row) sendError(reply, 404, 'CAMPAIGN_NOT_FOUND', 'No such campaign');
  return row;
}

/** The field map of a connected tenant, or null (no connection, broken, or an unreadable map). */
export async function connectedFieldMap(db: Db, orgId: string): Promise<FieldMap | null> {
  const row = await loadConnection(db, orgId);
  if (!row || row.status !== 'connected') return null;
  const parsed = FieldMap.safeParse(row.fieldMap);
  return parsed.success ? parsed.data : null;
}

export function sendSourceError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CampaignSourceError) return sendError(reply, 422, 'INVALID_SOURCE', err.message, { code: err.code });
  return sendCrmError(reply, err);
}

function registerReadRoutes(app: FastifyInstance, deps: CampaignRouteDeps): void {
  const { db } = deps;

  app.get('/crm/listviews', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const q = ListViewsQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'VALIDATION', 'object must be Lead or Opportunity', q.error.flatten());
    try {
      const client = await deps.clients(ctx.orgId);
      return { listViews: await client.listViews(q.data.object) } satisfies ListViewsResponse;
    } catch (err) {
      return sendCrmError(reply, err);
    }
  });

  app.get('/campaigns', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'VALIDATION', 'Invalid query', q.error.flatten());
    const c = schema.campaigns;
    const rows = await db.query.campaigns.findMany({
      where: q.data.archived === '1' ? eq(c.orgId, ctx.orgId) : and(eq(c.orgId, ctx.orgId), ne(c.status, 'archived')),
      orderBy: [desc(c.createdAt)],
      limit: MAX_CAMPAIGNS_LISTED,
    });
    return { campaigns: rows.filter((r) => r.orgId === ctx.orgId).map(toCampaignDto) } satisfies CampaignsResponse;
  });

  app.get('/campaigns/:id', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const id = campaignId(req, reply);
    if (!id) return;
    const row = await campaignOr404(db, ctx.orgId, id, reply);
    return row ? toCampaignDto(row) : undefined;
  });

  app.get('/campaigns/:id/plan', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const id = campaignId(req, reply);
    if (!id) return;
    const q = PlanQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'VALIDATION', 'Invalid plan query', q.error.flatten());
    if (!(await campaignOr404(db, ctx.orgId, id, reply))) return;
    return loadPlan(db, { orgId: ctx.orgId, campaignId: id, status: q.data.status, cursor: q.data.cursor });
  });
}

function registerBuildRoutes(app: FastifyInstance, deps: CampaignRouteDeps): void {
  const { db } = deps;

  app.post('/campaigns/preview', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const body = PreviewRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid preview request', body.error.flatten());
    const fieldMap = await connectedFieldMap(db, ctx.orgId);
    if (!fieldMap) return sendError(reply, 409, 'CRM_NOT_CONNECTED', CRM_NOT_CONNECTED_MESSAGE);
    try {
      const client = await deps.clients(ctx.orgId);
      return await previewCampaign({ db, client, orgId: ctx.orgId, fieldMap }, body.data);
    } catch (err) {
      return sendSourceError(reply, err);
    }
  });

  app.post('/campaigns', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const body = CreateCampaignRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid campaign', body.error.flatten());
    let soql: string;
    try {
      soql = await membershipSoql(await deps.clients(ctx.orgId), body.data);
    } catch (err) {
      return sendSourceError(reply, err);
    }
    const { name, sfObject, source, mode } = body.data;
    const [row] = await db
      .insert(schema.campaigns)
      .values({
        orgId: ctx.orgId,
        name,
        sfObject,
        sourceKind: source.kind,
        listViewId: source.kind === 'list_view' ? source.listViewId : null,
        soql,
        mode,
        status: 'draft',
        createdBy: ctx.session.userId,
      })
      .returning();
    return reply.code(201).send(toCampaignDto(row!));
  });
}

function registerChangeRoutes(app: FastifyInstance, deps: CampaignRouteDeps): void {
  const { db } = deps;
  const c = schema.campaigns;

  app.patch('/campaigns/:id', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const id = campaignId(req, reply);
    if (!id) return;
    const body = UpdateCampaignRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid update', body.error.flatten());
    const changes = Object.fromEntries(Object.entries(body.data).filter(([, v]) => v !== undefined)) as UpdateCampaignRequest;
    if (Object.keys(changes).length === 0) return sendError(reply, 400, 'VALIDATION', 'Nothing to update');
    const current = await campaignOr404(db, ctx.orgId, id, reply);
    if (!current) return;
    if (current.status === 'archived') return sendError(reply, 409, 'CAMPAIGN_ARCHIVED', 'An archived campaign cannot be changed');
    // Compare-and-swap on "not archived": an archive that lands after the check above wins.
    const [row] = await db.update(c).set({ ...changes, updatedAt: new Date() }).where(and(eq(c.id, id), eq(c.orgId, ctx.orgId), ne(c.status, 'archived'))).returning();
    if (!row) return sendError(reply, 409, 'CAMPAIGN_ARCHIVED', 'An archived campaign cannot be changed');
    return toCampaignDto(row);
  });

  app.post('/campaigns/:id/status', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const id = campaignId(req, reply);
    if (!id) return;
    const body = CampaignStatusChange.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid status', body.error.flatten());
    const current = await campaignOr404(db, ctx.orgId, id, reply);
    if (!current) return;
    const to = body.data.status;
    const badTransition = () => sendError(reply, 409, 'BAD_TRANSITION', `A ${current.status} campaign cannot become ${to}`, { from: current.status, to });
    if (!canTransition(current.status, to)) return badTransition();
    // Compare-and-swap on the status we checked: a concurrent change cannot skip the state machine.
    const [row] = await db
      .update(c)
      // paused_from records what an automatic resume (B7) may return to; leaving `paused` clears it.
      .set({ status: to, pauseReason: pauseReasonAfter(to), pausedFrom: to === 'paused' && (current.status === 'dry_run' || current.status === 'active') ? current.status : null, updatedAt: new Date() })
      .where(and(eq(c.id, id), eq(c.orgId, ctx.orgId), eq(c.status, current.status)))
      .returning();
    return row ? toCampaignDto(row) : badTransition();
  });
}

export async function registerCampaignRoutes(app: FastifyInstance, deps: CampaignRouteDeps): Promise<void> {
  registerReadRoutes(app, deps);
  registerBuildRoutes(app, deps);
  registerChangeRoutes(app, deps);
}

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SelectionChange, type CandidatePage, type SelectionResponse } from '@cti/contracts';
import type { CampaignRow, Db } from '@cti/db';
import { candidatePage } from '../campaigns/candidates.js';
import { campaignMemberIds, type MemberIdCache } from '../campaigns/member-cache.js';
import { clearSelection, deselectRecords, selectedCount, selectRecords } from '../campaigns/selection.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';
import { CRM_NOT_CONNECTED_MESSAGE } from './crm-errors.js';
import { campaignId, campaignOr404, connectedFieldMap, sendSourceError } from './campaigns.js';

export interface SelectionRouteDeps {
  db: Db;
  clients: SalesforceClientFactory;
  cache: MemberIdCache;
}

const PageQuery = z.object({ page: z.coerce.number().int().min(1).max(1_000).default(1) });

function aiCallCampaignOr409(row: CampaignRow, reply: FastifyReply, forWrite: boolean): boolean {
  if (row.mode !== 'ai_call') {
    sendError(reply, 409, 'NOT_AI_CALL_CAMPAIGN', 'Leads are picked only in AI call campaigns');
    return false;
  }
  if (forWrite && row.status === 'archived') {
    sendError(reply, 409, 'CAMPAIGN_ARCHIVED', 'An archived campaign cannot be changed');
    return false;
  }
  return true;
}

export async function registerCampaignSelectionRoutes(app: FastifyInstance, deps: SelectionRouteDeps): Promise<void> {
  const { db } = deps;

  app.get('/campaigns/:id/candidates', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const id = campaignId(req, reply);
    if (!id) return;
    const q = PageQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'VALIDATION', 'page must be a whole number from 1', q.error.flatten());
    const row = await campaignOr404(db, ctx.orgId, id, reply);
    if (!row || !aiCallCampaignOr409(row, reply, false)) return;
    const fieldMap = await connectedFieldMap(db, ctx.orgId);
    if (!fieldMap) return sendError(reply, 409, 'CRM_NOT_CONNECTED', CRM_NOT_CONNECTED_MESSAGE);
    try {
      const client = await deps.clients(ctx.orgId);
      return (await candidatePage({ db, client, cache: deps.cache, fieldMap }, row, q.data.page)) satisfies CandidatePage;
    } catch (err) {
      return sendSourceError(reply, err);
    }
  });

  app.put('/campaigns/:id/selection', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const id = campaignId(req, reply);
    if (!id) return;
    const body = SelectionChange.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid selection change', body.error.flatten());
    const row = await campaignOr404(db, ctx.orgId, id, reply);
    if (!row || !aiCallCampaignOr409(row, reply, true)) return;
    const change = body.data;
    // Clearing or removing needs no Salesforce read: only adding does (to drop what is not a member).
    let members = new Set<string>();
    if (change.selectAll || change.add.length > 0) {
      try {
        members = new Set(await campaignMemberIds({ client: await deps.clients(ctx.orgId), cache: deps.cache }, row));
      } catch (err) {
        return sendSourceError(reply, err);
      }
    }
    if (change.clear) await clearSelection(db, row.id);
    const wanted = change.selectAll ? [...members] : change.add;
    const accepted = wanted.filter((sfId) => members.has(sfId));
    await selectRecords(db, { orgId: ctx.orgId, campaignId: row.id, userId: ctx.session.userId, sfRecordIds: accepted });
    if (change.remove.length > 0) await deselectRecords(db, row.id, change.remove);
    const response: SelectionResponse = { selectedCount: await selectedCount(db, row.id), ignored: change.selectAll ? 0 : change.add.length - accepted.length };
    return response;
  });
}

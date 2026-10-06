/**
 * AI call settings (plan 1D), admins only: appointment booking (the ordered appointment owner list, hours per kind, Lead
 * conversion) and the Salesforce write-back switch, stored in `organizations.settings` beside the other keys. The user
 * picker searches and resolves Salesforce Users through the tenant's integration connection.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AiCallSettings, type SalesforceUserOption } from '@cti/contracts';
import type { Db } from '@cti/db';
import { soqlEscape } from '@cti/salesforce';
import { SF_ID } from '../campaigns/records.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import { sendError } from '../http/errors.js';
import { soqlIdList } from '../research/text.js';
import { outreachSettings } from '../settings.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';
import { sendCrmError } from './crm-errors.js';

export interface AiCallSettingsRouteDeps {
  db: Db;
  clients: SalesforceClientFactory;
  /** AI_CALL_DEFAULT_SPECIALISTS: what GET shows for a tenant that has saved no list. */
  defaultSpecialists?: readonly string[];
}

export const USER_SEARCH_LIMIT = 25;
export const MAX_USER_IDS = 20;

const UsersQuery = z
  .object({
    search: z.string().trim().min(2).max(40).regex(/^[^\p{Cc}]*$/u).optional(),
    ids: z
      .string()
      .transform((v) => v.split(',').map((id) => id.trim()).filter((id) => id !== ''))
      .pipe(z.array(z.string().regex(SF_ID)).min(1).max(MAX_USER_IDS))
      .optional(),
  })
  .refine((q) => (q.search === undefined) !== (q.ids === undefined), { message: 'search or ids, not both' });

type Row = Record<string, unknown>;

/** `soqlEscape`, then LIKE's own wildcards: a typed % or _ matches itself. */
const likeEscape = (s: string): string => soqlEscape(s).replace(/[%_]/g, '\\$&');

export const userSearchSoql = (search: string): string =>
  `SELECT Id, Name, Title, IsActive FROM User WHERE IsActive = true AND UserType = 'Standard' AND Name LIKE '%${likeEscape(search)}%' ORDER BY Name LIMIT ${USER_SEARCH_LIMIT}`;

/** By id, inactive users included, so the card can flag them. */
export const usersByIdSoql = (ids: readonly string[]): string => `SELECT Id, Name, Title, IsActive FROM User WHERE Id IN (${soqlIdList(ids)})`;

function toOption(r: Row): SalesforceUserOption | null {
  const id = typeof r.Id === 'string' && SF_ID.test(r.Id) ? r.Id : null;
  const name = typeof r.Name === 'string' && r.Name.trim() !== '' ? r.Name.trim() : null;
  if (!id || !name) return null;
  return { id, name, title: typeof r.Title === 'string' && r.Title.trim() !== '' ? r.Title.trim() : null, isActive: r.IsActive === true };
}

/** Salesforce compares ids on their case-sensitive 15-character core. */
const core = (id: string): string => id.slice(0, 15);
const inAskedOrder = (options: SalesforceUserOption[], ids: readonly string[]): SalesforceUserOption[] =>
  ids.flatMap((id) => options.filter((o) => core(o.id) === core(id)).slice(0, 1));

export async function registerAiCallSettingsRoutes(app: FastifyInstance, deps: AiCallSettingsRouteDeps): Promise<void> {
  const { db, clients } = deps;
  const settingsOf = (blob: unknown): AiCallSettings => {
    const s = outreachSettings({ settings: blob }, { defaultSpecialists: deps.defaultSpecialists });
    return { booking: s.aiCallBooking, writeback: s.aiCallWriteback };
  };

  app.get('/settings/ai-calls', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    return settingsOf(ctx.tenant.settings);
  });

  app.put('/settings/ai-calls', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const body = AiCallSettings.safeParse(req.body ?? null);
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Those AI call settings are not valid.', body.error.issues.map((i) => i.path.join('.')));
    // organizations has no updated_at column; only these two keys change, every other setting is kept.
    const result = await db.execute(sql`
      update organizations
      set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('aiCallBooking', ${JSON.stringify(body.data.booking)}::jsonb, 'aiCallWriteback', ${body.data.writeback}::boolean)
      where id = ${ctx.orgId}::uuid
      returning settings`);
    const saved = (result as unknown as { rows: Array<{ settings: unknown }> }).rows[0];
    if (!saved) return sendError(reply, 404, 'NOT_FOUND', 'No such tenant.');
    return settingsOf(saved.settings);
  });

  app.get('/salesforce/users', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const q = UsersQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'INVALID_QUERY', 'Search with 2 to 40 characters, or ask for up to 20 user ids.');
    try {
      const client = await clients(ctx.orgId);
      const ids = q.data.ids;
      const rows = await client.query<Row>(ids ? usersByIdSoql(ids) : userSearchSoql(q.data.search!));
      const options = rows.flatMap((r) => toOption(r) ?? []);
      return ids ? inAskedOrder(options, ids) : options;
    } catch (err) {
      return sendCrmError(reply, err);
    }
  });
}

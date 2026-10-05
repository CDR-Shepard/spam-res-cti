import { and, eq, lt } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { constantTimeEquals, randomToken } from '@cti/auth';
import { FieldMap, type CrmConnectionStatus, type StartConnectionResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { buildAuthorizeUrl, exchangeCode, pkcePair, type SalesforceClient } from '@cti/salesforce';
import type { AppConfig } from '../config.js';
import { bootstrapClient, salesforceOAuthConfig, type SalesforceClientFactory } from '../crm/client-factory.js';
import { deleteConnection, loadConnection, saveConnection, saveFieldMap, type CrmConnection } from '../crm/connection-store.js';
import { defaultFieldMap, fieldMapProblems, type ObjectDescribes } from '../crm/field-map.js';
import { sendError } from '../http/errors.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';
import { CRM_NOT_CONNECTED_MESSAGE, sendCrmError } from './crm-errors.js';

export interface ConnectionRouteDeps {
  db: Db;
  cfg: AppConfig;
  clients: SalesforceClientFactory;
  /** Token exchange and the callback's first describe go through this; tests pass a fake. */
  fetchImpl?: typeof fetch;
}

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Set by /start, required by /callback: only the browser that started a connect can finish it (login-CSRF defense, as in routes/auth.ts). */
export const STATE_COOKIE = 'outreach_crm_oauth_state';
const CALLBACK_PATH = '/api/connections/salesforce/callback';
const SETTINGS_PATH = '/settings/connections';
const SF_USER_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

const CallbackQuery = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

type StateRow = typeof schema.crmOauthStates.$inferSelect;
type CallbackError = 'exchange_failed' | 'describe_failed';

function toStatus(cfg: AppConfig, row: CrmConnection | null): CrmConnectionStatus {
  const fieldMap = row ? FieldMap.safeParse(row.fieldMap) : null;
  return {
    configured: cfg.salesforceEnabled,
    connected: row?.status === 'connected',
    status: row ? row.status : null,
    instanceUrl: row?.instanceUrl ?? null,
    username: row?.sfUsername ?? null,
    connectedAt: row ? row.connectedAt.toISOString() : null,
    lastError: row?.lastError ?? null,
    fieldMap: fieldMap?.success ? fieldMap.data : null,
  };
}

function settingsRedirect(cfg: AppConfig, reply: FastifyReply, params: Record<string, string>): FastifyReply {
  const url = new URL(SETTINGS_PATH, cfg.APP_PUBLIC_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return reply.redirect(url.toString());
}

function salesforceDisabled(cfg: AppConfig, reply: FastifyReply): boolean {
  if (cfg.salesforceEnabled) return false;
  sendError(reply, 503, 'SALESFORCE_DISABLED', 'Salesforce is not configured on this server');
  return true;
}

async function describeBoth(client: SalesforceClient): Promise<ObjectDescribes> {
  const [lead, opportunity] = await Promise.all([client.describe('Lead'), client.describe('Opportunity')]);
  return { Lead: lead, Opportunity: opportunity };
}

/** The Integration user's login name, for the Connections page. Display only: a failure is logged and shown as unknown. */
async function usernameOf(client: SalesforceClient, sfUserId: string, log: FastifyBaseLogger): Promise<string | null> {
  if (!SF_USER_ID.test(sfUserId)) return null;
  try {
    const rows = await client.query<{ Username?: unknown }>(`SELECT Username FROM User WHERE Id = '${sfUserId}' LIMIT 1`);
    const name = rows[0]?.Username;
    return typeof name === 'string' && name ? name : null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'salesforce username lookup failed');
    return null;
  }
}

/** Exchange, describe, save. Returns the error code for the redirect, or null on success. */
async function completeConnect(deps: ConnectionRouteDeps, flow: StateRow, code: string, log: FastifyBaseLogger): Promise<CallbackError | null> {
  const { db, cfg, fetchImpl } = deps;
  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(salesforceOAuthConfig(cfg), code, flow.codeVerifier, fetchImpl);
  } catch (err) {
    log.warn({ err: (err as Error).message, orgId: flow.orgId }, 'salesforce code exchange failed');
    return 'exchange_failed';
  }
  const client = bootstrapClient({ accessToken: tokens.accessToken, instanceUrl: tokens.instanceUrl }, cfg, fetchImpl);
  let describes: ObjectDescribes;
  try {
    describes = await describeBoth(client);
  } catch (err) {
    log.warn({ err: (err as Error).message, orgId: flow.orgId }, 'salesforce describe failed after connect');
    return 'describe_failed';
  }
  // Reconnecting the same Salesforce org keeps the admin's field-map edits.
  const existing = await loadConnection(db, flow.orgId);
  const kept = existing && existing.sfOrgId === tokens.sfOrgId ? FieldMap.safeParse(existing.fieldMap) : null;
  await saveConnection(db, {
    orgId: flow.orgId,
    userId: flow.userId,
    instanceUrl: tokens.instanceUrl,
    sfOrgId: tokens.sfOrgId,
    sfUserId: tokens.sfUserId,
    sfUsername: await usernameOf(client, tokens.sfUserId, log),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    fieldMap: kept?.success ? kept.data : defaultFieldMap(describes),
  });
  return null;
}

export async function registerConnectionRoutes(app: FastifyInstance, deps: ConnectionRouteDeps): Promise<void> {
  const { db, cfg } = deps;

  app.get('/connections/salesforce', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    return toStatus(cfg, await loadConnection(db, ctx.orgId));
  });

  app.post('/connections/salesforce/start', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply) || salesforceDisabled(cfg, reply)) return;
    const states = schema.crmOauthStates;
    await db.delete(states).where(and(eq(states.orgId, ctx.orgId), lt(states.createdAt, new Date(Date.now() - OAUTH_STATE_TTL_MS))));
    const { verifier, challenge } = pkcePair();
    const state = randomToken(24);
    await db.insert(states).values({ orgId: ctx.orgId, userId: ctx.session.userId, state, codeVerifier: verifier });
    reply.setCookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: CALLBACK_PATH, maxAge: OAUTH_STATE_TTL_MS / 1000 });
    return { url: buildAuthorizeUrl(salesforceOAuthConfig(cfg), { state, codeChallenge: challenge }) } satisfies StartConnectionResponse;
  });

  // A top-level browser redirect from Salesforce: no bearer, and every exit is a redirect to the Connections page.
  app.get('/connections/salesforce/callback', async (req, reply) => {
    const back = (params: Record<string, string>) => settingsRedirect(cfg, reply, params);
    const cookieState = req.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, { path: CALLBACK_PATH });
    if (!cfg.salesforceEnabled) return back({ error: 'salesforce_disabled' });
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success || !cookieState || !constantTimeEquals(cookieState, q.data.state)) return back({ error: 'bad_state' });
    // Single use: consumed before anything else happens with it.
    const [flow] = await db.delete(schema.crmOauthStates).where(eq(schema.crmOauthStates.state, q.data.state)).returning();
    if (!flow || flow.state !== q.data.state || Date.now() - flow.createdAt.getTime() > OAUTH_STATE_TTL_MS) return back({ error: 'bad_state' });
    if (q.data.error || !q.data.code) return back({ error: q.data.error === 'access_denied' ? 'access_denied' : 'missing_code' });
    try {
      const error = await completeConnect(deps, flow, q.data.code, req.log);
      return back(error ? { error } : { connected: '1' });
    } catch (err) {
      req.log.error({ err, orgId: flow.orgId }, 'salesforce connect failed');
      return back({ error: 'server_error' });
    }
  });

  app.put('/connections/salesforce/field-map', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply) || salesforceDisabled(cfg, reply)) return;
    const body = FieldMap.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid field map', body.error.flatten());
    const badNames = fieldMapProblems(body.data);
    if (badNames.length > 0) return sendError(reply, 422, 'INVALID_FIELD_MAP', 'Some field names are not valid', { problems: badNames });
    let describes: ObjectDescribes;
    try {
      describes = await describeBoth(await deps.clients(ctx.orgId));
    } catch (err) {
      return sendCrmError(reply, err);
    }
    const missing = fieldMapProblems(body.data, describes);
    if (missing.length > 0) return sendError(reply, 422, 'INVALID_FIELD_MAP', 'Some fields do not exist in Salesforce', { problems: missing });
    const row = await saveFieldMap(db, ctx.orgId, body.data);
    if (!row) return sendError(reply, 409, 'CRM_NOT_CONNECTED', CRM_NOT_CONNECTED_MESSAGE);
    return toStatus(cfg, row);
  });

  // Works even without Salesforce env: forgetting stored tokens is always allowed.
  app.delete('/connections/salesforce', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    await deleteConnection(db, ctx.orgId);
    return reply.code(204).send();
  });
}

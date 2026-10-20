/**
 * Sam's email switch for the tenant (admins only): whether Sam may email sellers at all, whether the server can
 * (`configured`: Resend is set up AND Sam has a writer, an Anthropic key and a priced EMAIL_MODEL), and the pause a
 * spam complaint puts on it (email/pause.ts). Turning it on clears a pause (an admin has looked into the complaint);
 * it cannot be turned on while the server is not configured, since Sam could neither draft nor send (the seller page
 * says not_configured on the same test). Turning it off always works and keeps a pause.
 *
 * The switch lives in `organizations.settings.samEmail`, written by one UPDATE (setSamEmailEnabled) that keeps
 * every other setting. Logs: the tenant id and the new value.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { SamEmailSettingsSave, type SamEmailSettings } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { AppConfig } from '../config.js';
import { setSamEmailEnabled } from '../email/pause.js';
import { samEmailConfigured, type EmailWriter } from '../email/writer.js';
import { sendError } from '../http/errors.js';
import { samEmailSettings } from '../settings.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

export interface SamEmailSettingsRouteDeps {
  db: Db;
  cfg: Pick<AppConfig, 'emailEnabled'>;
  /** Sam's email writer; null when there is no Anthropic key or EMAIL_MODEL has no price (then not configured). */
  writer: EmailWriter | null;
}

export const EMAIL_NOT_CONFIGURED_WORDS =
  "Sam's email is not set up on this server yet (Resend, and an Anthropic key with a priced EMAIL_MODEL). Ask whoever runs the server to add it, then turn it on.";

export async function registerSamEmailSettingsRoutes(app: FastifyInstance, deps: SamEmailSettingsRouteDeps): Promise<void> {
  const { db, cfg } = deps;
  const configured = samEmailConfigured(cfg, deps.writer);
  const settingsOf = (blob: unknown): SamEmailSettings => ({ ...samEmailSettings({ settings: blob }), configured });

  app.get('/settings/sam-email', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    return settingsOf(ctx.tenant.settings);
  });

  app.put('/settings/sam-email', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return reply;
    const body = SamEmailSettingsSave.safeParse(req.body ?? null);
    if (!body.success) return sendError(reply, 400, 'INVALID_BODY', 'Say whether Sam may email: enabled true or false.');
    if (body.data.enabled && !configured) return sendError(reply, 409, 'EMAIL_NOT_CONFIGURED', EMAIL_NOT_CONFIGURED_WORDS);
    await setSamEmailEnabled(db, { orgId: ctx.orgId, enabled: body.data.enabled });
    req.log.info({ orgId: ctx.orgId, enabled: body.data.enabled }, 'sam email switched');
    const saved = (await db.execute(sql`select settings from organizations where id = ${ctx.orgId}::uuid`)) as unknown as { rows: Array<{ settings: unknown }> };
    return settingsOf(saved.rows[0]?.settings);
  });
}

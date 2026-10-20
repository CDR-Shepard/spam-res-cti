/**
 * Sam's email switch for the tenant (admins only): whether Sam may email sellers at all, whether the server has
 * Resend set up (`configured`), and the pause a spam complaint puts on it (email/pause.ts). Turning it on clears
 * a pause (an admin has looked into the complaint); it cannot be turned on while the server has no Resend setup,
 * since nothing could be sent. Turning it off always works and keeps a pause.
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
import { sendError } from '../http/errors.js';
import { samEmailSettings } from '../settings.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

export interface SamEmailSettingsRouteDeps {
  db: Db;
  cfg: Pick<AppConfig, 'emailEnabled'>;
}

export const EMAIL_NOT_CONFIGURED_WORDS = "Sam's email is not set up on this server yet (Resend). Ask whoever runs the server to add it, then turn it on.";

export async function registerSamEmailSettingsRoutes(app: FastifyInstance, deps: SamEmailSettingsRouteDeps): Promise<void> {
  const { db, cfg } = deps;
  const settingsOf = (blob: unknown): SamEmailSettings => ({ ...samEmailSettings({ settings: blob }), configured: cfg.emailEnabled });

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
    if (body.data.enabled && !cfg.emailEnabled) return sendError(reply, 409, 'EMAIL_NOT_CONFIGURED', EMAIL_NOT_CONFIGURED_WORDS);
    await setSamEmailEnabled(db, { orgId: ctx.orgId, enabled: body.data.enabled });
    req.log.info({ orgId: ctx.orgId, enabled: body.data.enabled }, 'sam email switched');
    const saved = (await db.execute(sql`select settings from organizations where id = ${ctx.orgId}::uuid`)) as unknown as { rows: Array<{ settings: unknown }> };
    return settingsOf(saved.rows[0]?.settings);
  });
}

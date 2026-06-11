/**
 * Admin routes — outbound numbers, opt-outs, blocklist, campaign config.
 * MVP: every authenticated user can manage their own org. Tighten with roles later.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { loadConfig } from '../config.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ---- outbound numbers ----
  app.get('/admin/outbound-numbers', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.outboundNumbers)
      .where(eq(schema.outboundNumbers.orgId, s.orgId))
      .orderBy(desc(schema.outboundNumbers.createdAt));
    return { numbers: rows };
  });

  app.post('/admin/outbound-numbers', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = z
      .object({
        e164: z.string(),
        label: z.string().optional(),
        provider: z.enum(['twilio', 'telnyx']).default(loadConfig().TELEPHONY_PROVIDER),
        active: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const norm = normalize(parsed.data.e164);
    if (!norm.ok) return reply.code(400).send({ error: 'Invalid number' });
    const db = getDb();
    const [row] = await db
      .insert(schema.outboundNumbers)
      .values({
        orgId: s.orgId,
        e164: norm.value!.e164,
        label: parsed.data.label,
        provider: parsed.data.provider,
        active: parsed.data.active ?? true,
        health: 'unknown',
      })
      .onConflictDoUpdate({
        target: [schema.outboundNumbers.orgId, schema.outboundNumbers.e164],
        set: { label: parsed.data.label ?? null, active: parsed.data.active ?? true },
      })
      .returning();
    return { number: row };
  });

  app.patch('/admin/outbound-numbers/:id', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const id = (req.params as { id: string }).id;
    const parsed = z
      .object({
        active: z.boolean().optional(),
        label: z.string().optional(),
        health: z.enum(['healthy', 'warning', 'degraded', 'spam_likely', 'unknown']).optional(),
        inboundEnabled: z.boolean().optional(),
        inboundGreeting: z.string().max(800).nullable().optional(),
        inboundMatchedGreeting: z.string().max(800).nullable().optional(),
        inboundRecordSeconds: z.number().int().min(10).max(600).optional(),
        inboundTranscribe: z.boolean().optional(),
        inboundForwardToE164: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const owned = await db.query.outboundNumbers.findFirst({
      where: and(eq(schema.outboundNumbers.id, id), eq(schema.outboundNumbers.orgId, s.orgId)),
    });
    if (!owned) return reply.code(404).send({ error: 'Not found' });
    const [row] = await db
      .update(schema.outboundNumbers)
      .set({
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.health
          ? { health: parsed.data.health, healthUpdatedAt: new Date() }
          : {}),
        ...(parsed.data.inboundEnabled !== undefined ? { inboundEnabled: parsed.data.inboundEnabled } : {}),
        ...(parsed.data.inboundGreeting !== undefined ? { inboundGreeting: parsed.data.inboundGreeting } : {}),
        ...(parsed.data.inboundMatchedGreeting !== undefined ? { inboundMatchedGreeting: parsed.data.inboundMatchedGreeting } : {}),
        ...(parsed.data.inboundRecordSeconds !== undefined ? { inboundRecordSeconds: parsed.data.inboundRecordSeconds } : {}),
        ...(parsed.data.inboundTranscribe !== undefined ? { inboundTranscribe: parsed.data.inboundTranscribe } : {}),
        ...(parsed.data.inboundForwardToE164 !== undefined ? { inboundForwardToE164: parsed.data.inboundForwardToE164 } : {}),
      })
      .where(eq(schema.outboundNumbers.id, id))
      .returning();
    if (parsed.data.health) {
      await db.insert(schema.numberHealthSnapshots).values({
        outboundNumberId: id,
        health: parsed.data.health,
        source: 'manual',
      });
    }
    return { number: row };
  });

  /**
   * Register the Twilio webhook on the underlying carrier number so inbound
   * calls hit our /telephony/twilio/inbound endpoint. Idempotent — safe to call
   * any time the tunnel URL changes. Caller must supply twilioSid (PN…) since
   * we don't store the SID on outbound_numbers yet.
   */
  app.post('/admin/outbound-numbers/:id/register-twilio-inbound', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const id = (req.params as { id: string }).id;
    const parsed = z.object({ twilioSid: z.string().regex(/^PN[a-f0-9]{32}$/i) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const cfg = loadConfig();
    const owned = await db.query.outboundNumbers.findFirst({
      where: and(eq(schema.outboundNumbers.id, id), eq(schema.outboundNumbers.orgId, s.orgId)),
    });
    if (!owned) return reply.code(404).send({ error: 'Number not found' });
    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) {
      return reply.code(503).send({ error: 'Twilio not configured' });
    }
    const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound`;
    const body = new URLSearchParams({
      VoiceUrl: url,
      VoiceMethod: 'POST',
    });
    const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${parsed.data.twilioSid}.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      app.log.warn({ status: res.status, data, twilioSid: parsed.data.twilioSid }, 'twilio_number_patch_failed');
      const safeCode = (data as { code?: number; status?: number })?.code;
      return reply.code(502).send({ error: 'Twilio update failed', code: safeCode ?? null });
    }
    return { ok: true, voiceUrl: url, twilio: { sid: (data as { sid?: string }).sid } };
  });

  // ---- opt-outs ----
  app.get('/admin/opt-outs', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.optOuts)
      .where(eq(schema.optOuts.orgId, s.orgId))
      .orderBy(desc(schema.optOuts.createdAt))
      .limit(500);
    return { optOuts: rows };
  });

  app.post('/admin/opt-outs', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = z
      .object({ e164: z.string(), source: z.string().default('manual'), note: z.string().optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const norm = normalize(parsed.data.e164);
    if (!norm.ok) return reply.code(400).send({ error: 'Invalid number' });
    const db = getDb();
    const [row] = await db
      .insert(schema.optOuts)
      .values({
        orgId: s.orgId,
        e164: norm.value!.e164,
        source: parsed.data.source,
        note: parsed.data.note,
      })
      .onConflictDoNothing()
      .returning();
    return { optOut: row ?? null };
  });

  // ---- blocked numbers ----
  app.get('/admin/blocked', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.blockedNumbers)
      .where(eq(schema.blockedNumbers.orgId, s.orgId))
      .orderBy(desc(schema.blockedNumbers.createdAt))
      .limit(500);
    return { blocked: rows };
  });

  app.post('/admin/blocked', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = z.object({ e164: z.string(), reason: z.string().optional() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const norm = normalize(parsed.data.e164);
    if (!norm.ok) return reply.code(400).send({ error: 'Invalid number' });
    const db = getDb();
    const [row] = await db
      .insert(schema.blockedNumbers)
      .values({ orgId: s.orgId, e164: norm.value!.e164, reason: parsed.data.reason })
      .onConflictDoNothing()
      .returning();
    return { blocked: row ?? null };
  });

  // ---- audits ----
  app.get('/admin/audits', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.preCallAudits)
      .where(eq(schema.preCallAudits.orgId, s.orgId))
      .orderBy(desc(schema.preCallAudits.createdAt))
      .limit(100);
    return { audits: rows };
  });

  // ---- campaign configs ----
  app.get('/admin/campaigns', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.campaignConfigs)
      .where(eq(schema.campaignConfigs.orgId, s.orgId));
    return { campaigns: rows };
  });

  app.patch('/admin/campaigns/:key', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const key = (req.params as { key: string }).key;
    const parsed = z
      .object({
        paused: z.boolean().optional(),
        maxAttempts: z.number().int().positive().optional(),
        attemptWindowDays: z.number().int().positive().optional(),
        callingHoursStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        callingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        callingDays: z.array(z.number().int().min(1).max(7)).optional(),
        recordingConsentMode: z.enum(['one_party', 'two_party', 'off']).optional(),
        requiredScriptId: z.string().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const [row] = await db
      .update(schema.campaignConfigs)
      .set({
        ...(parsed.data.paused !== undefined ? { paused: parsed.data.paused } : {}),
        ...(parsed.data.maxAttempts !== undefined ? { maxAttempts: parsed.data.maxAttempts } : {}),
        ...(parsed.data.attemptWindowDays !== undefined
          ? { attemptWindowDays: parsed.data.attemptWindowDays }
          : {}),
        ...(parsed.data.callingHoursStart ? { callingHoursStart: parsed.data.callingHoursStart } : {}),
        ...(parsed.data.callingHoursEnd ? { callingHoursEnd: parsed.data.callingHoursEnd } : {}),
        ...(parsed.data.callingDays ? { callingDays: parsed.data.callingDays } : {}),
        ...(parsed.data.recordingConsentMode
          ? { recordingConsentMode: parsed.data.recordingConsentMode }
          : {}),
        ...(parsed.data.requiredScriptId !== undefined
          ? { requiredScriptId: parsed.data.requiredScriptId }
          : {}),
      })
      .where(and(eq(schema.campaignConfigs.orgId, s.orgId), eq(schema.campaignConfigs.key, key)))
      .returning();
    if (!row) return reply.code(404).send({ error: 'Campaign not found' });
    return { campaign: row };
  });
}

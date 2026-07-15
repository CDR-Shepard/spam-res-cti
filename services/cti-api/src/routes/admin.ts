/**
 * Admin routes — outbound numbers, opt-outs, blocklist, campaign config.
 * MVP: every authenticated user can manage their own org. Tighten with roles later.
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { loadConfig } from '../config.js';

/** Human-readable label for an imported DID, derived from its area code so the
 *  Numbers pool reads "San Diego (619)" / "Los Angeles (213)" at a glance. */
const SD_AREA_CODES = new Set(['619', '858', '760']);
const LA_AREA_CODES = new Set(['213', '323', '310', '818', '424', '747']);
function labelForImportedNumber(e164: string): string {
  const areaCode = e164.match(/^\+1(\d{3})/)?.[1];
  if (!areaCode) return 'Imported';
  if (SD_AREA_CODES.has(areaCode)) return `San Diego (${areaCode})`;
  if (LA_AREA_CODES.has(areaCode)) return `Los Angeles (${areaCode})`;
  return `(${areaCode})`;
}

/**
 * Point a Twilio number's Voice webhook at our inbound handler so callbacks reach
 * us (answer + record voicemail) instead of erroring on the number's old/default
 * config. Best-effort — returns false and logs on any failure. Idempotent.
 */
async function setTwilioInboundVoiceUrl(
  cfg: ReturnType<typeof loadConfig>,
  twilioSid: string,
  log: { warn: (obj: unknown, msg?: string) => void },
): Promise<boolean> {
  if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) return false;
  const url = `${cfg.API_PUBLIC_URL}/telephony/twilio/inbound`;
  const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers/${twilioSid}.json`,
      {
        method: 'POST',
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ VoiceUrl: url, VoiceMethod: 'POST' }).toString(),
      },
    );
    if (!res.ok) {
      log.warn({ status: res.status, twilioSid }, 'twilio_voiceurl_patch_failed');
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err, twilioSid }, 'twilio_voiceurl_patch_error');
    return false;
  }
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ---- outbound numbers ----
  app.get('/admin/outbound-numbers', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    // Admins see the whole org pool (active + reserve); reps see only the
    // numbers assigned to them (powers their dialer from-picker).
    const where = s.isAdmin
      ? eq(schema.outboundNumbers.orgId, s.orgId)
      : and(
          eq(schema.outboundNumbers.orgId, s.orgId),
          eq(schema.outboundNumbers.assignedUserId, s.userId),
        );
    const rows = await db
      .select()
      .from(schema.outboundNumbers)
      .where(where)
      .orderBy(desc(schema.outboundNumbers.createdAt));
    return { numbers: rows };
  });

  // Reps in this org (for the admin's assign-number dropdown).
  app.get('/admin/reps', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const db = getDb();
    const rows = await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        isAdmin: schema.users.isAdmin,
      })
      .from(schema.users)
      .where(eq(schema.users.orgId, s.orgId));
    return { reps: rows };
  });

  app.post('/admin/outbound-numbers', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const parsed = z
      .object({
        e164: z.string(),
        label: z.string().optional(),
        provider: z.enum(['twilio', 'telnyx']).default(loadConfig().TELEPHONY_PROVIDER),
        active: z.boolean().optional(),
        // The rep to assign to; omit / null = leave in the reserve pool.
        assignedUserId: z.string().uuid().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const norm = normalize(parsed.data.e164);
    if (!norm.ok) return reply.code(400).send({ error: 'Invalid number' });
    const db = getDb();
    if (parsed.data.assignedUserId) {
      const rep = await db.query.users.findFirst({
        where: and(eq(schema.users.id, parsed.data.assignedUserId), eq(schema.users.orgId, s.orgId)),
      });
      if (!rep) return reply.code(400).send({ error: 'assignedUserId is not a user in this org' });
    }
    const [row] = await db
      .insert(schema.outboundNumbers)
      .values({
        orgId: s.orgId,
        e164: norm.value!.e164,
        label: parsed.data.label,
        provider: parsed.data.provider,
        active: parsed.data.active ?? true,
        assignedUserId: parsed.data.assignedUserId ?? null,
        health: 'unknown',
      })
      .onConflictDoUpdate({
        target: [schema.outboundNumbers.orgId, schema.outboundNumbers.e164],
        set: {
          label: parsed.data.label ?? null,
          active: parsed.data.active ?? true,
          ...(parsed.data.assignedUserId !== undefined ? { assignedUserId: parsed.data.assignedUserId } : {}),
        },
      })
      .returning();
    return { number: row };
  });

  app.patch('/admin/outbound-numbers/:id', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const id = (req.params as { id: string }).id;
    const parsed = z
      .object({
        active: z.boolean().optional(),
        label: z.string().optional(),
        // Assign to a rep, or null to return it to the reserve pool.
        assignedUserId: z.string().uuid().nullable().optional(),
        kind: z.enum(['agent', 'dialer_pool']).optional(),
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
    if (parsed.data.assignedUserId) {
      const rep = await db.query.users.findFirst({
        where: and(eq(schema.users.id, parsed.data.assignedUserId), eq(schema.users.orgId, s.orgId)),
      });
      if (!rep) return reply.code(400).send({ error: 'assignedUserId is not a user in this org' });
    }
    const [row] = await db
      .update(schema.outboundNumbers)
      .set({
        ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.assignedUserId !== undefined ? { assignedUserId: parsed.data.assignedUserId } : {}),
        ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
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
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
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

  /**
   * One-click import: pull every phone number this org owns in Twilio and fully
   * provision it — add to the pool (reserve, unassigned), enable inbound, and
   * point its Twilio Voice webhook at our inbound handler so callbacks are
   * answered (voicemail) instead of erroring. Idempotent — re-running refreshes
   * the SID + re-registers the webhook and never clobbers an existing
   * label/active/assignment. New numbers get an area-code-derived label.
   */
  app.post('/admin/outbound-numbers/import-twilio', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const cfg = loadConfig();
    if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) {
      return reply
        .code(503)
        .send({ error: 'Twilio not configured (need TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)' });
    }
    const auth = Buffer.from(`${cfg.TWILIO_ACCOUNT_SID}:${cfg.TWILIO_AUTH_TOKEN}`).toString('base64');

    interface TwilioNumber {
      phone_number?: string;
      friendly_name?: string;
      sid?: string;
    }
    const owned: TwilioNumber[] = [];
    let next: string | null =
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.TWILIO_ACCOUNT_SID}/IncomingPhoneNumbers.json?PageSize=1000`;
    // Follow Twilio's paging (next_page_uri); guard against runaway loops.
    for (let page = 0; next && page < 25; page += 1) {
      const res = await fetch(next, { headers: { authorization: `Basic ${auth}` } });
      if (!res.ok) {
        app.log.warn({ status: res.status }, 'twilio_list_numbers_failed');
        return reply.code(502).send({ error: 'Could not list Twilio numbers', status: res.status });
      }
      const page_data = (await res.json()) as {
        incoming_phone_numbers?: TwilioNumber[];
        next_page_uri?: string | null;
      };
      owned.push(...(page_data.incoming_phone_numbers ?? []));
      next = page_data.next_page_uri ? `https://api.twilio.com${page_data.next_page_uri}` : null;
    }

    const db = getDb();
    let registered = 0;
    let skipped = 0;
    let inboundWebhooksSet = 0;
    for (const n of owned) {
      const norm = n.phone_number ? normalize(n.phone_number) : { ok: false as const };
      if (!norm.ok || !norm.value) {
        skipped += 1;
        continue;
      }
      await db
        .insert(schema.outboundNumbers)
        .values({
          orgId: s.orgId,
          e164: norm.value.e164,
          label: labelForImportedNumber(norm.value.e164),
          provider: 'twilio',
          active: true,
          twilioSid: n.sid ?? null,
          health: 'unknown',
          inboundEnabled: true,
        })
        .onConflictDoUpdate({
          target: [schema.outboundNumbers.orgId, schema.outboundNumbers.e164],
          // Refresh the carrier SID/provider and (re-)enable inbound, but
          // preserve any label, active flag, and rep assignment the admin set.
          set: { twilioSid: n.sid ?? null, provider: 'twilio', inboundEnabled: true },
        });
      registered += 1;
      // Point the number's Voice webhook at our inbound handler so callbacks
      // are answered. Best-effort — a webhook failure never aborts the import.
      if (n.sid && (await setTwilioInboundVoiceUrl(cfg, n.sid, app.log))) {
        inboundWebhooksSet += 1;
      }
    }
    return { ok: true, found: owned.length, registered, skipped, inboundWebhooksSet };
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

  // ---- calls (actual placed/received call records) ----
  // Admin-only, org-scoped call log. Optional ?userId= filters to one rep.
  app.get('/admin/calls', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const q = z
      .object({
        userId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500),
      })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.flatten() });
    const db = getDb();
    const where = q.data.userId
      ? and(eq(schema.calls.orgId, s.orgId), eq(schema.calls.userId, q.data.userId))
      : eq(schema.calls.orgId, s.orgId);
    const rows = await db
      .select({
        id: schema.calls.id,
        userId: schema.calls.userId,
        direction: schema.calls.direction,
        fromNumber: schema.calls.fromNumber,
        toNumber: schema.calls.toNumber,
        normalizedToNumber: schema.calls.normalizedToNumber,
        status: schema.calls.status,
        disposition: schema.calls.disposition,
        durationSeconds: schema.calls.durationSeconds,
        startedAt: schema.calls.startedAt,
        endedAt: schema.calls.endedAt,
        createdAt: schema.calls.createdAt,
        salesforceTaskId: schema.calls.salesforceTaskId,
      })
      .from(schema.calls)
      .where(where)
      .orderBy(desc(schema.calls.createdAt))
      .limit(q.data.limit);
    return { calls: rows };
  });

  // One-time (idempotent) reconciliation: backfill each call's duration from the
  // authoritative Twilio status-callback body we already stored, fixing rows
  // where the client wrap-up timer had overwritten it. Admin-only, org-scoped.
  app.post('/admin/calls/reconcile-durations', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const db = getDb();
    const rows = await db
      .select({ id: schema.calls.id, providerCallId: schema.calls.providerCallId })
      .from(schema.calls)
      .where(eq(schema.calls.orgId, s.orgId))
      .limit(5000);
    let scanned = 0;
    let updated = 0;
    for (const c of rows) {
      if (!c.providerCallId) continue;
      scanned += 1;
      // The real duration lives in the stored status-callback bodies, keyed by
      // CallSid or ParentCallSid (child-leg callbacks carry the parent sid).
      const events = await db
        .select({ body: schema.providerWebhookEvents.body })
        .from(schema.providerWebhookEvents)
        .where(sql`(body->>'CallSid' = ${c.providerCallId} or body->>'ParentCallSid' = ${c.providerCallId})`);
      let dur: number | null = null;
      for (const e of events) {
        const b = (e.body ?? {}) as Record<string, unknown>;
        const d = Number(b.CallDuration ?? b.DialCallDuration);
        if (Number.isFinite(d)) dur = Math.max(dur ?? 0, d);
      }
      if (dur != null) {
        await db
          .update(schema.calls)
          .set({ durationSeconds: dur, updatedAt: new Date() })
          .where(eq(schema.calls.id, c.id));
        updated += 1;
      }
    }
    return { ok: true, scanned, updated };
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
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
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

  // ---- DNC import ----
  // Bulk-load Do-Not-Call numbers into the cache the firewall's `federal_dnc`
  // gate checks. Feed it whatever list you legitimately obtain — your National
  // DNC Registry export (per area code, via your SAN) or a paid scrub vendor.
  // NOTE: this is NOT the FTC "DNC reported calls" complaint dataset — that's
  // consumer complaints, not a scrub list, and must not be used for compliance.
  app.post('/admin/dnc/import', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const parsed = z
      .object({
        numbers: z.array(z.string()).min(1).max(100000),
        source: z.string().max(64).default('federal_dnc'),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const rows = parsed.data.numbers
      .map((raw) => normalize(raw))
      .filter((n) => n.ok && n.value)
      .map((n) => ({ e164: n.value!.e164, source: parsed.data.source }));
    if (rows.length === 0) return reply.code(400).send({ error: 'No valid numbers' });
    const db = getDb();
    let inserted = 0;
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const res = await db
        .insert(schema.federalDncEntries)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoNothing()
        .returning({ e164: schema.federalDncEntries.e164 });
      inserted += res.length;
    }
    return { ok: true, received: parsed.data.numbers.length, valid: rows.length, inserted };
  });

  // ---- DNC compliance mode ----
  // 'registry' = check numbers against the loaded DNC cache; 'external_prescrubbed'
  // = org attests lists are scrubbed offline (gate shows green "pre-scrubbed list
  // (org policy)"; a number in a loaded cache still blocks).
  app.get('/admin/dnc-mode', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const db = getDb();
    const org = await db.query.organizations.findFirst({
      where: eq(schema.organizations.id, s.orgId),
      columns: { dncMode: true },
    });
    return { mode: org?.dncMode ?? 'registry' };
  });

  app.patch('/admin/dnc-mode', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const parsed = z.object({ mode: z.enum(['registry', 'external_prescrubbed']) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    await db
      .update(schema.organizations)
      .set({ dncMode: parsed.data.mode })
      .where(eq(schema.organizations.id, s.orgId));
    return { ok: true, mode: parsed.data.mode };
  });

  /**
   * Testing utility — clear this org's call history to a specific number so the
   * firewall's per-recipient attempt counter (a rolling COUNT of calls in the
   * window, not a stored field) resets to 0. Lets you re-test against your own
   * number without tripping the attempt-limit cap. Admin-only, org-scoped;
   * cascades to sync jobs / events.
   */
  app.post('/admin/calls/clear-recipient', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const parsed = z.object({ e164: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const norm = normalize(parsed.data.e164);
    if (!norm.ok || !norm.value) return reply.code(400).send({ error: 'Invalid number' });
    const db = getDb();
    const deleted = await db
      .delete(schema.calls)
      .where(
        and(
          eq(schema.calls.orgId, s.orgId),
          eq(schema.calls.normalizedToNumber, norm.value.e164),
        ),
      )
      .returning({ id: schema.calls.id });
    return { ok: true, e164: norm.value.e164, cleared: deleted.length };
  });
}

/**
 * Third-party reputation integrations.
 *
 *   POST /integrations/numberverifier/webhook
 *     NumberVerifier (app.numberverifier.com) POSTs here whenever one of your
 *     monitored DIDs is checked. We translate the carrier-flag result into the
 *     DID's health so a flagged number is pulled from rotation and blocked by
 *     the firewall in real time. Authenticated by the shared `x-verifykey`
 *     header secret you set on the NumberVerifier Webhooks page.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import { loadConfig } from '../config.js';
import { normalize } from '../phone.js';
import { dispatchAlert } from '../alerts.js';
import { classifyNumberVerifier, type NumberVerifierPayload } from '../integrations/numberverifier.js';

const HEALTH_SOURCE = 'numberverifier';

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const Payload = z
  .object({
    phone: z.string().optional(),
    flag_status: z.union([z.boolean(), z.string(), z.number()]).nullish(),
    errors: z.union([z.string(), z.array(z.string())]).nullish(),
    checks: z.array(z.record(z.unknown())).nullish(),
  })
  .passthrough();

export async function registerIntegrationRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();

  app.post('/integrations/numberverifier/webhook', async (req, reply) => {
    // The integration is opt-in: without a configured verify key the route is
    // disabled so a misconfiguration can never accept unauthenticated health
    // changes to outbound numbers.
    if (!cfg.NUMBERVERIFIER_VERIFY_KEY) {
      return reply.code(503).send({ error: 'NumberVerifier integration not configured' });
    }
    const headerKey = req.headers['x-verifykey'];
    const provided = Array.isArray(headerKey) ? headerKey[0] : headerKey;
    if (!provided || !constantTimeEqual(provided, cfg.NUMBERVERIFIER_VERIFY_KEY)) {
      return reply.code(401).send({ error: 'Invalid x-verifykey' });
    }

    const parsed = Payload.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const payload = parsed.data as NumberVerifierPayload;

    // Normalize the phone to E.164 so it matches our outbound_numbers rows
    // regardless of the format NumberVerifier sends.
    const norm = payload.phone ? normalize(payload.phone) : { ok: false as const };
    if (!norm.ok || !norm.value) {
      // Ack so NumberVerifier doesn't retry; we just can't match this number.
      return reply.send({ ok: true, ignored: 'unparseable_or_missing_phone' });
    }
    const e164 = norm.value.e164;

    const cls = classifyNumberVerifier(payload);
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.outboundNumbers)
      .where(eq(schema.outboundNumbers.e164, e164));

    let changed = 0;
    for (const did of rows) {
      if (cls.flagged) {
        // Apply (or escalate) the carrier flag. Only act/alert when state
        // actually changes, so repeat checks of an already-flagged number don't
        // spam alerts.
        const already = did.health === cls.health && did.healthSource === HEALTH_SOURCE;
        if (already) continue;
        await db
          .update(schema.outboundNumbers)
          .set({ health: cls.health, healthSource: HEALTH_SOURCE, healthUpdatedAt: new Date() })
          .where(eq(schema.outboundNumbers.id, did.id));
        await db.insert(schema.numberHealthSnapshots).values({
          outboundNumberId: did.id,
          health: cls.health,
          source: HEALTH_SOURCE,
          details: { reasons: cls.reasons, flaggedCarriers: cls.flaggedCarriers, phone: e164 },
        });
        await dispatchAlert(app.log, {
          kind: 'analytics_block_detected',
          severity: cls.health === 'spam_likely' ? 'critical' : 'warning',
          orgId: did.orgId,
          message: `NumberVerifier flagged ${e164} (${cls.health}) — pulled from rotation: ${cls.reasons.join('; ')}`,
          context: { e164, health: cls.health, carriers: cls.flaggedCarriers, reasons: cls.reasons },
        });
        changed++;
      } else {
        // Clean result. Restore ONLY numbers that NumberVerifier itself paused —
        // never un-pause one the behavioral worker or a live analytics block set,
        // since those track concerns NumberVerifier's carrier-label check doesn't.
        const weParkedIt =
          (did.health === 'degraded' || did.health === 'spam_likely') && did.healthSource === HEALTH_SOURCE;
        if (!weParkedIt) continue;
        await db
          .update(schema.outboundNumbers)
          .set({ health: 'healthy', healthSource: HEALTH_SOURCE, healthUpdatedAt: new Date() })
          .where(eq(schema.outboundNumbers.id, did.id));
        await db.insert(schema.numberHealthSnapshots).values({
          outboundNumberId: did.id,
          health: 'healthy',
          source: HEALTH_SOURCE,
          details: { restored: true, phone: e164 },
        });
        await dispatchAlert(app.log, {
          kind: 'did_auto_paused',
          severity: 'info',
          orgId: did.orgId,
          message: `NumberVerifier cleared ${e164} — restored to rotation`,
          context: { e164 },
        });
        changed++;
      }
    }

    return reply.send({
      ok: true,
      phone: e164,
      flagged: cls.flagged,
      health: cls.health,
      matched: rows.length,
      changed,
    });
  });
}

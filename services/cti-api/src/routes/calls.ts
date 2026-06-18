/**
 * Call CRUD + state transitions.
 *
 *  POST /calls                  → create a call record (after firewall ALLOW + rep click)
 *  PATCH /calls/:id             → update status / disposition / notes
 *  POST /calls/:id/disposition  → end-of-call: notes/disposition + enqueue Salesforce sync
 *  GET /calls?limit=25          → recent calls for the rep
 *  GET /calls/:id
 */
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { normalize } from '../phone.js';
import { warmupCapForAge } from '../firewall/warmup.js';
import { enqueueSyncForCall } from '../salesforce/sync.js';
import { loadConfig } from '../config.js';

export async function registerCallRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();

  const Create = z.object({
    toNumber: z.string().min(1),
    fromNumber: z.string().optional(),
    auditId: z.string().uuid(),
    campaignKey: z.string().optional(),
    /**
     * Rep acknowledgement of a REQUIRE_REVIEW verdict. Without it, a
     * review-severity audit (unknown TZ, neighbor-spoof, missing consent,
     * state registration, two-party recording disclosure) cannot be dialed.
     */
    acknowledged: z.boolean().optional(),
  });

  app.post('/calls', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = Create.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const norm = normalize(parsed.data.toNumber);
    if (!norm.ok) return reply.code(400).send({ error: 'Invalid phone number' });

    const db = getDb();
    // The pre-call audit is the authority. Verify it is recent, decided, and
    // matches this rep/org/destination. The audit also pins the outbound DID
    // (fromNumberE164) the firewall evaluated its per-DID gates against — we
    // dial THAT number, never a fresh re-selection, so the verdict the rep saw
    // is the verdict for the number the call actually carries.
    const audit = await db.query.preCallAudits.findFirst({
      where: and(
        eq(schema.preCallAudits.id, parsed.data.auditId),
        eq(schema.preCallAudits.orgId, session.orgId),
        eq(schema.preCallAudits.userId, session.userId),
      ),
    });
    if (!audit) return reply.code(400).send({ error: 'Audit not found' });
    if (audit.decision === 'BLOCK')
      return reply.code(403).send({ error: 'Firewall blocked this call', blockReason: audit.blockReason });
    // REQUIRE_REVIEW verdicts must be explicitly acknowledged by the rep before
    // dialing; otherwise every review-severity gate (unknown TZ, neighbor-spoof,
    // missing consent, state registration, two-party recording disclosure) is
    // advisory only and silently bypassable at the API boundary.
    if (audit.decision === 'REQUIRE_REVIEW' && parsed.data.acknowledged !== true)
      return reply.code(412).send({
        error: 'Call requires review acknowledgement',
        decision: audit.decision,
        reasons: audit.reasons,
        requiredScriptId: audit.requiredScriptId,
      });
    if (audit.toNumberE164 !== norm.value!.e164)
      return reply.code(400).send({ error: 'Audit does not match destination number' });
    if (Date.now() - audit.createdAt.getTime() > 5 * 60 * 1000)
      return reply.code(400).send({ error: 'Audit expired (>5 min); re-run firewall' });

    // The outbound DID is whatever the firewall evaluated and pinned on the
    // audit — never a fresh rotation pick and never an unvetted client value.
    // If the client pinned a fromNumber it must agree with the audited DID.
    const fromNumber = audit.fromNumberE164;
    if (!fromNumber)
      return reply.code(409).send({ error: 'No outbound caller ID was approved by the firewall; re-run the check' });
    if (parsed.data.fromNumber && parsed.data.fromNumber !== fromNumber)
      return reply.code(409).send({
        error: 'Requested caller ID does not match the firewall-approved number; re-run the check',
        approved: fromNumber,
      });

    // Re-read the approved DID to compute its current warmup cap, then
    // atomically increment dials_today + the per-minute velocity counter ONLY
    // IF it is still active, healthy, under its daily cap, and under the 10/min
    // burst limit — all re-checked inside the same UPDATE so concurrent dials
    // can't push it over the cap (TOCTOU-safe). Zero rows updated => not
    // eligible, so the call is refused rather than silently burning the DID.
    const did = await db.query.outboundNumbers.findFirst({
      where: and(
        eq(schema.outboundNumbers.orgId, session.orgId),
        eq(schema.outboundNumbers.e164, fromNumber),
        eq(schema.outboundNumbers.assignedUserId, session.userId),
      ),
    });
    if (!did || !did.active)
      return reply.code(409).send({ error: 'Approved caller ID is not in your assigned pool; re-run the check' });
    const daysSince = did.firstUsedAt
      ? Math.floor((Date.now() - did.firstUsedAt.getTime()) / 86_400_000)
      : null;
    const effectiveCap = did.warmupOverrideCap ?? warmupCapForAge(daysSince).cap;

    const today = new Date().toISOString().slice(0, 10);
    const incremented = await db
      .update(schema.outboundNumbers)
      .set({
        firstUsedAt: sql`coalesce(${schema.outboundNumbers.firstUsedAt}, now())`,
        lastDialAt: new Date(),
        dialsTodayDate: today,
        dialsToday: sql`case when ${schema.outboundNumbers.dialsTodayDate} = ${today}::date then ${schema.outboundNumbers.dialsToday} + 1 else 1 end`,
        lastMinuteDialCount: sql`case when ${schema.outboundNumbers.lastMinuteWindowStart} is null or now() - ${schema.outboundNumbers.lastMinuteWindowStart} > interval '1 minute' then 1 else ${schema.outboundNumbers.lastMinuteDialCount} + 1 end`,
        lastMinuteWindowStart: sql`case when ${schema.outboundNumbers.lastMinuteWindowStart} is null or now() - ${schema.outboundNumbers.lastMinuteWindowStart} > interval '1 minute' then now() else ${schema.outboundNumbers.lastMinuteWindowStart} end`,
      })
      .where(
        and(
          eq(schema.outboundNumbers.orgId, session.orgId),
          eq(schema.outboundNumbers.e164, fromNumber),
          eq(schema.outboundNumbers.assignedUserId, session.userId),
          eq(schema.outboundNumbers.active, true),
          notInArray(schema.outboundNumbers.health, ['spam_likely', 'degraded']),
          sql`(case when ${schema.outboundNumbers.dialsTodayDate} = ${today}::date then ${schema.outboundNumbers.dialsToday} else 0 end) < ${effectiveCap}`,
          sql`(case when ${schema.outboundNumbers.lastMinuteWindowStart} is null or now() - ${schema.outboundNumbers.lastMinuteWindowStart} > interval '1 minute' then 0 else ${schema.outboundNumbers.lastMinuteDialCount} end) < 10`,
        ),
      )
      .returning({ id: schema.outboundNumbers.id });
    if (incremented.length === 0)
      return reply.code(429).send({
        error: 'Caller ID is at its warmup/velocity limit; pick another number or wait',
        fromNumber,
      });

    const [row] = await db
      .insert(schema.calls)
      .values({
        orgId: session.orgId,
        userId: session.userId,
        provider: cfg.TELEPHONY_PROVIDER,
        fromNumber,
        toNumber: parsed.data.toNumber,
        normalizedToNumber: norm.value!.e164,
        status: 'queued',
        preCallAuditId: audit.id,
        campaignKey: parsed.data.campaignKey ?? audit.campaignKey ?? null,
      })
      .returning();
    return { call: row };
  });

  app.get('/calls', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) }).safeParse(req.query);
    const limit = q.success ? q.data.limit : 25;
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.userId, session.userId))
      .orderBy(desc(schema.calls.createdAt))
      .limit(limit);
    return { calls: rows };
  });

  app.get('/calls/:id', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const id = (req.params as { id: string }).id;
    const db = getDb();
    const row = await db.query.calls.findFirst({
      where: and(eq(schema.calls.id, id), eq(schema.calls.userId, session.userId)),
    });
    if (!row) return reply.code(404).send({ error: 'Not found' });
    const events = await db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, id))
      .orderBy(desc(schema.callEvents.occurredAt));
    return { call: row, events };
  });

  const Patch = z.object({
    providerCallId: z.string().optional(),
    status: z
      .enum([
        'queued',
        'initiating',
        'ringing',
        'in_progress',
        'completed',
        'no_answer',
        'busy',
        'failed',
        'canceled',
      ])
      .optional(),
    startedAt: z.string().datetime().optional(),
    answeredAt: z.string().datetime().optional(),
    endedAt: z.string().datetime().optional(),
    durationSeconds: z.number().int().nonnegative().optional(),
  });

  app.patch('/calls/:id', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const id = (req.params as { id: string }).id;
    const parsed = Patch.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const owned = await db.query.calls.findFirst({
      where: and(eq(schema.calls.id, id), eq(schema.calls.userId, session.userId)),
    });
    if (!owned) return reply.code(404).send({ error: 'Not found' });

    const updates: Partial<typeof schema.calls.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.providerCallId !== undefined) updates.providerCallId = parsed.data.providerCallId;
    if (parsed.data.status) updates.status = parsed.data.status;
    if (parsed.data.startedAt) updates.startedAt = new Date(parsed.data.startedAt);
    if (parsed.data.answeredAt) updates.answeredAt = new Date(parsed.data.answeredAt);
    if (parsed.data.endedAt) updates.endedAt = new Date(parsed.data.endedAt);
    if (parsed.data.durationSeconds !== undefined) updates.durationSeconds = parsed.data.durationSeconds;

    const [row] = await db.update(schema.calls).set(updates).where(eq(schema.calls.id, id)).returning();
    return { call: row };
  });

  const Disposition = z.object({
    disposition: z.string().min(1).max(64),
    notes: z.string().max(8000).optional(),
    durationSeconds: z.number().int().nonnegative().optional(),
    /**
     * Set by the Salesforce Open CTI surface when it has already written the
     * Task via opencti.saveLog (attached to the exact click-to-dial record).
     * Prevents the backend sync from creating a SECOND, SOSL-matched Task for
     * the same call.
     */
    skipSalesforceSync: z.boolean().optional(),
    /**
     * The click-to-dial source record + its object type (Lead / Contact /
     * Opportunity / Deal__c / …). When Open CTI couldn't write the Task itself,
     * we hand the backend the exact record so it attaches the Task precisely
     * (Lead/Contact → WhoId, everything else → WhatId) instead of SOSL-guessing.
     */
    recipientRecordId: z.string().min(15).max(20).optional(),
    recipientObjectType: z.string().max(64).optional(),
  });

  app.post('/calls/:id/disposition', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const id = (req.params as { id: string }).id;
    const parsed = Disposition.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const owned = await db.query.calls.findFirst({
      where: and(eq(schema.calls.id, id), eq(schema.calls.userId, session.userId)),
    });
    if (!owned) return reply.code(404).send({ error: 'Not found' });
    const updates: Partial<typeof schema.calls.$inferInsert> = {
      disposition: parsed.data.disposition,
      notes: parsed.data.notes ?? owned.notes ?? null,
      updatedAt: new Date(),
    };
    if (parsed.data.durationSeconds !== undefined) updates.durationSeconds = parsed.data.durationSeconds;
    if (!owned.endedAt) updates.endedAt = new Date();
    if (owned.status !== 'completed') updates.status = 'completed';
    // Attach the click-to-dial record so the backend sync logs the Task to the
    // exact record: Lead/Contact → WhoId, Opportunity/Deal__c/etc. → WhatId.
    if (parsed.data.recipientRecordId && !owned.salesforceWhoId && !owned.salesforceWhatId) {
      const rid = parsed.data.recipientRecordId;
      const ot = (parsed.data.recipientObjectType ?? '').toLowerCase();
      // Prefer the explicit object type; if it's missing, fall back to the SF
      // ID key prefix (00Q = Lead, 003 = Contact) so a Lead/Contact record can
      // never be mis-attached as a WhatId.
      const isWho =
        ot === 'lead' || ot === 'contact' ||
        (!ot && (rid.startsWith('00Q') || rid.startsWith('003')));
      if (isWho) updates.salesforceWhoId = rid;
      else updates.salesforceWhatId = rid;
    }
    const [row] = await db.update(schema.calls).set(updates).where(eq(schema.calls.id, id)).returning();
    // Single-writer rule: if the Open CTI surface already saved the Task, don't
    // enqueue a backend sync — otherwise the call is logged twice in Salesforce.
    if (!parsed.data.skipSalesforceSync) {
      await enqueueSyncForCall(id);
      return { call: row, salesforceSync: 'queued' };
    }
    return { call: row, salesforceSync: 'skipped_client_logged' };
  });
}

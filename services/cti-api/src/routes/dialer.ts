/**
 * Power dialer session lifecycle + engine controls.
 *
 *  POST /dialer/sessions              → start a session over a Lead/Opportunity id list
 *  GET  /dialer/sessions/:id          → session + counts + the in-flight item (if any)
 *  POST /dialer/sessions/:id/pause    → pause (in-flight dial finishes; queue stops advancing)
 *  POST /dialer/sessions/:id/resume   → resume + immediately try to advance
 *  POST /dialer/sessions/:id/skip     → skip the in-flight item, then advance
 *  POST /dialer/sessions/:id/stop     → hang up + stop the session outright
 *  POST /dialer/sessions/:id/next     → rep-initiated "next" after a connected call
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { createDialerSession } from '../dialer/create-session.js';
import { pauseSession, resumeSession, skipCurrent, stopSession, repNext, type EngineDeps } from '../dialer/engine.js';
import { inFlightItem } from '../dialer/state.js';
import { sessionCounts } from '../dialer/session-store.js';
import { noopTelephony } from '../dialer/telephony-port.js';
import { dialerPoolNumbers } from '../dialer/pool.js';
import { rolloverFollowUp } from '../salesforce/followup.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { salesforceUserId } from '../salesforce/current-user.js';

// The POST /dialer/sessions body schema — pinned by src/routes/dialer.test.ts.
const StartBody = z.object({
  objectType: z.enum(['Lead', 'Opportunity']),
  recordIds: z.array(z.string().min(15).max(20)).min(1).max(500),
});

/** Real EngineDeps for a request. Telephony/screen-pop are wired by later plans. */
function buildEngineDeps(): EngineDeps {
  return {
    db: getDb(),
    telephony: noopTelephony,
    dialerPoolNumbers,
    rolloverFollowUp,
    onScreenPop: () => {}, // Plan 4 wires Open CTI screen-pop
    todayIso: new Date().toISOString().slice(0, 10), // Plan 3 refines to org tz
  };
}

/** Session by id, scoped to the caller — never leaks another rep's session. */
async function loadOwnedSession(
  db: ReturnType<typeof getDb>,
  id: string,
  userId: string,
): Promise<typeof schema.dialerSessions.$inferSelect | undefined> {
  return db.query.dialerSessions.findFirst({
    where: and(eq(schema.dialerSessions.id, id), eq(schema.dialerSessions.userId, userId)),
  });
}

type AuthedUser = NonNullable<Awaited<ReturnType<typeof resolveSession>>>;

/**
 * Shared auth + ownership gate for the `/dialer/sessions/:id*` routes: resolves
 * the bearer session, loads the `:id` session scoped to that caller, and sends
 * the 401/404 itself on failure. Returns null when the caller should stop
 * (the reply has already been sent); otherwise returns the resolved pieces.
 */
async function requireOwnedSession(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ authed: AuthedUser; session: typeof schema.dialerSessions.$inferSelect } | null> {
  const authed = await resolveSession(req.headers.authorization);
  if (!authed) {
    await reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  const id = (req.params as { id: string }).id;
  const db = getDb();
  const session = await loadOwnedSession(db, id, authed.userId);
  if (!session) {
    await reply.code(404).send({ error: 'Not found' });
    return null;
  }
  return { authed, session };
}

export async function registerDialerRoutes(app: FastifyInstance): Promise<void> {
  app.post('/dialer/sessions', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const db = getDb();
    const result = await createDialerSession(
      { resolveDialNumber, salesforceUserId, db },
      {
        userId: authed.userId,
        orgId: authed.orgId,
        objectType: parsed.data.objectType,
        recordIds: parsed.data.recordIds,
      },
    );
    return result;
  });

  app.get('/dialer/sessions/:id', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const { session } = owned;
    const db = getDb();
    const items = await db.query.dialerQueueItems.findMany({ where: eq(schema.dialerQueueItems.sessionId, session.id) });
    return { session, counts: sessionCounts(items), currentItem: inFlightItem(items) };
  });

  app.post('/dialer/sessions/:id/pause', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const result = await pauseSession(owned.session.id, buildEngineDeps());
    return { ok: true, ...result };
  });

  app.post('/dialer/sessions/:id/resume', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const result = await resumeSession(owned.session.id, buildEngineDeps());
    return { ok: true, ...result };
  });

  app.post('/dialer/sessions/:id/skip', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const result = await skipCurrent(owned.session.id, buildEngineDeps());
    return { ok: true, ...result };
  });

  app.post('/dialer/sessions/:id/stop', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const result = await stopSession(owned.session.id, buildEngineDeps());
    return { ok: true, ...result };
  });

  app.post('/dialer/sessions/:id/next', async (req, reply) => {
    const owned = await requireOwnedSession(req, reply);
    if (!owned) return;
    const result = await repNext(owned.session.id, buildEngineDeps());
    return { ok: true, ...result };
  });
}

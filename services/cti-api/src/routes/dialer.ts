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
 *
 *  Twilio-facing power-dialer call webhooks (signature-validated, NOT auth'd —
 *  Twilio calls these directly, see TwilioDialerTelephony#originate):
 *  POST /telephony/twilio/dialer-answer → TwiML played while async AMD classifies
 *  POST /telephony/twilio/dialer-amd    → async AMD result → hangup machine/fax, else advance
 *  POST /telephony/twilio/dialer-status → terminal call status → no_connect (idempotent)
 *
 *  Salesforce → CTI handoff relay (see dialer/handoff-store.ts):
 *  POST /dialer/handoffs         → SF Apex relays a list-view selection (shared-secret auth)
 *  GET  /dialer/handoffs/pending → the rep's softphone atomically claims it (Bearer auth)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { loadConfig } from '../config.js';
import { getProvider } from '../telephony/index.js';
import { signedCallbackUrl } from '../telephony/webhooks.js';
import { createAndStartSession } from '../dialer/create-session.js';
import {
  advanceSession,
  pauseSession,
  resumeSession,
  skipCurrent,
  stopSession,
  repNext,
  handleDialOutcome,
  type EngineDeps,
} from '../dialer/engine.js';
import { inFlightItem } from '../dialer/state.js';
import { sessionCounts } from '../dialer/session-store.js';
import { TwilioDialerTelephony } from '../dialer/twilio-telephony.js';
import { pickPoolDid, withinCallingHours, parseCallingHoursExempt } from '../dialer/pick-did.js';
import { mapAnsweredBy } from '../dialer/amd.js';
import { rolloverFollowUp } from '../salesforce/followup.js';
import { resolveDialNumber } from '../salesforce/record-phone.js';
import { salesforceUserId } from '../salesforce/current-user.js';
import {
  parseHandoffInput,
  upsertPendingHandoff,
  claimPendingHandoff,
  constantTimeEqual,
} from '../dialer/handoff-store.js';
import { sfFetch } from '../salesforce/client.js';
import { parseListViews, parseListViewResultIds } from '../salesforce/listviews.js';

// The POST /dialer/sessions body schema — pinned by src/routes/dialer.test.ts.
const StartBody = z.object({
  objectType: z.enum(['Lead', 'Opportunity']),
  recordIds: z.array(z.string().min(15).max(20)).min(1).max(500),
});

/** GG Homes operates out of America/Los_Angeles — the rollover follow-up's
 *  "today" is computed in that org timezone, not the server's (UTC on Railway). */
const ORG_TIMEZONE = 'America/Los_Angeles';

/** `YYYY-MM-DD` for `now` in the org's timezone. `en-CA` formats as ISO order,
 *  so no further reassembly is needed. */
function orgTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ORG_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Real EngineDeps for a request. Screen-pop is wired by Plan 4. */
function buildEngineDeps(): EngineDeps {
  const db = getDb();
  const cfg = loadConfig();
  // Owned test DIDs in the allowlist skip the calling-hours guard so a dial-flow
  // test can run outside 8am-9pm; every other number still respects it.
  const exempt = parseCallingHoursExempt(cfg.DIALER_CALLING_HOURS_EXEMPT);
  return {
    db,
    telephony: new TwilioDialerTelephony(),
    pickDid: (orgId, userId, toE164) => pickPoolDid(db, { orgId, userId, toE164 }),
    withinCallingHours: (toE164, nowUtc) => exempt.has(toE164) || withinCallingHours(toE164, nowUtc),
    nowUtc: new Date(),
    rolloverFollowUp,
    onScreenPop: () => {}, // Plan 4 wires Open CTI screen-pop
    todayIso: orgTodayIso(),
  };
}

const TWIML_DIALER_ANSWER_HOLD = '<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="30"/></Response>';
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response/>';

/** Terminal Twilio call statuses that mean the recipient never connected. */
const TERMINAL_NO_CONNECT_STATUSES = new Set(['no-answer', 'busy', 'failed', 'canceled']);

/**
 * Async-AMD callback handler: classify `AnsweredBy`, hang up a machine/fax
 * classification immediately (a human never picked up), then let the engine
 * act on the outcome (bridge-to-rep on connect, rollover + advance on
 * no_connect). Extracted from the route so it's unit-testable without a live
 * Fastify request — `runHandleDialOutcome` defaults to the real
 * `handleDialOutcome` but tests can inject a spy.
 */
export async function onDialerAmd(
  body: Record<string, string>,
  deps: EngineDeps,
  runHandleDialOutcome: typeof handleDialOutcome = handleDialOutcome,
): Promise<void> {
  const callSid = body.CallSid ?? '';
  const outcome = mapAnsweredBy(body.AnsweredBy);
  if (outcome === 'no_connect') {
    await deps.telephony.hangup(callSid);
  }
  await runHandleDialOutcome(callSid, outcome, deps);
}

/**
 * Call-status callback handler: a terminal status without ever reaching AMD
 * (no-answer/busy/failed/canceled) is also a no_connect. Idempotent by
 * construction — `handleDialOutcome` no-ops for any item that isn't still
 * 'dialing', so a call AMD already classified is a harmless no-op here.
 */
export async function onDialerStatus(
  body: Record<string, string>,
  deps: EngineDeps,
  runHandleDialOutcome: typeof handleDialOutcome = handleDialOutcome,
): Promise<void> {
  const callSid = body.CallSid ?? '';
  const status = body.CallStatus ?? body.DialCallStatus ?? '';
  // A TRUE no-answer (rang out) is the only miss that falls back to the record's
  // Phone number; busy / failed / canceled are plain no-connects that do not.
  if (status === 'no-answer') {
    await runHandleDialOutcome(callSid, 'no_answer', deps);
  } else if (TERMINAL_NO_CONNECT_STATUSES.has(status)) {
    await runHandleDialOutcome(callSid, 'no_connect', deps);
  }
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
  const cfg = loadConfig();

  // GET /dialer/salesforce/listviews?object=Lead|Opportunity — the rep's own
  // Salesforce list views (fetched with their token). This is how the softphone
  // offers "dial a list" without a Salesforce list-view button — the Lightning
  // Console won't hand a custom button the row selection, but the CTI can pull
  // the list view directly.
  app.get('/dialer/salesforce/listviews', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const object = (req.query as { object?: string }).object;
    if (object !== 'Lead' && object !== 'Opportunity') {
      return reply.code(400).send({ error: 'object must be Lead or Opportunity' });
    }
    try {
      const res = await sfFetch(authed.userId, `/sobjects/${object}/listviews`, { query: { limit: '200' } });
      if (res.status < 200 || res.status >= 300) {
        return reply.code(502).send({ error: 'Salesforce list-view fetch failed', status: res.status });
      }
      return { listViews: parseListViews(res.json) };
    } catch {
      return reply.code(502).send({ error: 'Could not reach Salesforce — is the rep signed in?' });
    }
  });

  // POST /dialer/sessions/from-listview { object, listViewId } — pull the list
  // view's records via the rep's token and start a dialer session over them.
  app.post('/dialer/sessions/from-listview', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = z
      .object({
        object: z.enum(['Lead', 'Opportunity']),
        listViewId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { object, listViewId } = parsed.data;
    let recordIds: string[];
    try {
      const res = await sfFetch(
        authed.userId,
        `/sobjects/${object}/listviews/${listViewId}/results`,
        { query: { limit: '200' } },
      );
      if (res.status < 200 || res.status >= 300) {
        return reply.code(502).send({ error: 'Salesforce list-view results fetch failed', status: res.status });
      }
      recordIds = parseListViewResultIds(res.json);
    } catch {
      return reply.code(502).send({ error: 'Could not reach Salesforce — is the rep signed in?' });
    }
    if (recordIds.length === 0) {
      return reply.code(422).send({ error: 'That list view has no records to dial.' });
    }
    const db = getDb();
    const result = await createAndStartSession(
      { resolveDialNumber, salesforceUserId, db, advance: (sessionId) => advanceSession(sessionId, buildEngineDeps()) },
      { userId: authed.userId, orgId: authed.orgId, objectType: object, recordIds },
    );
    return { ...result, recordCount: recordIds.length };
  });

  app.post('/dialer/sessions', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = StartBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const db = getDb();
    const result = await createAndStartSession(
      { resolveDialNumber, salesforceUserId, db, advance: (sessionId) => advanceSession(sessionId, buildEngineDeps()) },
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

  // ---------------------------------------------------------------------
  // Salesforce → CTI handoff relay
  // ---------------------------------------------------------------------

  /**
   * SF Apex relays a Power Dial list-view selection here. Auth is a shared
   * secret (never a Bearer session — Apex has no rep session token), compared
   * in constant time. If `HANDOFF_SHARED_SECRET` is unset the route is
   * disabled outright (503) rather than ever accepting an unauthenticated
   * write.
   */
  app.post('/dialer/handoffs', async (req, reply) => {
    const secret = cfg.HANDOFF_SHARED_SECRET;
    if (!secret) return reply.code(503).send({ error: 'handoff relay not configured' });
    const provided = (req.headers['x-handoff-secret'] as string | undefined) ?? '';
    if (!constantTimeEqual(provided, secret)) return reply.code(401).send({ error: 'Unauthorized' });

    const parsed = parseHandoffInput(req.body);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });

    const db = getDb();
    // Best-effort local org derivation from the rep's Salesforce connection —
    // salesforce_connections has no orgId column of its own (only the SF
    // org's OWN id, sfOrgId); the local org lives on `users`, so resolve it
    // via the connection's userId. Nullable: the write must still succeed
    // when the lookup misses (e.g. a rep who hasn't connected yet).
    const conn = await db.query.salesforceConnections.findFirst({
      where: eq(schema.salesforceConnections.sfUserId, parsed.salesforceUserId),
    });
    const user = conn ? await db.query.users.findFirst({ where: eq(schema.users.id, conn.userId) }) : undefined;
    const { handoffId } = await upsertPendingHandoff(db, {
      orgId: user?.orgId ?? null,
      salesforceUserId: parsed.salesforceUserId,
      objectType: parsed.objectType,
      recordIds: parsed.recordIds,
    });
    return { handoffId };
  });

  /**
   * The rep's softphone polls this to auto-start a run. Bearer-authed like
   * every other dialer route; the Salesforce user id is ALWAYS resolved
   * server-side from the authed rep's own `salesforce_connections` row —
   * never trust a client-supplied SF id here (no IDOR). Claim is atomic and
   * one-shot: a second poll after a successful claim sees `{ handoff: null }`.
   */
  app.get('/dialer/handoffs/pending', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const conn = await db.query.salesforceConnections.findFirst({
      where: eq(schema.salesforceConnections.userId, authed.userId),
    });
    if (!conn?.sfUserId) return { handoff: null };
    const handoff = await claimPendingHandoff(db, conn.sfUserId);
    return { handoff };
  });

  /** Shared signature gate for the Twilio-facing dialer webhooks below — same
   *  enforce-unless-explicit-local-dev-flag posture as routes/telephony.ts. */
  function validTwilioSignature(req: FastifyRequest): boolean {
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    const url = signedCallbackUrl(cfg.API_PUBLIC_URL, req);
    const provider = getProvider();
    const valid = provider.validateWebhook(req.headers as Record<string, string | string[] | undefined>, rawBody, url);
    return valid.valid || cfg.TWILIO_SKIP_SIGNATURE_CHECK;
  }

  /**
   * TwiML played to the recipient while async AMD classifies human vs.
   * machine/fax off the critical path — holds the line so the callee isn't
   * greeted with dead air before `bridgeToRep` re-points the call. See
   * TwilioDialerTelephony#originate's `url`.
   */
  app.post('/telephony/twilio/dialer-answer', async (req, reply) => {
    if (!validTwilioSignature(req)) {
      return reply.code(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    return reply.type('text/xml').send(TWIML_DIALER_ANSWER_HOLD);
  });

  /**
   * Twilio async-AMD result callback (TwilioDialerTelephony#originate's
   * `asyncAmdStatusCallback`) — classifies human vs. machine/fax and drives
   * the dialer engine's outcome handling (hangup + no_connect, or bridge on
   * connect).
   */
  app.post('/telephony/twilio/dialer-amd', async (req, reply) => {
    if (!validTwilioSignature(req)) {
      return reply.code(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    await onDialerAmd(req.body as Record<string, string>, buildEngineDeps());
    return reply.type('text/xml').send(TWIML_EMPTY);
  });

  /**
   * Twilio call-status callback (TwilioDialerTelephony#originate's
   * `statusCallback`) — catches terminal statuses AMD never saw (the call
   * never rang through at all: no-answer/busy/failed/canceled). Idempotent
   * against a call AMD already classified — see `onDialerStatus`.
   */
  app.post('/telephony/twilio/dialer-status', async (req, reply) => {
    if (!validTwilioSignature(req)) {
      return reply.code(403).type('text/xml').send('<Response><Reject/></Response>');
    }
    await onDialerStatus(req.body as Record<string, string>, buildEngineDeps());
    return reply.type('text/xml').send(TWIML_EMPTY);
  });
}

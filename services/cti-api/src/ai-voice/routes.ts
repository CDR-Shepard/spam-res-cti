/**
 * AI voice HTTP surface (`registerAiVoiceRoutes`, one line in server.ts):
 *
 *   POST /ai-calls                       start an AI call (rep session; 10/min per user)
 *   GET  /ai-calls/availability          is AI calling on; test numbers (admins)
 *   GET  /ai-calls?limit=20              recent calls (admin: org, rep: own)
 *   GET  /ai-calls/:id                   one call in the session's org
 *   POST /telephony/twilio/ai-voice/{amd,status,transfer-result}   (routes-webhooks.ts)
 *   GET  /telephony/twilio/ai-voice/stream  (WebSocket, routes-stream.ts)
 *
 * Dependencies are injectable (`overrides`) so tests never touch Twilio,
 * OpenAI, Salesforce or the database.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveSession, type SessionUser } from '@cti/auth';
import { getDb } from '@cti/db';
import { aiVoiceAvailable, loadConfig, parseTestNumbers } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import type { BridgeLog } from './bridge.js';
import { UUID_RE } from '../telephony/webhooks.js';
import { gateAiCall } from './gate.js';
import { loadAiCallRecord } from './record.js';
import { registerAiVoiceStreamRoute } from './routes-stream.js';
import { registerAiVoiceWebhooks } from './routes-webhooks.js';
import { startAiCall, type StartDeps, type StartResult } from './service.js';
import { liveAfterCall, type AfterCall } from './service-finalize.js';
import { withSalesforceEffects } from './sf-logging.js';
import { defaultToolEffects, type ToolEffects } from './service-tools.js';
import { drizzleAiCallStore, type AiCallStore } from './store.js';
import type { StreamSessionDeps } from './stream-session.js';
import { createAiVoiceTwilio, type AiVoiceTwilio } from './twilio.js';
import { openRealtime } from './ws-adapter.js';

export interface AiVoiceDeps {
  store: AiCallStore;
  twilio: AiVoiceTwilio;
  effects: ToolEffects;
  loadRecord: StartDeps['loadRecord'];
  gate: StartDeps['gate'];
  openRealtime: StreamSessionDeps['openRealtime'];
  createBridge?: StreamSessionDeps['createBridge'];
  db: () => Db;
  now: () => Date;
  /** Summary + Salesforce Tasks once a call is finalized (detached from the webhook). */
  afterCall: AfterCall;
}

const START_RATE_MAX = 10;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 100;

const StartBody = z.union([
  z.object({
    objectType: z.enum(['Lead', 'Opportunity', 'Contact']),
    recordId: z.string().regex(/^[a-zA-Z0-9]{15,18}$/),
  }),
  z.object({ testTo: z.string().min(7).max(20) }),
]);
const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
});

/** The request's session, resolved once and shared by the rate-limit key and the handler. */
const requestSessions = new WeakMap<object, Promise<SessionUser | null>>();

function sessionFor(req: Pick<FastifyRequest, 'headers'>): Promise<SessionUser | null> {
  const known = requestSessions.get(req);
  if (known) return known;
  const pending = resolveSession(req.headers.authorization);
  requestSessions.set(req, pending);
  return pending;
}

/**
 * One rate bucket per signed-in user (all their tabs and devices share it);
 * per IP when there is no session (or the lookup fails — the handler then
 * answers 401 / 500 itself).
 */
export async function aiCallRateKey(req: Pick<FastifyRequest, 'headers' | 'ip'>): Promise<string> {
  const session = await sessionFor(req).catch(() => null);
  return session ? `ai-call-user:${session.userId}` : `ai-call-ip:${req.ip}`;
}

/** HTTP status + body for a start result. */
export function startResponse(r: StartResult): { code: number; body: Record<string, unknown> } {
  if (r.ok) return { code: 201, body: { aiCallId: r.aiCallId, status: r.status } };
  switch (r.reason) {
    case 'record_not_found':
      return { code: 404, body: { error: r.reason } };
    case 'salesforce_error':
      return { code: 502, body: { error: r.reason } };
    case 'gate_error':
      return { code: 503, body: { error: r.reason } };
    case 'twilio_error':
      return { code: 502, body: { error: r.reason, aiCallId: r.aiCallId } };
    default:
      return { code: 409, body: { error: r.reason, aiCallId: r.aiCallId } };
  }
}

/** Live wiring; the Salesforce/summary pieces are built on the store and clock actually in use. */
function defaultDeps(overrides: Partial<AiVoiceDeps>, log: BridgeLog): AiVoiceDeps {
  const cfg = loadConfig();
  const store = overrides.store ?? drizzleAiCallStore(getDb());
  const now = overrides.now ?? (() => new Date());
  const { afterCall, sf } = liveAfterCall(cfg, store, log, now);
  return {
    store,
    twilio: createAiVoiceTwilio(cfg),
    effects: withSalesforceEffects(defaultToolEffects, sf),
    loadRecord: (userId, objectType, recordId) => loadAiCallRecord(userId, objectType, recordId),
    gate: gateAiCall,
    openRealtime,
    db: () => getDb(),
    now,
    afterCall,
  };
}

export async function registerAiVoiceRoutes(app: FastifyInstance, overrides: Partial<AiVoiceDeps> = {}): Promise<void> {
  const log = app.log;
  const deps: AiVoiceDeps = { ...defaultDeps(overrides, log), ...overrides };

  app.post(
    '/ai-calls',
    { config: { rateLimit: { max: START_RATE_MAX, timeWindow: '1 minute', keyGenerator: aiCallRateKey } } },
    async (req, reply) => {
      const session = await sessionFor(req);
      if (!session) return reply.code(401).send({ error: 'unauthorized' });
      const body = StartBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });
      const result = await startAiCall({
        db: deps.db(),
        cfg: loadConfig(),
        session,
        target: body.data,
        deps: { store: deps.store, twilio: deps.twilio, loadRecord: deps.loadRecord, gate: deps.gate, now: deps.now, log },
      });
      const { code, body: out } = startResponse(result);
      return reply.code(code).send(out);
    },
  );

  app.get('/ai-calls/availability', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'unauthorized' });
    const cfg = loadConfig();
    return {
      available: aiVoiceAvailable(cfg),
      testNumbers: session.isAdmin ? [...parseTestNumbers(cfg.AI_VOICE_TEST_NUMBERS)] : [],
    };
  });

  app.get('/ai-calls', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'unauthorized' });
    const q = ListQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' });
    const aiCalls = await deps.store.list(session.orgId, {
      limit: q.data.limit,
      ...(session.isAdmin ? {} : { startedBy: session.userId }),
    });
    return { aiCalls };
  });

  app.get('/ai-calls/:id', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'unauthorized' });
    const id = (req.params as { id?: string }).id ?? '';
    const row = UUID_RE.test(id) ? await deps.store.getInOrg(session.orgId, id) : null;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return row;
  });

  registerAiVoiceWebhooks(app, { store: deps.store, twilio: deps.twilio, effects: deps.effects, now: deps.now, log, afterCall: deps.afterCall });

  await registerAiVoiceStreamRoute(app, (req) => ({
    cfg: loadConfig(),
    store: deps.store,
    twilio: deps.twilio,
    effects: deps.effects,
    openRealtime: deps.openRealtime,
    ...(deps.createBridge ? { createBridge: deps.createBridge } : {}),
    now: deps.now,
    log: req.log,
  }));
}

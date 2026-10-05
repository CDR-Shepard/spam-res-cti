/**
 * AI voice HTTP surface (`registerAiVoiceRoutes`, one line in server.ts):
 *
 *   POST /internal/ai-calls              start an AI call for an outreach campaign (signed, private network)
 *   GET  /internal/ai-calls/availability is AI calling on; test numbers (signed)
 *   POST /telephony/twilio/ai-voice/{amd,status,transfer-result}   (routes-webhooks.ts)
 *   GET  /telephony/twilio/ai-voice/stream  (WebSocket, routes-stream.ts)
 *
 * Dependencies are injectable (`overrides`) so tests never touch Twilio,
 * OpenAI, Salesforce or the database.
 */
import type { FastifyInstance } from 'fastify';
import { getDb } from '@cti/db';
import { loadConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import type { BridgeLog } from './bridge.js';
import { gateAiCall } from './gate.js';
import { internalSession } from './internal-auth.js';
import { loadIntegrationRecord } from './integration-record.js';
import { loadAiCallRecord } from './record.js';
import { drizzleAiCallRequestStore, type AiCallRequestStore } from './request-store.js';
import { registerInternalAiCallRoutes } from './routes-internal.js';
import { registerAiVoiceStreamRoute } from './routes-stream.js';
import { registerAiVoiceWebhooks } from './routes-webhooks.js';
import { startAiCall, type StartDeps } from './service.js';
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
  /** Idempotency store of the internal trigger; tests override it (default: ai_call_requests). */
  requests?: AiCallRequestStore;
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

  await registerInternalAiCallRoutes(app, {
    db: deps.db,
    now: deps.now,
    requests: deps.requests ?? drizzleAiCallRequestStore(deps.db),
    session: internalSession,
    loadIntegrationRecord: (db, orgId, objectType, recordId) => loadIntegrationRecord(db, loadConfig(), orgId, objectType, recordId),
    start: startAiCall,
    startDeps: { store: deps.store, twilio: deps.twilio, gate: deps.gate, now: deps.now, log },
    log,
  });
}

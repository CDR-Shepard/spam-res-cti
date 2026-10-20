/**
 * AI voice HTTP surface (`registerAiVoiceRoutes`, one line in server.ts):
 *
 *   POST /internal/ai-calls              start an AI call for an outreach campaign (signed, private network)
 *   GET  /internal/ai-calls/availability is AI calling on; test numbers (signed)
 *   POST /internal/ai-calls/prompt-check check an agent prompt template and preview it (signed)
 *   POST /telephony/twilio/ai-voice/{amd,status,transfer-result}   (routes-webhooks.ts)
 *   GET  /telephony/twilio/ai-voice/voicemail/:token   Sam's recorded voicemail for <Play> (voicemail-audio.ts)
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
import type { CallerDetailsDeps } from './caller-details.js';
import { externalVoiceFor } from './elevenlabs-tts.js';
import { voicemailVoiceFor } from './elevenlabs-voicemail.js';
import { gateAiCall } from './gate.js';
import { internalSession } from './internal-auth.js';
import { loadIntegrationRecord } from './integration-record.js';
import { loadAiCallRecord } from './record.js';
import { drizzleAiCallRequestStore, type AiCallRequestStore } from './request-store.js';
import { registerInternalAiCallRoutes } from './routes-internal.js';
import { registerAiVoiceStreamRoute } from './routes-stream.js';
import { registerAiVoiceWebhooks } from './routes-webhooks.js';
import { REGISTRY_MARGIN_SECONDS, startAiCall, type StartDeps } from './service.js';
import { liveAfterCall, type AfterCall } from './service-finalize.js';
import { withSalesforceEffects } from './sf-logging.js';
import { defaultToolEffects, type ToolEffects } from './service-tools.js';
import { drizzleAiCallStore, type AiCallStore } from './store.js';
import type { StreamSessionDeps } from './stream-session.js';
import { createAiVoiceTwilio, type AiVoiceTwilio } from './twilio.js';
import { createVoicemailAudio, registerVoicemailAudioRoute, type VoicemailAudio } from './voicemail-audio.js';
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
  /** The model (the summary's) that fills an inbound call's details from its transcript when it ends; absent = none. */
  details?: CallerDetailsDeps;
  /** Idempotency store of the internal trigger; tests override it (default: ai_call_requests). */
  requests?: AiCallRequestStore;
  /** Sam's recorded voicemail (AI_VOICE_VOICEMAIL_TTS); null = the stock `<Say>` voice. */
  voicemail: VoicemailAudio | null;
}

/** Live wiring; the Salesforce/summary pieces are built on the store and clock actually in use. */
function defaultDeps(overrides: Partial<AiVoiceDeps>, log: BridgeLog): AiVoiceDeps {
  const cfg = loadConfig();
  const store = overrides.store ?? drizzleAiCallStore(getDb());
  const now = overrides.now ?? (() => new Date());
  const { afterCall, sf, summary } = liveAfterCall(cfg, store, log, now);
  const render = voicemailVoiceFor(cfg, log);
  // Held as long as a call can be live, like the registry entry (service.ts).
  const ttlMs = (cfg.AI_VOICE_MAX_CALL_SECONDS + REGISTRY_MARGIN_SECONDS) * 1000;
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
    details: summary,
    voicemail: render ? createVoicemailAudio({ render, apiPublicUrl: cfg.API_PUBLIC_URL, ttlMs, log }) : null,
  };
}

export async function registerAiVoiceRoutes(app: FastifyInstance, overrides: Partial<AiVoiceDeps> = {}): Promise<void> {
  const log = app.log;
  const deps: AiVoiceDeps = { ...defaultDeps(overrides, log), ...overrides };

  registerAiVoiceWebhooks(app, {
    store: deps.store,
    twilio: deps.twilio,
    effects: deps.effects,
    now: deps.now,
    log,
    afterCall: deps.afterCall,
    voicemail: deps.voicemail,
  });
  if (deps.voicemail) registerVoicemailAudioRoute(app, deps.voicemail);

  await registerAiVoiceStreamRoute(app, (req) => {
    const cfg = loadConfig();
    const openTts = externalVoiceFor(cfg, req.log);
    return {
      cfg,
      store: deps.store,
      twilio: deps.twilio,
      effects: deps.effects,
      openRealtime: deps.openRealtime,
      ...(deps.createBridge ? { createBridge: deps.createBridge } : {}),
      ...(deps.details ? { details: deps.details } : {}),
      ...(openTts ? { openTts } : {}),
      now: deps.now,
      log: req.log,
    };
  });

  await registerInternalAiCallRoutes(app, {
    db: deps.db,
    now: deps.now,
    requests: deps.requests ?? drizzleAiCallRequestStore(deps.db),
    session: internalSession,
    loadIntegrationRecord: (db, orgId, objectType, recordId) => loadIntegrationRecord(db, loadConfig(), orgId, objectType, recordId),
    start: startAiCall,
    startDeps: { store: deps.store, twilio: deps.twilio, gate: deps.gate, now: deps.now, log, voicemail: deps.voicemail },
    log,
  });
}

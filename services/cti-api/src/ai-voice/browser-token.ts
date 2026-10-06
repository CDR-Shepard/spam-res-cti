/**
 * Plan 1E "Talk in browser": the Voice access token an admin's outreach-web tab registers with, so the AI's practice call
 * can ring it (`client:<identity>`, service-target.ts `practice_browser`).
 *
 * The token can only RECEIVE (G-4): a VoiceGrant with `incomingAllow` and NO `outgoingApplicationSid` (so the browser
 * cannot `device.connect()` anything) and no push credential. Its identity is `aitest_<the admin's user id>_<nonce>`
 * (`aiTestIdentity`, @cti/contracts): never `rep_…`, so no cti-web softphone rings for it, and cti-api's gate dials it only
 * for the admin it names. A fresh identity per run means no refresh logic. It lives for one call plus ten minutes.
 *
 *   POST /internal/ai-calls/browser-token   { orgId, userId } -> { token, identity, expiresAt }
 *
 * Registered inside the internal scope (routes-internal.ts): the same transport guard, HMAC preHandler and rate limit as
 * the trigger. Logs carry the org and user ids only, never the token or the identity.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import twilio from 'twilio';
import { INTERNAL_AI_BROWSER_TOKEN_PATH, InternalBrowserTokenRequest, aiTestIdentity, type InternalBrowserTokenResponse } from '@cti/contracts';
import { aiVoiceAvailable, type AppConfig } from '../config.js';
import type { InternalAiDeps } from './routes-internal.js';

/** Seconds a token outlives the longest AI call: time to register, ring and finish. */
const TOKEN_MARGIN_SECONDS = 600;

type MintConfig = Pick<AppConfig, 'TWILIO_ACCOUNT_SID' | 'TWILIO_API_KEY_SID' | 'TWILIO_API_KEY_SECRET' | 'AI_VOICE_MAX_CALL_SECONDS'>;

/** AI voice on, and the Twilio account + API key needed to mint a Voice token (no TwiML App: no outgoing grant). */
export function browserCallsAvailable(cfg: AppConfig): boolean {
  return aiVoiceAvailable(cfg) && !!cfg.TWILIO_ACCOUNT_SID && !!cfg.TWILIO_API_KEY_SID && !!cfg.TWILIO_API_KEY_SECRET;
}

export function mintAiTestToken(
  cfg: MintConfig,
  userId: string,
  now: Date,
  nonce: () => string = () => randomBytes(6).toString('hex'),
): InternalBrowserTokenResponse {
  if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_API_KEY_SID || !cfg.TWILIO_API_KEY_SECRET) {
    throw new Error('browser calls are not configured');
  }
  const identity = aiTestIdentity(userId, nonce());
  const ttl = cfg.AI_VOICE_MAX_CALL_SECONDS + TOKEN_MARGIN_SECONDS;
  const { AccessToken } = twilio.jwt;
  const token = new AccessToken(cfg.TWILIO_ACCOUNT_SID, cfg.TWILIO_API_KEY_SID, cfg.TWILIO_API_KEY_SECRET, { identity, ttl });
  // Incoming only: no outgoingApplicationSid (the browser can never place a call) and no push credential.
  token.addGrant(new AccessToken.VoiceGrant({ incomingAllow: true }));
  return { token: token.toJwt(), identity, expiresAt: new Date(now.getTime() + ttl * 1000).toISOString() };
}

type RouteDeps = Pick<InternalAiDeps, 'db' | 'session' | 'now' | 'log'>;

/** Mounted on the internal scope, after its transport guard and signature check. */
export function registerBrowserTokenRoute(
  scope: FastifyInstance,
  deps: RouteDeps,
  cfgOf: () => AppConfig,
  rateLimit: Record<string, unknown>,
): void {
  scope.post(INTERNAL_AI_BROWSER_TOKEN_PATH, { config: { rateLimit } }, async (req, reply) => {
    const parsed = InternalBrowserTokenRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    const { orgId, userId } = parsed.data;
    const session = await deps.session(deps.db(), orgId, userId);
    if (!session) return reply.code(403).send({ error: 'unknown_user' });
    if (!session.isAdmin) return reply.code(403).send({ error: 'not_admin' });
    const cfg = cfgOf();
    if (!browserCallsAvailable(cfg)) return reply.code(503).send({ error: 'browser_calls_unavailable' });
    const minted = mintAiTestToken(cfg, session.userId, deps.now());
    deps.log.info({ orgId, userId }, 'ai-voice internal: browser test token minted');
    return minted;
  });
}

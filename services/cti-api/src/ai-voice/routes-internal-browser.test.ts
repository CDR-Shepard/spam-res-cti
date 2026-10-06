/**
 * Plan 1E, the internal routes for "Talk in browser": POST /internal/ai-calls/browser-token (Task 6) and the
 * practice_browser trigger (Task 7), on a real Fastify app with only the internal routes, signed with @cti/auth's
 * internalRequestHeaders. startAiCall is replaced through deps.start; the request store is in memory.
 * (Its own file: routes-internal.test.ts is already past the size limit.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { internalRequestHeaders, type SessionUser } from '@cti/auth';
import { INTERNAL_AI_BROWSER_TOKEN_PATH, INTERNAL_AI_CALLS_PATH, InternalBrowserTokenResponse, aiTestIdentityUser } from '@cti/contracts';
import type { AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import type { AiCallRequestRow, AiCallRequestStore } from './request-store.js';
import { registerInternalAiCallRoutes, type InternalAiDeps } from './routes-internal.js';
import type { StartInput, StartResult } from './service.js';

const SECRET = 'z'.repeat(48);
const NOW = new Date('2026-10-06T15:00:00.000Z');
const ORG = '99999999-2222-4333-8444-555555555555';
const USER = '11111111-2222-4333-8444-555555555555';
const OTHER_ADMIN = '22222222-2222-4333-8444-555555555555';
const CALL = '33333333-2222-4333-8444-555555555555';
const LEAD = '00Q5e00000AbCdEFGH';
const HOST = 'ctiapi.railway.internal:4000';
const PLAN = 'Opener: Ask whether the family has decided what to do with the house.';
const IDENTITY = `aitest_${USER.replace(/-/g, '')}_a1b2c3d4e5f6`;

const admin: SessionUser = { userId: USER, orgId: ORG, email: 'a@example.com', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };

function memoryRequests(): AiCallRequestStore & { rows: Map<string, AiCallRequestRow> } {
  const rows = new Map<string, AiCallRequestRow>();
  return {
    rows,
    reserve: vi.fn(async (a) => {
      const existing = rows.get(a.key);
      if (existing) return { kind: 'existing' as const, row: existing };
      rows.set(a.key, { orgId: a.orgId, idempotencyKey: a.key, requestHash: a.hash, userId: a.userId, aiCallId: null, response: null, createdAt: NOW, updatedAt: NOW });
      return { kind: 'new' as const };
    }),
    complete: vi.fn(async (_orgId, key, response) => {
      const row = rows.get(key);
      if (row && row.response === null) rows.set(key, { ...row, response, aiCallId: response.aiCallId });
    }),
    takeOver: vi.fn(async () => false),
    findCallSince: vi.fn(async () => null),
    linkCall: vi.fn(async () => {}),
    findCall: vi.fn(async () => null),
  };
}

let cfg: Partial<AppConfig>;
let requests: ReturnType<typeof memoryRequests>;
let startResult: StartResult;
let deps: InternalAiDeps & { start: ReturnType<typeof vi.fn>; session: ReturnType<typeof vi.fn> };
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let app: FastifyInstance;
const db = { tag: 'db' } as unknown as Db;

beforeEach(async () => {
  cfg = {
    OUTREACH_INTERNAL_SECRET: SECRET, NODE_ENV: 'production', OPENAI_API_KEY: 'sk', AI_VOICE: 'on', OUTREACH_KILL_SWITCH: 'off',
    AI_VOICE_TEST_NUMBERS: '+15125550100', AI_VOICE_MAX_CALL_SECONDS: 600,
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_API_KEY_SID: `SK${'2'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'secret-of-the-api-key',
  };
  requests = memoryRequests();
  startResult = { ok: true, aiCallId: CALL, status: 'ringing' };
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  deps = {
    db: () => db,
    cfg: () => cfg as AppConfig,
    now: () => NOW,
    requests,
    session: vi.fn(async () => admin),
    loadIntegrationRecord: vi.fn(async () => null),
    start: vi.fn(async () => startResult),
    startDeps: { store: {} as never, twilio: {} as never, gate: vi.fn() as never, now: () => NOW, log },
    log,
  };
  app = Fastify();
  await registerInternalAiCallRoutes(app, deps);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

function post(path: string, body: unknown, opts: { sign?: boolean; headers?: Record<string, string> } = {}) {
  const payload = JSON.stringify(body);
  const signed = opts.sign === false ? {} : internalRequestHeaders(SECRET, { method: 'POST', path, body: payload }, NOW);
  return app.inject({ method: 'POST', url: path, headers: { host: HOST, 'content-type': 'application/json', ...signed, ...opts.headers }, payload });
}

const tokenBody = { orgId: ORG, userId: USER };
const allLogs = () => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);

describe('POST /internal/ai-calls/browser-token', () => {
  it('4: a signed request for an admin answers an incoming-only token for an identity of their own; neither is logged', async () => {
    const res = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody);
    expect(res.statusCode).toBe(200);
    const body = InternalBrowserTokenResponse.parse(res.json());
    expect(aiTestIdentityUser(body.identity)).toBe(USER);
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + 1200 * 1000).toISOString());
    const grants = JSON.parse(Buffer.from(body.token.split('.')[1]!, 'base64url').toString('utf8')).grants;
    expect(grants.voice.outgoing).toBeUndefined();
    expect(deps.session).toHaveBeenCalledWith(db, ORG, USER);
    expect(log.info).toHaveBeenCalledWith({ orgId: ORG, userId: USER }, expect.stringMatching(/minted/));
    expect(allLogs()).not.toContain(body.token);
    expect(allLogs()).not.toContain(body.identity);
    expect(allLogs()).not.toContain(body.token.split('.')[2]!);
  });

  it('5: not an admin -> 403 not_admin', async () => {
    deps.session.mockResolvedValueOnce({ ...admin, isAdmin: false });
    const res = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'not_admin' });
  });

  it('6: an unknown (or service) user -> 403 unknown_user', async () => {
    deps.session.mockResolvedValueOnce(null);
    const res = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'unknown_user' });
  });

  it('7: no API key (or AI voice off) -> 503 browser_calls_unavailable', async () => {
    cfg.TWILIO_API_KEY_SECRET = undefined;
    const res = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'browser_calls_unavailable' });
    cfg.TWILIO_API_KEY_SECRET = 'secret-of-the-api-key';
    cfg.AI_VOICE = 'off';
    expect((await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody)).statusCode).toBe(503);
  });

  it('a body that is not { orgId, userId } -> 400 invalid_body, nobody looked up', async () => {
    const res = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, { ...tokenBody, identity: IDENTITY });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_body' });
    expect(deps.session).not.toHaveBeenCalled();
  });

  it('8: unsigned or a bad signature -> refused exactly as the trigger route is', async () => {
    const unsigned = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody, { sign: false });
    const triggerUnsigned = await post(INTERNAL_AI_CALLS_PATH, tokenBody, { sign: false });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json()).toEqual(triggerUnsigned.json());
    const forOther = internalRequestHeaders(SECRET, { method: 'POST', path: INTERNAL_AI_BROWSER_TOKEN_PATH, body: JSON.stringify({ orgId: ORG, userId: OTHER_ADMIN }) }, NOW);
    const tampered = await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody, { sign: false, headers: forOther });
    expect(tampered.statusCode).toBe(401);
    expect(tampered.json()).toEqual({ error: 'bad_signature' });
    expect((await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody, { headers: { origin: 'https://cti.example.com' } })).statusCode).toBe(403);
    expect((await post(INTERNAL_AI_BROWSER_TOKEN_PATH, tokenBody, { headers: { host: 'cti.example.com' } })).statusCode).toBe(404);
    expect(deps.session).not.toHaveBeenCalled();
  });
});

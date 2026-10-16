/**
 * GET /internal/ai-calls/availability with the org's test-phones list (plan 2026-10-16 inbound agent testing): the
 * route has no body, so the org comes as an optional, signed `?orgId=`. With it, testNumbers is AI_VOICE_TEST_NUMBERS
 * together with that org's list; without it, exactly today's answer (the env list).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { internalRequestHeaders } from '@cti/auth';
import { INTERNAL_AI_AVAILABILITY_PATH } from '@cti/contracts';
import type { AppConfig } from '../config.js';
import type { Db } from '../dialer/pick-did.js';
import { registerInternalAiCallRoutes, type InternalAiDeps } from './routes-internal.js';

const SECRET = 'z'.repeat(48);
const NOW = new Date('2026-10-16T15:00:00.000Z');
const ORG = '99999999-2222-4333-8444-555555555555';
const HOST = 'ctiapi.railway.internal:4000';
const db = { tag: 'db' } as unknown as Db;

let testPhones: ReturnType<typeof vi.fn>;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let app: FastifyInstance;

beforeEach(async () => {
  testPhones = vi.fn(async () => new Set(['+16195550142', '+15125550101']));
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const cfg = { OUTREACH_INTERNAL_SECRET: SECRET, NODE_ENV: 'production', OPENAI_API_KEY: 'sk', AI_VOICE: 'on', OUTREACH_KILL_SWITCH: 'off', AI_VOICE_TEST_NUMBERS: '+15125550100, +15125550101' };
  const deps: InternalAiDeps = {
    db: () => db,
    cfg: () => cfg as AppConfig,
    now: () => NOW,
    requests: {} as never,
    session: vi.fn(),
    loadIntegrationRecord: vi.fn(),
    start: vi.fn(),
    startDeps: {} as never,
    testPhones,
    log,
  };
  app = Fastify();
  await registerInternalAiCallRoutes(app, deps);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { host: HOST, ...internalRequestHeaders(SECRET, { method: 'GET', path: url, body: '' }, NOW) } });

describe('GET /internal/ai-calls/availability — test numbers', () => {
  it("with ?orgId: the env list, then the org's own phones (each number once)", async () => {
    const res = await get(`${INTERNAL_AI_AVAILABILITY_PATH}?orgId=${ORG}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true, testNumbers: ['+15125550100', '+15125550101', '+16195550142'], browserCalls: false });
    expect(testPhones).toHaveBeenCalledWith(db, ORG);
  });

  it("without an org: exactly today's answer, and the list is never read", async () => {
    const res = await get(INTERNAL_AI_AVAILABILITY_PATH);
    expect(res.json()).toEqual({ available: true, testNumbers: ['+15125550100', '+15125550101'], browserCalls: false });
    expect(testPhones).not.toHaveBeenCalled();
  });

  it('a malformed orgId is ignored (env list only)', async () => {
    const res = await get(`${INTERNAL_AI_AVAILABILITY_PATH}?orgId=not-a-uuid`);
    expect(res.json().testNumbers).toEqual(['+15125550100', '+15125550101']);
    expect(testPhones).not.toHaveBeenCalled();
  });

  it('a failed list read still answers, with the env list and a warning (codes only)', async () => {
    testPhones.mockRejectedValueOnce(new Error('pg down'));
    const res = await get(`${INTERNAL_AI_AVAILABILITY_PATH}?orgId=${ORG}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().testNumbers).toEqual(['+15125550100', '+15125550101']);
    expect(log.warn).toHaveBeenCalledWith({ reason: 'db_error' }, 'ai-voice internal: test phones unavailable, using the env list');
  });

  it("accepts the request exactly as outreach-api's client sends it (final review I-1): ?orgId=<encoded org>, signed over path and query", async () => {
    const url = `${INTERNAL_AI_AVAILABILITY_PATH}?orgId=${encodeURIComponent(ORG)}`;
    const res = await app.inject({ method: 'GET', url, headers: { host: HOST, ...internalRequestHeaders(SECRET, { method: 'GET', path: url, body: '' }, NOW) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().testNumbers).toContain('+16195550142');
    expect(testPhones).toHaveBeenCalledWith(db, ORG);
  });

  it('the orgId is part of what is signed: a signature over the bare path does not cover it', async () => {
    const signedBare = internalRequestHeaders(SECRET, { method: 'GET', path: INTERNAL_AI_AVAILABILITY_PATH, body: '' }, NOW);
    const res = await app.inject({ method: 'GET', url: `${INTERNAL_AI_AVAILABILITY_PATH}?orgId=${ORG}`, headers: { host: HOST, ...signedBare } });
    expect(res.statusCode).toBe(401);
  });
});

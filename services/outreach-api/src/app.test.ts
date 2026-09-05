import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { ApiError } from '@cti/contracts';
import { buildApp } from './app.js';
import { testConfig } from './test/harness.js';

const cfg = testConfig();
let app: FastifyInstance;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); });

/** Stands in for an upstream (WorkOS) error message: must be logged, must never reach the browser. */
const UPSTREAM_MESSAGE = 'WorkOS said: upstream-secret-detail-9f8e';
/** Not loopback: the global limiter allow-lists 127.0.0.1/::1 outside production, which is what `app.inject` uses by default. */
const REMOTE_IP = '203.0.113.9';

async function build(): Promise<FastifyInstance> {
  return buildApp({
    cfg,
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [async (api) => {
      api.get('/boom', async () => { throw new Error(UPSTREAM_MESSAGE); });
      api.get('/validated', { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } } } }, async () => ({ ok: true }));
      api.post('/echo', async (req) => req.body);
      api.get('/limited', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, async () => ({ ok: true }));
    }],
  });
}

/**
 * Captures `error(...)` calls made through the per-request child logger (the
 * app's own logger is silent in tests). Fastify derives `req.log` via
 * `app.log.child(bindings)`; `setChildLoggerFactory` would be cleaner, but the
 * `/api` scope already captured the default factory while `buildApp` awaited
 * its plugins, so intercept `child` on the shared root logger instead.
 */
function captureRequestLog(instance: FastifyInstance): Array<{ obj: unknown; msg: unknown }> {
  const errors: Array<{ obj: unknown; msg: unknown }> = [];
  const noop = () => {};
  const fake = {
    level: 'error',
    fatal: noop, warn: noop, info: noop, debug: noop, trace: noop, silent: noop,
    error: (obj: unknown, msg?: unknown) => { errors.push({ obj, msg }); },
    child: () => fake,
  };
  vi.spyOn(instance.log, 'child').mockImplementation(() => fake as unknown as FastifyBaseLogger);
  return errors;
}

describe('error envelope', () => {
  it('answers an uncaught route error with a 500 ApiError that never carries the thrown message, and logs the full error with the request id', async () => {
    app = await build();
    const errors = captureRequestLog(app);
    const res = await app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    const body = ApiError.parse(res.json());
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.requestId).toBeTruthy();
    expect(res.body).not.toContain(UPSTREAM_MESSAGE);
    expect(res.body).not.toContain('upstream-secret');
    // Fastify's default 500 body shape must be gone too.
    expect(res.json()).not.toHaveProperty('statusCode');
    const logged = errors.find((e) => (e.obj as { err?: Error }).err?.message === UPSTREAM_MESSAGE);
    expect(logged, 'server-side log of the real error').toBeDefined();
    expect((logged!.obj as { requestId?: string }).requestId).toBe(body.requestId);
  });
  it('answers a schema validation failure with 400 VALIDATION_FAILED and the validation message', async () => {
    app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/validated' });
    expect(res.statusCode).toBe(400);
    const body = ApiError.parse(res.json());
    expect(body.code).toBe('VALIDATION_FAILED');
    expect(body.error).toContain("'q'");
  });
  it("wraps Fastify's own client errors in the envelope (malformed JSON → 400, unsupported media type → 415)", async () => {
    app = await build();
    const badJson = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    expect(badJson.statusCode).toBe(400);
    expect(ApiError.parse(badJson.json()).code).toBe('BAD_REQUEST');
    // (Fastify parses `text/plain` out of the box, so use a type it has no parser for.)
    const badType = await app.inject({ method: 'POST', url: '/api/echo', headers: { 'content-type': 'application/xml' }, payload: '<hi/>' });
    expect(badType.statusCode).toBe(415);
    expect(ApiError.parse(badType.json()).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
  it('answers a rate-limited request with a 429 ApiError (code RATE_LIMITED) and a Retry-After header', async () => {
    app = await build();
    const first = await app.inject({ method: 'GET', url: '/api/limited', remoteAddress: REMOTE_IP });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'GET', url: '/api/limited', remoteAddress: REMOTE_IP });
    expect(second.statusCode).toBe(429);
    const body = ApiError.parse(second.json());
    expect(body.code).toBe('RATE_LIMITED');
    expect(body.requestId).toBeTruthy();
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.json()).not.toHaveProperty('statusCode');
  });
});

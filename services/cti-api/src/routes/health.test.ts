import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHealthRoutes } from './health.js';

// /healthz never reads config or the database; keep both out of this test.
vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('@cti/db', () => ({ getPool: () => { throw new Error('/healthz must not touch the database'); } }));

const BUILD = { commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' };
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('GET /healthz', () => {
  it('stays ok with a timestamp, and says which commit this process runs and when it started', async () => {
    app = Fastify();
    await registerHealthRoutes(app, BUILD);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: true, commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' });
    expect(new Date(String(body.ts)).toISOString()).toBe(body.ts);
  });

  it('answers with those four fields only (nothing from the environment rides along)', async () => {
    app = Fastify();
    await registerHealthRoutes(app, BUILD);
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(['commit', 'ok', 'startedAt', 'ts']);
  });

  it('with no build given, it reports this process: a short commit or "dev", and a valid start time', async () => {
    app = Fastify();
    await registerHealthRoutes(app);
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json<{ commit: string; startedAt: string }>();
    expect(body.commit).toMatch(/^([0-9a-f]{7}|dev)$/);
    expect(Number.isNaN(new Date(body.startedAt).getTime())).toBe(false);
  });
});

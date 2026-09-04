import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';

const cfg = parseConfig({ NODE_ENV: 'test', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' });
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('health', () => {
  it('healthz is always 200', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: false, jobsOk: false }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
  it('readyz is 503 when the DB or jobs are down and 200 when both are up', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: false }) });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }) });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, dbOk: true, jobsOk: true });
  });
});

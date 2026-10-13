import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';

const cfg = parseConfig({ NODE_ENV: 'test', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' });
const BUILD = { commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' };
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('healthz build info', () => {
  it('stays ok with a timestamp, and says which commit this process runs and when it started', async () => {
    app = await buildApp({ cfg, build: BUILD, readiness: async () => ({ dbOk: false, jobsOk: false }) });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toMatchObject({ ok: true, commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' });
    expect(new Date(String(body.ts)).toISOString()).toBe(body.ts);
    expect(Object.keys(body).sort()).toEqual(['commit', 'ok', 'startedAt', 'ts']);
  });

  it('with no build given, it reports this process: a short commit or "dev", and a valid start time', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }) });
    const body = (await app.inject({ method: 'GET', url: '/healthz' })).json<{ commit: string; startedAt: string }>();
    expect(body.commit).toMatch(/^([0-9a-f]{7}|dev)$/);
    expect(Number.isNaN(new Date(body.startedAt).getTime())).toBe(false);
  });

  it('readyz is unchanged: it carries no build info', async () => {
    app = await buildApp({ cfg, build: BUILD, readiness: async () => ({ dbOk: true, jobsOk: true }) });
    expect((await app.inject({ method: 'GET', url: '/readyz' })).json()).toEqual({ ok: true, dbOk: true, jobsOk: true });
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { isApiPath } from './spa.js';

const cfg = parseConfig({ NODE_ENV: 'test', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32), DATABASE_URL: 'postgres://u:p@h/db' });
let app: FastifyInstance;
afterEach(async () => { await app?.close(); });

describe('isApiPath', () => {
  it('recognizes api and health paths and nothing else', () => {
    expect(isApiPath('/api/team')).toBe(true);
    expect(isApiPath('/api')).toBe(true);
    expect(isApiPath('/healthz')).toBe(true);
    expect(isApiPath('/readyz?x=1')).toBe(true);
    expect(isApiPath('/team')).toBe(false);
    expect(isApiPath('/')).toBe(false);
  });
});

describe('spa fallback', () => {
  it('serves index.html for app routes, 404 JSON for unknown api routes, and never caches index', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'outreach-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Outreach</title>');
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), spaDist: dist });
    const page = await app.inject({ method: 'GET', url: '/team' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.body).toContain('Outreach');
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
  it('returns 503 SPA_NOT_BUILT when the bundle is absent', async () => {
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), spaDist: '/nonexistent/dist' });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(503);
  });
});

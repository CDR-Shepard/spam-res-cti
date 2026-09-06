import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { parseConfig } from '../config.js';
import { isApiPath, NO_STORE } from './spa.js';

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
    expect(isApiPath('/healthzone')).toBe(false);
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
    expect(page.headers['cache-control']).toBe(NO_STORE);
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
  it('sets cache headers the same way for /, index.html, and the SPA fallback, and immutable for a hashed asset', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'outreach-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Outreach</title>');
    writeFileSync(join(dist, 'app.abc123.js'), 'console.log("app")');
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), spaDist: dist });

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.headers['cache-control']).toBe(NO_STORE);

    const indexHtml = await app.inject({ method: 'GET', url: '/index.html' });
    expect(indexHtml.statusCode).toBe(200);
    expect(indexHtml.headers['cache-control']).toBe(NO_STORE);

    const asset = await app.inject({ method: 'GET', url: '/app.abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    const teamPage = await app.inject({ method: 'GET', url: '/team' });
    expect(teamPage.statusCode).toBe(200);
    expect(teamPage.headers['cache-control']).toBe(NO_STORE);
  });
});

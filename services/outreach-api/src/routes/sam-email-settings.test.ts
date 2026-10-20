import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { SamEmailSettings } from '@cti/contracts';
import { schema } from '@cti/db';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import type { EmailWriter } from '../email/writer.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { registerSamEmailSettingsRoutes } from './sam-email-settings.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: 'U-ADMIN', orgId: 'O1', email: 'admin@example.com', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', isAdmin: false };
const auth = { authorization: 'Bearer t' };
const EMAIL_CFG = { RESEND_API_KEY: 're_test_key', RESEND_WEBHOOK_SECRET: 'whsec_dGVzdHNlY3JldA==' };
const PAUSED_AT = '2026-10-19T08:00:00.000Z';
const WRITER: EmailWriter = { write: async () => { throw new Error('the settings route never asks for a draft'); } };

describe('Sam email settings routes', () => {
  let app: FastifyInstance;
  /** `configured`: Resend is set up; `writer` defaults to one exactly when it is (the server's normal setup). */
  async function build(opts: { settings?: unknown; configured?: boolean; writer?: EmailWriter | null } = {}) {
    const { db } = fakeDb({ organizations: [{ ...ORG, settings: opts.settings ?? {} }] });
    const execute = vi.fn(async () => {
      throw new Error('the database was written');
    });
    (db as unknown as { execute: unknown }).execute = execute;
    const cfg = testConfig(opts.configured ? EMAIL_CFG : {});
    const writer = opts.writer === undefined ? (opts.configured ? WRITER : null) : opts.writer;
    app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerSamEmailSettingsRoutes(scope, { db, cfg, writer })] });
    return execute;
  }
  const call = (method: 'GET' | 'PUT', payload?: unknown) =>
    app.inject({ method, url: '/api/settings/sam-email', headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  beforeEach(() => {
    state.session = admin;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('401 without a session and 403 ADMIN_ONLY for a non-admin', async () => {
    await build();
    state.session = null;
    expect((await call('GET')).statusCode).toBe(401);
    expect((await call('PUT', { enabled: false })).statusCode).toBe(401);
    state.session = rep;
    for (const res of [await call('GET'), await call('PUT', { enabled: false })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('ADMIN_ONLY');
    }
  });

  it('GET: off and not configured for a fresh tenant on a server without Resend', async () => {
    await build();
    const res = await call('GET');
    expect(res.statusCode).toBe(200);
    expect(SamEmailSettings.parse(res.json())).toEqual({ enabled: false, configured: false, pausedAt: null, pausedReason: null });
  });

  it('GET: the saved switch, the pause and whether Resend is configured', async () => {
    await build({ configured: true, settings: { samEmail: { enabled: true, pausedAt: PAUSED_AT, pausedReason: 'complaint' } } });
    expect((await call('GET')).json()).toEqual({ enabled: true, configured: true, pausedAt: PAUSED_AT, pausedReason: 'complaint' });
  });

  it('PUT enabled:true while Resend is not configured is 409 EMAIL_NOT_CONFIGURED and writes nothing', async () => {
    const execute = await build();
    const res = await call('PUT', { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EMAIL_NOT_CONFIGURED');
    expect(execute).not.toHaveBeenCalled();
  });

  it('Resend set up but no writer (no Anthropic key or an unpriced EMAIL_MODEL): configured false, and PUT enabled:true is 409', async () => {
    const execute = await build({ configured: true, writer: null, settings: { samEmail: { enabled: false } } });
    expect((await call('GET')).json()).toEqual({ enabled: false, configured: false, pausedAt: null, pausedReason: null });
    const res = await call('PUT', { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('EMAIL_NOT_CONFIGURED');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([[{}], [{ enabled: 'yes' }], [{ enabled: null }]])('PUT %j is 400 INVALID_BODY', async (body) => {
    await build({ configured: true });
    const res = await call('PUT', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_BODY');
  });
});

describe.skipIf(!pgLane)('Sam email settings routes (real Postgres)', () => {
  let t: TestDb;
  let configured: FastifyInstance;
  let unconfigured: FastifyInstance;
  beforeAll(async () => {
    t = await createTestDb();
    const build = (cfg: ReturnType<typeof testConfig>, writer: EmailWriter | null) =>
      buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerSamEmailSettingsRoutes(scope, { db: t.db, cfg, writer })] });
    configured = await build(testConfig(EMAIL_CFG), WRITER);
    unconfigured = await build(testConfig(), null);
  }, 120_000);
  afterAll(async () => {
    await configured?.close();
    await unconfigured?.close();
    await t?.drop();
  });
  const asAdminOf = (orgId: string) => {
    state.session = { userId: randomUUID(), orgId, email: 'admin@example.com', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
  };
  const put = (on: FastifyInstance, enabled: boolean) => on.inject({ method: 'PUT', url: '/api/settings/sam-email', headers: auth, payload: { enabled } });
  const settingsOf = async (orgId: string) =>
    (await t.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId)))[0]!.settings;

  it('turning it on clears a pause and keeps every other setting; GET reads it back', async () => {
    const orgId = await seedOrg(t.db, { aiCallConcurrency: 3, samEmail: { enabled: false, pausedAt: PAUSED_AT, pausedReason: 'complaint' } });
    asAdminOf(orgId);
    const res = await put(configured, true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, configured: true, pausedAt: null, pausedReason: null });
    expect(await settingsOf(orgId)).toEqual({ aiCallConcurrency: 3, samEmail: { enabled: true } });
    expect((await configured.inject({ method: 'GET', url: '/api/settings/sam-email', headers: auth })).json()).toEqual(res.json());
  });

  it('turning it off works even when Resend is not configured, and keeps a pause', async () => {
    const orgId = await seedOrg(t.db, { samEmail: { enabled: true, pausedAt: PAUSED_AT, pausedReason: 'complaint' } });
    asAdminOf(orgId);
    const res = await put(unconfigured, false);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, configured: false, pausedAt: PAUSED_AT, pausedReason: 'complaint' });
    expect((await put(unconfigured, true)).statusCode).toBe(409);
    expect(await settingsOf(orgId)).toEqual({ samEmail: { enabled: false, pausedAt: PAUSED_AT, pausedReason: 'complaint' } });
  });
});

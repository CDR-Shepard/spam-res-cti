/**
 * The seller conversation API's gates, without a database: a session is required, drafts and sends are for
 * admins, and a malformed record id or body is refused before anything is read. The flows on real tables are in
 * sellers.pg.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerSellerRoutes } from './sellers.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: 'U-ADMIN', orgId: 'O1', email: 'admin@example.com', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', isAdmin: false };
const SF_ID = '00Q000000000001AAA';
const auth = { authorization: 'Bearer t' };
const SEND = { subject: 'Your home', body: 'Hi Pat.', practice: false };

let app: FastifyInstance;
let execute: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  state.session = admin;
  const { db } = fakeDb({ organizations: [ORG] });
  // Nothing here may reach the database past the session check.
  execute = vi.fn(async () => {
    throw new Error('the database was read');
  });
  (db as unknown as { execute: unknown }).execute = execute;
  app = await buildApp({
    cfg: testConfig(),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerSellerRoutes(scope, { db, writer: null, cfg: testConfig() })],
  });
});
afterEach(async () => {
  await app?.close();
});

const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

const ROUTES = [
  ['GET', `/api/sellers/${SF_ID}/conversation`, undefined],
  ['PUT', `/api/sellers/${SF_ID}/handler`, { handler: 'person' }],
  ['POST', `/api/sellers/${SF_ID}/email/draft`, { practice: false }],
  ['POST', `/api/sellers/${SF_ID}/email/send`, SEND],
] as const;

describe('seller conversation routes: gates', () => {
  it('401 without a session on every route', async () => {
    state.session = null;
    for (const [method, url, payload] of ROUTES) expect((await call(method, url, payload)).statusCode, url).toBe(401);
  });

  it('a draft and a send are for admins only (403 ADMIN_ONLY), decided before anything is read', async () => {
    state.session = rep;
    for (const [method, url, payload] of ROUTES.slice(2)) {
      const res = await call(method, url, payload);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('ADMIN_ONLY');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('a malformed Salesforce id is 400 INVALID_ID on every route', async () => {
    for (const [method, url, payload] of ROUTES) {
      const res = await call(method, url.replace(SF_ID, 'not-an-id'), payload);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code).toBe('INVALID_ID');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['handler', 'PUT', { handler: 'robot' }],
    ['email/draft', 'POST', {}],
    ['email/send', 'POST', { ...SEND, subject: 'two\nlines' }],
    ['email/send', 'POST', { ...SEND, body: '' }],
    ['email/send', 'POST', { subject: 'Hi', body: 'Hi' }],
  ] as const)('%s with an invalid body is 400 INVALID_BODY', async (path, method, payload) => {
    const res = await call(method, `/api/sellers/${SF_ID}/${path}`, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_BODY');
    expect(execute).not.toHaveBeenCalled();
  });
});

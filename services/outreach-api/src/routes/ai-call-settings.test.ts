import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@cti/db';
import { WritebackReadiness } from '@cti/contracts';
import { SalesforceApiError } from '@cti/salesforce';
import { buildApp } from '../app.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { fakeSalesforce, type QueryRoute } from '../test/fake-sf-client.js';
import { fakeSfWrites, userInfoAnswer } from '../test/fake-sf-writes.js';
import { prodDescribe } from '../test/writeback-describes.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { createTestDb, pgLane } from '../test/pg.js';
import { seedOrg } from '../test/outreach-fixtures.js';
import { registerAiCallSettingsRoutes } from './ai-call-settings.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const GRANT = '0058X00000Fsx39QAB';
const OTHER = '0058X00000Abcd1QAB';
const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: {} };
const admin = { userId: 'U-ADMIN', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const rep = { ...admin, userId: 'U-REP', isAdmin: false };
const auth = { authorization: 'Bearer t' };
// Final review WEB I-2: booking, conversion and write-back are off until an admin turns them on.
const DEFAULTS = { booking: { ...DEFAULT_AI_CALL_BOOKING, specialists: [] as string[] }, writeback: false };

let app: FastifyInstance;
async function build(opts: { settings?: unknown; queries?: QueryRoute[]; clients?: SalesforceClientFactory; defaultSpecialists?: string[] } = {}) {
  const { db } = fakeDb({ organizations: [{ ...ORG, settings: opts.settings ?? {} }] });
  const sf = fakeSalesforce({ queries: opts.queries ?? [] });
  const clients = opts.clients ?? (async () => sf.client);
  app = await buildApp({
    cfg: testConfig(),
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerAiCallSettingsRoutes(scope, { db, clients, defaultSpecialists: opts.defaultSpecialists ?? [] })],
  });
  return sf;
}
const call = (method: 'GET' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

beforeEach(() => {
  state.session = admin;
});
afterEach(async () => {
  await app?.close();
});

describe('AI call settings routes', () => {
  it('401 without a session and 403 for a non-admin on every route', async () => {
    await build();
    const routes = [['GET', '/api/settings/ai-calls'], ['PUT', '/api/settings/ai-calls'], ['GET', '/api/salesforce/users?search=Grant'], ['GET', '/api/settings/ai-calls/readiness']] as const;
    state.session = null;
    for (const [method, url] of routes) expect((await call(method, url, method === 'PUT' ? DEFAULTS : undefined)).statusCode, url).toBe(401);
    state.session = rep;
    for (const [method, url] of routes) {
      const res = await call(method, url, method === 'PUT' ? DEFAULTS : undefined);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('ADMIN_ONLY');
    }
  });

  describe('GET /settings/ai-calls', () => {
    it('an empty settings blob gives the defaults: booking, conversion and write-back off', async () => {
      await build();
      const res = await call('GET', '/api/settings/ai-calls');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(DEFAULTS);
      expect(res.json()).toMatchObject({ booking: { enabled: false, convertLeads: false }, writeback: false });
    });

    it('the configured default list fills a tenant that never saved one; a saved blob wins', async () => {
      await build({ defaultSpecialists: [GRANT] });
      expect((await call('GET', '/api/settings/ai-calls')).json().booking.specialists).toEqual([GRANT]);
      await app.close();
      const saved = { ...DEFAULT_AI_CALL_BOOKING, specialists: [OTHER], convertLeads: false };
      await build({ defaultSpecialists: [GRANT], settings: { aiCallBooking: saved, aiCallWriteback: false } });
      expect((await call('GET', '/api/settings/ai-calls')).json()).toEqual({ booking: saved, writeback: false });
    });
  });

  describe('PUT /settings/ai-calls validation', () => {
    it.each([
      ['endHour <= startHour', { ...DEFAULTS, booking: { ...DEFAULTS.booking, phone: { ...DEFAULTS.booking.phone, startHour: 12, endHour: 12 } } }],
      ['a bad specialist id', { ...DEFAULTS, booking: { ...DEFAULTS.booking, specialists: ['abc'] } }],
      ['a missing writeback', { booking: DEFAULTS.booking }],
      ['an unknown key', { ...DEFAULTS, extra: 1 }],
      ['no body', undefined],
    ])('%s gives 400 INVALID_BODY', async (_label, body) => {
      await build();
      const res = await call('PUT', '/api/settings/ai-calls', body);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_BODY');
    });
  });

  describe('fix 2: booking can only be on while write-back is on', () => {
    const booked = { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] };

    it('PUT booking on with write-back off is a 400 BOOKING_NEEDS_WRITEBACK that says why, and saves nothing', async () => {
      await build();
      const res = await call('PUT', '/api/settings/ai-calls', { booking: booked, writeback: false });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: 'BOOKING_NEEDS_WRITEBACK' });
      expect(res.json().error).toMatch(/turn on salesforce write-back first/i);
    });

    it('a settings blob saved that way before this rule reads as booking off (never offers times that are not written back)', async () => {
      await build({ settings: { aiCallBooking: booked, aiCallWriteback: false } });
      expect((await call('GET', '/api/settings/ai-calls')).json()).toEqual({ booking: { ...booked, enabled: false }, writeback: false });
    });

    it('booking on with write-back on reads as saved', async () => {
      await build({ settings: { aiCallBooking: booked, aiCallWriteback: true } });
      expect((await call('GET', '/api/settings/ai-calls')).json()).toEqual({ booking: booked, writeback: true });
    });
  });

  describe('GET /salesforce/users', () => {
    const userRows = [
      { Id: GRANT, Name: 'Grant Golden', Title: 'Acquisitions', IsActive: true },
      { Id: OTHER, Name: "Pat O'Brien", Title: null, IsActive: false },
    ];

    it('searches active standard users by name, escaping quotes and LIKE wildcards', async () => {
      const sf = await build({ queries: [[/FROM User/, userRows]] });
      const res = await call('GET', `/api/salesforce/users?search=${encodeURIComponent("O'Brien%")}`);
      expect(res.statusCode).toBe(200);
      expect(sf.soql).toEqual([
        "SELECT Id, Name, Title, IsActive FROM User WHERE IsActive = true AND UserType = 'Standard' AND Name LIKE '%O\\'Brien\\%%' ORDER BY Name LIMIT 25",
      ]);
      expect(res.json()).toEqual([
        { id: GRANT, name: 'Grant Golden', title: 'Acquisitions', isActive: true },
        { id: OTHER, name: "Pat O'Brien", title: null, isActive: false },
      ]);
    });

    it('escapes an underscore and a backslash too', async () => {
      const sf = await build({ queries: [[/FROM User/, []]] });
      await call('GET', `/api/salesforce/users?search=${encodeURIComponent('a_b\\c')}`);
      expect(sf.soql[0]).toContain("Name LIKE '%a\\_b\\\\c%'");
    });

    it('reads users by id, inactive ones included, in the order asked', async () => {
      const sf = await build({ queries: [[/FROM User/, userRows]] });
      const res = await call('GET', `/api/salesforce/users?ids=${OTHER},${GRANT}`);
      expect(res.statusCode).toBe(200);
      expect(sf.soql).toEqual([`SELECT Id, Name, Title, IsActive FROM User WHERE Id IN ('${OTHER}', '${GRANT}')`]);
      expect(res.json().map((u: { id: string }) => u.id)).toEqual([OTHER, GRANT]);
      expect(res.json()[0].isActive).toBe(false);
    });

    it('skips rows Salesforce returns without an id or name', async () => {
      await build({ queries: [[/FROM User/, [{ Id: null, Name: 'X' }, { Id: GRANT, Name: '' }, userRows[0]!]]] });
      expect((await call('GET', '/api/salesforce/users?search=Gr')).json()).toEqual([{ id: GRANT, name: 'Grant Golden', title: 'Acquisitions', isActive: true }]);
    });

    it.each([
      ['a one-character search', '?search=G'],
      ['a 41-character search', `?search=${'a'.repeat(41)}`],
      ['neither search nor ids', ''],
      ['both search and ids', `?search=Grant&ids=${GRANT}`],
      ['a bad id', `?ids=${GRANT},abc`],
      ['a quote in an id', `?ids=${encodeURIComponent("005' OR Id != '")}`],
      ['more than 20 ids', `?ids=${Array.from({ length: 21 }, (_, i) => `005000000000${String(i).padStart(3, '0')}`).join(',')}`],
    ])('%s gives 400 and no query', async (_label, qs) => {
      const sf = await build({ queries: [[/FROM User/, userRows]] });
      const res = await call('GET', `/api/salesforce/users${qs}`);
      expect(res.statusCode).toBe(400);
      expect(sf.soql).toEqual([]);
    });

    it('no Salesforce connection gives 409 CRM_NOT_CONNECTED; a Salesforce error gives 502', async () => {
      await build({ clients: async () => { throw new CrmNotConnectedError(); } });
      const res = await call('GET', '/api/salesforce/users?search=Grant');
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CRM_NOT_CONNECTED');
      await app.close();
      await build({ queries: [[/FROM User/, new SalesforceApiError('boom', 500, null)]] });
      expect((await call('GET', '/api/salesforce/users?search=Grant')).statusCode).toBe(502);
    });
  });

  describe('GET /settings/ai-calls/readiness', () => {
    it('answers the write-back and conversion readiness for the tenant\'s owner list', async () => {
      const f = fakeSfWrites({
        describes: Object.fromEntries(['Lead', 'Opportunity', 'Event', 'Task', 'FeedItem', 'Account', 'Contact'].map((n) => [n, n === 'Lead' || n === 'Opportunity' ? prodDescribe(n) : { name: n, fields: [], createable: true }])),
        queries: [[/FROM PermissionSetAssignment/, [{ Id: '0Pa8X00000Psa1QAA' }]], [/FROM User/, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: true }]]],
      });
      f.onSoap = () => userInfoAnswer('0058X0000Integ1QAA');
      await build({ clients: async () => f.client, defaultSpecialists: [GRANT] });
      const res = await call('GET', '/api/settings/ai-calls/readiness');
      expect(res.statusCode).toBe(200);
      expect(WritebackReadiness.parse(res.json())).toMatchObject({ ready: true, convertReady: true, appointmentOwner: { id: GRANT, name: 'Grant Golden' }, items: [] });
    });

    it('no Salesforce connection: 409 CRM_NOT_CONNECTED', async () => {
      await build({ clients: async () => { throw new CrmNotConnectedError(); } });
      const res = await call('GET', '/api/settings/ai-calls/readiness');
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('CRM_NOT_CONNECTED');
    });
  });
});

describe.skipIf(!pgLane)('AI call settings routes (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let pgApp: FastifyInstance;
  beforeAll(async () => {
    t = await createTestDb();
    pgApp = await buildApp({
      cfg: testConfig(),
      readiness: async () => ({ dbOk: true, jobsOk: true }),
      apiRoutes: [(scope) => registerAiCallSettingsRoutes(scope, { db: t.db, clients: async () => { throw new CrmNotConnectedError(); }, defaultSpecialists: [GRANT] })],
    });
  }, 120_000);
  afterAll(async () => {
    await pgApp?.close();
    await t?.drop();
  });
  const asAdminOf = (orgId: string) => {
    state.session = { userId: randomUUID(), orgId, email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
  };
  const pgCall = (method: 'GET' | 'PUT', payload?: unknown) =>
    pgApp.inject({ method, url: '/api/settings/ai-calls', headers: auth, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  it('PUT stores the blob beside the other settings, returns it, and GET returns it', async () => {
    const orgId = await seedOrg(t.db, { aiCallConcurrency: 3, aiCallBooking: 'junk' });
    asAdminOf(orgId);
    expect((await pgCall('GET')).json()).toEqual({ booking: { ...DEFAULT_AI_CALL_BOOKING, specialists: [GRANT] }, writeback: false });

    const next = { booking: { ...DEFAULT_AI_CALL_BOOKING, specialists: [OTHER, GRANT], convertLeads: false, days: [1, 2, 3] }, writeback: false };
    const put = await pgCall('PUT', next);
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual(next);
    expect((await pgCall('GET')).json()).toEqual(next);

    const [org] = await t.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org!.settings).toEqual({ aiCallConcurrency: 3, aiCallBooking: next.booking, aiCallWriteback: false });
  });

  it('fix 2: PUT refuses booking on with write-back off and keeps what was stored; booking and write-back both on are stored', async () => {
    const orgId = await seedOrg(t.db, { aiCallConcurrency: 3 });
    asAdminOf(orgId);
    const booked = { ...DEFAULT_AI_CALL_BOOKING, enabled: true, specialists: [GRANT] };
    const refused = await pgCall('PUT', { booking: booked, writeback: false });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe('BOOKING_NEEDS_WRITEBACK');
    const [before] = await t.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(before!.settings).toEqual({ aiCallConcurrency: 3 });
    const both = { booking: booked, writeback: true };
    expect((await pgCall('PUT', both)).json()).toEqual(both);
    expect((await pgCall('GET')).json()).toEqual(both);
  });

  it('a saved empty list stays empty (the configured default no longer applies)', async () => {
    const orgId = await seedOrg(t.db);
    asAdminOf(orgId);
    const empty = { booking: { ...DEFAULT_AI_CALL_BOOKING, specialists: [] }, writeback: true };
    expect((await pgCall('PUT', empty)).statusCode).toBe(200);
    expect((await pgCall('GET')).json().booking.specialists).toEqual([]);
  });
});

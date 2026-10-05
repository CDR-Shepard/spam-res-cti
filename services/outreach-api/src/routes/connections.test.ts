import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { decryptString, encryptString } from '@cti/auth';
import { CrmConnectionStatus, StartConnectionResponse, type FieldMap } from '@cti/contracts';
import { schema } from '@cti/db';
import type { SalesforceClient, SObjectDescribe } from '@cti/salesforce';
import { buildApp } from '../app.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { defaultFieldMap } from '../crm/field-map.js';
import { fakeDb, testConfig, type Fixtures } from '../test/harness.js';
import { registerConnectionRoutes, STATE_COOKIE } from './connections.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const SF_ENV = { SALESFORCE_CLIENT_ID: 'cid', SALESFORCE_REDIRECT_URI: 'http://api.test/api/connections/salesforce/callback' };
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const admin = { userId: ADMIN_ID, orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const member = { ...admin, isAdmin: false };
const auth = { authorization: 'Bearer t' };
const sql = (w: unknown) => new PgDialect().sqlToQuery(w as SQL);

const field = (name: string, type = 'string') => ({ name, type, label: name, length: 255 });
const LEAD: SObjectDescribe = { name: 'Lead', fields: [field('Id', 'id'), field('MobilePhone', 'phone'), field('Phone', 'phone'), field('Email', 'email'), field('DoNotCall', 'boolean'), field('HasOptedOutOfEmail', 'boolean'), field('State'), field('Notes__c', 'textarea')] };
const OPPORTUNITY: SObjectDescribe = { name: 'Opportunity', fields: [field('Id', 'id'), field('Description', 'textarea'), field('Mobile_Phone__c', 'phone'), field('Phone__c', 'phone')] };
const DEFAULT_MAP = defaultFieldMap({ Lead: LEAD, Opportunity: OPPORTUNITY });

const TOKEN_RESPONSE = {
  access_token: 'AT-plain', refresh_token: 'RT-plain', instance_url: 'https://gg.my.salesforce.com',
  id: 'https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA', token_type: 'Bearer', issued_at: '1759600000000', signature: 'sig', scope: 'api refresh_token offline_access',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function urlOf(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : String(input));
}
/** Stands in for login.salesforce.com and the instance: token exchange, describe, and the username query. */
function salesforceFetch(over: { tokenStatus?: number } = {}) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = urlOf(input);
    if (url.pathname === '/services/oauth2/token') {
      return over.tokenStatus ? json({ error: 'invalid_grant', error_description: 'expired authorization code' }, over.tokenStatus) : json(TOKEN_RESPONSE);
    }
    if (url.pathname.endsWith('/sobjects/Lead/describe')) return json(LEAD);
    if (url.pathname.endsWith('/sobjects/Opportunity/describe')) return json(OPPORTUNITY);
    if (url.pathname.endsWith('/query')) return json({ totalSize: 1, done: true, records: [{ attributes: { type: 'User' }, Username: 'integration@gg.co' }] });
    return json([{ errorCode: 'NOT_FOUND', message: url.pathname }], 404);
  });
}

let app: FastifyInstance;
let fixture: ReturnType<typeof fakeDb>;
let fetchImpl: ReturnType<typeof salesforceFetch>;
let clients: ReturnType<typeof vi.fn<SalesforceClientFactory>>;
const stubClient = { describe: vi.fn(async (o: string) => (o === 'Lead' ? LEAD : OPPORTUNITY)) };

async function build(fx: Fixtures = {}, env: Record<string, string> = SF_ENV): Promise<FastifyInstance> {
  const cfg = testConfig(env);
  fixture = fakeDb({ organizations: [org], ...fx });
  fetchImpl = salesforceFetch();
  return buildApp({
    cfg,
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerConnectionRoutes(scope, { db: fixture.db, cfg, clients, fetchImpl: ((...a: Parameters<typeof fetch>) => fetchImpl(...a)) as typeof fetch })],
  });
}

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'CONN1', orgId: 'O1', provider: 'salesforce', instanceUrl: 'https://gg.my.salesforce.com', sfOrgId: '00D000000000001AAA', sfUserId: '005000000000001AAA', sfUsername: 'integration@gg.co',
    accessTokenEnc: encryptString('AT-stored'), refreshTokenEnc: encryptString('RT-stored'), status: 'connected', lastError: null, fieldMap: DEFAULT_MAP,
    connectedBy: ADMIN_ID, connectedAt: new Date('2026-10-01T12:00:00Z'), updatedAt: new Date('2026-10-01T12:00:00Z'), ...over,
  };
}
function stateRow(over: Record<string, unknown> = {}) {
  return { id: 'S1', orgId: 'O1', userId: ADMIN_ID, state: 'st-1', codeVerifier: 'ver-1', createdAt: new Date(), ...over };
}

beforeEach(async () => {
  vi.stubEnv('TOKEN_ENCRYPTION_KEY', 'ab'.repeat(32));
  state.session = admin;
  clients = vi.fn<SalesforceClientFactory>(async () => stubClient as unknown as SalesforceClient);
  app = await build();
});
afterEach(async () => { await app.close(); vi.unstubAllEnvs(); });

describe('GET /api/connections/salesforce', () => {
  it('shows any member the tenant connection without token material, tenant-scoped', async () => {
    await app.close();
    app = await build({ tables: { crmConnections: [connectionRow()] } });
    state.session = member;
    const res = await app.inject({ method: 'GET', url: '/api/connections/salesforce', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(CrmConnectionStatus.parse(res.json())).toEqual({
      configured: true, connected: true, status: 'connected', instanceUrl: 'https://gg.my.salesforce.com', username: 'integration@gg.co',
      connectedAt: '2026-10-01T12:00:00.000Z', lastError: null, fieldMap: DEFAULT_MAP,
    });
    expect(res.body).not.toContain('v1:');
    expect(res.body).not.toContain('Enc');
    const where = sql(fixture.captured.where.at(-1)).sql;
    expect(where).toContain('"crm_connections"."org_id" = $1');
  });

  it('reports not connected, and configured=false when the server has no Salesforce env', async () => {
    const none = await app.inject({ method: 'GET', url: '/api/connections/salesforce', headers: auth });
    expect(none.json()).toMatchObject({ configured: true, connected: false, status: null, fieldMap: null });
    await app.close();
    app = await build({}, {});
    const off = await app.inject({ method: 'GET', url: '/api/connections/salesforce', headers: auth });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({ configured: false, connected: false });
  });

  it('shows a broken connection with its error', async () => {
    await app.close();
    app = await build({ tables: { crmConnections: [connectionRow({ status: 'broken', lastError: 'Token refresh failed: invalid_grant' })] } });
    const res = await app.inject({ method: 'GET', url: '/api/connections/salesforce', headers: auth });
    expect(res.json()).toMatchObject({ connected: false, status: 'broken', lastError: 'Token refresh failed: invalid_grant' });
  });
});

describe('POST /api/connections/salesforce/start', () => {
  it('stores a PKCE state for this tenant and admin, binds it to the browser by cookie, and returns the authorize url', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/connections/salesforce/start', headers: auth });
    expect(res.statusCode).toBe(200);
    const { url } = StartConnectionResponse.parse(res.json());
    const insert = fixture.writes.find((w) => w.table === schema.crmOauthStates)!;
    expect(insert.values).toMatchObject({ orgId: 'O1', userId: ADMIN_ID, state: expect.any(String), codeVerifier: expect.any(String) });
    const params = new URL(url).searchParams;
    expect(params.get('state')).toBe(insert.values.state);
    expect(params.get('client_id')).toBe('cid');
    expect(params.get('code_challenge')).toBeTruthy();
    expect(params.get('code_challenge')).not.toBe(insert.values.codeVerifier);
    expect(url).not.toContain(String(insert.values.codeVerifier));
    const cookie = res.cookies.find((c) => c.name === STATE_COOKIE)!;
    expect(cookie).toMatchObject({ value: insert.values.state, httpOnly: true, path: '/api/connections/salesforce/callback', sameSite: 'Lax', maxAge: 600 });
    // Expired states of this tenant are cleared as a new flow starts.
    const cleanup = sql(fixture.captured.where.at(-1)).sql;
    expect(cleanup).toContain('"crm_oauth_states"."org_id" = $1');
    expect(cleanup).toContain('"crm_oauth_states"."created_at" < $2');
  });

  it('503 SALESFORCE_DISABLED when the server has no Salesforce config', async () => {
    await app.close();
    app = await build({}, {});
    const res = await app.inject({ method: 'POST', url: '/api/connections/salesforce/start', headers: auth });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SALESFORCE_DISABLED' });
  });
});

describe('admin-only connection routes', () => {
  it.each([
    ['POST', '/api/connections/salesforce/start', undefined],
    ['PUT', '/api/connections/salesforce/field-map', DEFAULT_MAP],
    ['DELETE', '/api/connections/salesforce', undefined],
  ] as const)('%s %s is 403 ADMIN_ONLY for a member and touches nothing', async (method, url, payload) => {
    state.session = member;
    const res = await app.inject({ method, url, headers: auth, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ADMIN_ONLY' });
    expect(fixture.writes).toEqual([]);
    expect(fixture.deletes).toEqual([]);
    expect(clients).not.toHaveBeenCalled();
  });
});

describe('GET /api/connections/salesforce/callback', () => {
  const callback = (query: string, cookie: string | null = 'st-1') =>
    app.inject({ method: 'GET', url: `/api/connections/salesforce/callback?${query}`, ...(cookie ? { cookies: { [STATE_COOKIE]: cookie } } : {}) });

  it('exchanges the code, describes with the new token, saves encrypted tokens and the default field map for the state row tenant, then redirects', async () => {
    await app.close();
    app = await build({ deleteReturning: [stateRow()] });
    const res = await callback('code=abc&state=st-1');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/settings/connections?connected=1');
    // The state is consumed (single use) by its value.
    expect(fixture.deletes).toEqual([{ table: schema.crmOauthStates }]);
    expect(sql(fixture.captured.where[0]).sql).toBe('"crm_oauth_states"."state" = $1');
    // The code exchange carried the stored PKCE verifier.
    const tokenCall = fetchImpl.mock.calls.find(([input]) => urlOf(input).pathname === '/services/oauth2/token')!;
    const form = new URLSearchParams(String(tokenCall[1]?.body));
    expect(form.get('code')).toBe('abc');
    expect(form.get('code_verifier')).toBe('ver-1');
    const insert = fixture.writes.find((w) => w.table === schema.crmConnections)!;
    expect(insert.values).toMatchObject({
      orgId: 'O1', connectedBy: ADMIN_ID, instanceUrl: 'https://gg.my.salesforce.com', sfOrgId: '00D000000000001AAA', sfUserId: '005000000000001AAA',
      sfUsername: 'integration@gg.co', status: 'connected', fieldMap: DEFAULT_MAP,
    });
    expect(insert.values.accessTokenEnc).not.toBe('AT-plain');
    expect(JSON.stringify(insert.values)).not.toContain('AT-plain');
    expect(JSON.stringify(insert.values)).not.toContain('RT-plain');
    expect(decryptString(insert.values.accessTokenEnc as string)).toBe('AT-plain');
    expect(decryptString(insert.values.refreshTokenEnc as string)).toBe('RT-plain');
    expect(res.cookies.find((c) => c.name === STATE_COOKIE)?.value).toBe('');
  });

  it('keeps an admin-edited field map when reconnecting the same Salesforce org', async () => {
    const edited: FieldMap = { ...DEFAULT_MAP, Lead: { ...DEFAULT_MAP.Lead, notes: ['Notes__c'] } };
    await app.close();
    app = await build({ deleteReturning: [stateRow()], tables: { crmConnections: [connectionRow({ fieldMap: edited })] } });
    await callback('code=abc&state=st-1');
    expect(fixture.writes.find((w) => w.table === schema.crmConnections)!.values.fieldMap).toEqual(edited);
  });

  it('uses the default field map when the reconnect is a different Salesforce org', async () => {
    const edited: FieldMap = { ...DEFAULT_MAP, Lead: { ...DEFAULT_MAP.Lead, notes: ['Notes__c'] } };
    await app.close();
    app = await build({ deleteReturning: [stateRow()], tables: { crmConnections: [connectionRow({ fieldMap: edited, sfOrgId: '00D000000000999AAA' })] } });
    await callback('code=abc&state=st-1');
    expect(fixture.writes.find((w) => w.table === schema.crmConnections)!.values.fieldMap).toEqual(DEFAULT_MAP);
  });

  it.each([
    ['an unknown state', [], 'code=abc&state=st-1', 'st-1'],
    ['a state older than 10 minutes', [stateRow({ createdAt: new Date(Date.now() - 11 * 60_000) })], 'code=abc&state=st-1', 'st-1'],
    ['no state cookie (another browser)', [stateRow()], 'code=abc&state=st-1', null],
    ['a state cookie for a different flow', [stateRow()], 'code=abc&state=st-1', 'st-2'],
    ['no state parameter', [stateRow()], 'code=abc', 'st-1'],
  ])('rejects %s: 302 to ?error=bad_state, no exchange, nothing saved', async (_label, rows, query, cookie) => {
    await app.close();
    app = await build({ deleteReturning: rows });
    const res = await callback(query, cookie);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/settings/connections?error=bad_state');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });

  it('a cookie mismatch does not consume the stored state', async () => {
    await app.close();
    app = await build({ deleteReturning: [stateRow()] });
    await callback('code=abc&state=st-1', 'st-2');
    expect(fixture.deletes).toEqual([]);
  });

  it('a user who declines at Salesforce lands on ?error=access_denied', async () => {
    await app.close();
    app = await build({ deleteReturning: [stateRow()] });
    const res = await callback('error=access_denied&error_description=end-user+denied&state=st-1');
    expect(res.headers.location).toBe('http://app.test/settings/connections?error=access_denied');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a failed code exchange lands on ?error=exchange_failed and saves nothing', async () => {
    await app.close();
    app = await build({ deleteReturning: [stateRow()] });
    fetchImpl = salesforceFetch({ tokenStatus: 400 });
    const res = await callback('code=abc&state=st-1');
    expect(res.headers.location).toBe('http://app.test/settings/connections?error=exchange_failed');
    expect(fixture.writes).toEqual([]);
  });

  it('redirects with ?error=salesforce_disabled when the server has no Salesforce config', async () => {
    await app.close();
    app = await build({ deleteReturning: [stateRow()] }, {});
    const res = await callback('code=abc&state=st-1');
    expect(res.headers.location).toBe('http://app.test/settings/connections?error=salesforce_disabled');
  });
});

describe('PUT /api/connections/salesforce/field-map', () => {
  const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/connections/salesforce/field-map', headers: auth, payload: payload as object });

  it('checks every field against describe, saves tenant-scoped, and returns the updated status', async () => {
    const next: FieldMap = { ...DEFAULT_MAP, Lead: { ...DEFAULT_MAP.Lead, notes: ['Notes__c'] } };
    await app.close();
    app = await build({ updateReturning: [connectionRow({ fieldMap: next })] });
    const res = await put(next);
    expect(res.statusCode).toBe(200);
    expect(res.json().fieldMap).toEqual(next);
    expect(clients).toHaveBeenCalledWith('O1');
    expect(fixture.writes).toEqual([expect.objectContaining({ op: 'update', table: schema.crmConnections, values: expect.objectContaining({ fieldMap: next }) })]);
    expect(sql(fixture.captured.where.at(-1)).sql).toContain('"crm_connections"."org_id" = $1');
  });

  it('400 for a body that is not a FieldMap', async () => {
    const res = await put({ Lead: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION' });
  });

  it('422 INVALID_FIELD_MAP for a name that is not a field API name, before calling Salesforce', async () => {
    const res = await put({ ...DEFAULT_MAP, Lead: { ...DEFAULT_MAP.Lead, notes: ["Notes__c FROM Lead WHERE Name = 'x'"] } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INVALID_FIELD_MAP', details: { problems: [expect.stringContaining('not a field API name')] } });
    expect(clients).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });

  it('422 INVALID_FIELD_MAP naming fields Salesforce does not have', async () => {
    const res = await put({ ...DEFAULT_MAP, Opportunity: { ...DEFAULT_MAP.Opportunity, phones: ['Cell__c'] } });
    expect(res.statusCode).toBe(422);
    expect(res.json().details).toEqual({ problems: ['Opportunity.Cell__c: no such field'] });
    expect(fixture.writes).toEqual([]);
  });

  it('400 DO_NOT_CALL_FIELD_REQUIRED when the Lead Do Not Call field is unmapped, before calling Salesforce', async () => {
    const res = await put({ ...DEFAULT_MAP, Lead: { ...DEFAULT_MAP.Lead, doNotCall: null } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'DO_NOT_CALL_FIELD_REQUIRED', error: expect.stringContaining('Do Not Call') });
    expect(clients).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });

  it('accepts an unmapped Lead email opt-out (no email is sent in phase 1)', async () => {
    const next: FieldMap = { ...DEFAULT_MAP, Lead: { ...DEFAULT_MAP.Lead, emailOptOut: null } };
    await app.close();
    app = await build({ updateReturning: [connectionRow({ fieldMap: next })] });
    const res = await put(next);
    expect(res.statusCode).toBe(200);
    expect(res.json().fieldMap.Lead.emailOptOut).toBeNull();
  });

  it('409 CRM_NOT_CONNECTED when the tenant has no connection', async () => {
    clients.mockRejectedValue(new CrmNotConnectedError());
    const res = await put(DEFAULT_MAP);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CRM_NOT_CONNECTED' });
  });
});

describe('DELETE /api/connections/salesforce', () => {
  it('deletes the tenant connection and answers 204', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/connections/salesforce', headers: auth });
    expect(res.statusCode).toBe(204);
    expect(fixture.deletes).toEqual([{ table: schema.crmConnections }]);
    expect(sql(fixture.captured.where.at(-1)).sql).toContain('"crm_connections"."org_id" = $1');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { FieldMap } from '@cti/contracts';
import type { SalesforceClient } from '@cti/salesforce';
import { buildApp } from '../app.js';
import { CampaignSourceError } from '../campaigns/source.js';
import { MemberIdCache } from '../campaigns/member-cache.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { fakeDb, testConfig, type Fixtures } from '../test/harness.js';
import { registerCampaignSelectionRoutes } from './campaign-selection.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const m = vi.hoisted(() => ({
  memberIds: vi.fn(),
  candidatePage: vi.fn(),
  applyChange: vi.fn(),
}));
vi.mock('../campaigns/member-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../campaigns/member-cache.js')>()),
  campaignMemberIds: m.memberIds,
}));
vi.mock('../campaigns/candidates.js', () => ({ candidatePage: m.candidatePage }));
vi.mock('../campaigns/selection.js', () => ({ applySelectionChange: m.applyChange }));

const cfg = testConfig();
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const admin = { userId: ADMIN_ID, orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const member = { ...admin, isAdmin: false };
const auth = { authorization: 'Bearer t' };
const emptyObject = { notes: [], phones: [], email: null, doNotCall: null, emailOptOut: null, skipOnDialer: null, consent: null, webFormSource: null, state: null, leadManager: null };
const FIELD_MAP: FieldMap = { Lead: { ...emptyObject, phones: ['MobilePhone'] }, Opportunity: emptyObject };
const connection = { id: 'CONN1', orgId: 'O1', provider: 'salesforce', status: 'connected', fieldMap: FIELD_MAP };
const campaignRow = (over: Record<string, unknown> = {}) => ({
  id: CAMPAIGN_ID, orgId: 'O1', name: 'Past sellers', sfObject: 'Lead', sourceKind: 'soql', listViewId: null, soql: 'SELECT Id FROM Lead', mode: 'ai_call', status: 'draft', ...over,
});
const a = '00Q000000000001AAA';
const b = '00Q000000000002AAA';
const nonMember = '00Q000000000009AAA';

let clients: ReturnType<typeof vi.fn<SalesforceClientFactory>>;
let app: FastifyInstance;

async function build(fx: Fixtures = {}): Promise<FastifyInstance> {
  const fixture = fakeDb({ organizations: [org], ...fx, tables: { crmConnections: [connection], campaigns: [campaignRow()], ...fx.tables } });
  return buildApp({
    cfg,
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [(scope) => registerCampaignSelectionRoutes(scope, { db: fixture.db, clients, cache: new MemberIdCache() })],
  });
}

const put = (payload: unknown) => app.inject({ method: 'PUT', url: `/api/campaigns/${CAMPAIGN_ID}/selection`, headers: auth, payload: payload as object });
const get = (query = '') => app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}/candidates${query}`, headers: auth });

beforeEach(async () => {
  state.session = admin;
  clients = vi.fn<SalesforceClientFactory>(async () => ({}) as unknown as SalesforceClient);
  for (const fn of Object.values(m)) fn.mockReset();
  m.memberIds.mockResolvedValue([a, b]);
  m.applyChange.mockResolvedValue(2);
  app = await build();
});

describe('campaign selection routes', () => {
  it('403 ADMIN_ONLY for a member, on both routes', async () => {
    state.session = member;
    for (const res of [await get(), await put({ add: [a] })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'ADMIN_ONLY' });
    }
  });

  it('409 NOT_AI_CALL_CAMPAIGN for a sequence campaign', async () => {
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ mode: 'sequence' })] } });
    for (const res of [await get(), await put({ add: [a] })]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'NOT_AI_CALL_CAMPAIGN' });
    }
  });

  it('409 CAMPAIGN_ARCHIVED on PUT for an archived campaign (GET still reads)', async () => {
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ status: 'archived' })] } });
    const res = await put({ add: [a] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CAMPAIGN_ARCHIVED' });
    m.candidatePage.mockResolvedValue({ total: 0, page: 1, pageSize: 50, pages: 1, selectedCount: 0, records: [] });
    expect((await get()).statusCode).toBe(200);
  });

  it('PUT {add:[member, nonMember]} selects only the member and reports one ignored', async () => {
    const res = await put({ add: [a, nonMember] });
    expect(res.statusCode).toBe(200);
    expect(m.applyChange).toHaveBeenCalledWith(expect.anything(), { orgId: 'O1', campaignId: CAMPAIGN_ID, userId: ADMIN_ID, clear: false, add: [a], remove: [] });
    expect(res.json()).toEqual({ selectedCount: 2, ignored: 1 });
  });

  it('PUT {selectAll:true, remove} hands every member and the removals to ONE applySelectionChange call', async () => {
    const res = await put({ selectAll: true, remove: [b] });
    expect(res.statusCode).toBe(200);
    expect(m.applyChange).toHaveBeenCalledTimes(1);
    expect(m.applyChange).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clear: false, add: [a, b], remove: [b] }));
    expect(res.json().ignored).toBe(0);
  });

  it('PUT {clear:true, add:[x]} is one atomic change (the store clears first, then adds)', async () => {
    expect((await put({ clear: true, add: [b] })).statusCode).toBe(200);
    expect(m.applyChange).toHaveBeenCalledTimes(1);
    expect(m.applyChange).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clear: true, add: [b], remove: [] }));
  });

  it('422 INVALID_SOURCE with the message when the members cannot be read', async () => {
    m.memberIds.mockRejectedValue(new CampaignSourceError('The query returns more than 50,000 records. Narrow the query.', 'too_large'));
    const res = await put({ add: [a] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INVALID_SOURCE', error: 'The query returns more than 50,000 records. Narrow the query.', details: { code: 'too_large' } });
    expect(m.applyChange).not.toHaveBeenCalled();
  });

  it('409 CRM_NOT_CONNECTED without a connection, on both routes', async () => {
    await app.close();
    app = await build({ tables: { crmConnections: [] } });
    const res = await get();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CRM_NOT_CONNECTED' });
    clients.mockRejectedValue(new CrmNotConnectedError());
    const res2 = await put({ add: [a] });
    expect(res2.statusCode).toBe(409);
    expect(res2.json()).toMatchObject({ code: 'CRM_NOT_CONNECTED' });
  });

  it('400 VALIDATION for a page that is not a number, and for an empty or malformed selection change', async () => {
    expect((await get('?page=abc')).statusCode).toBe(400);
    expect((await get('?page=abc')).json()).toMatchObject({ code: 'VALIDATION' });
    expect((await put({})).statusCode).toBe(400);
    expect((await put({ add: ["00Q' OR Id != '"] })).statusCode).toBe(400);
  });

  it('clearing or removing reads no members from Salesforce, so it works while Salesforce is down', async () => {
    m.memberIds.mockRejectedValue(new CrmNotConnectedError());
    expect((await put({ clear: true })).statusCode).toBe(200);
    expect((await put({ remove: [a] })).statusCode).toBe(200);
    expect(m.memberIds).not.toHaveBeenCalled();
  });

  it('GET passes the page to candidatePage and returns its answer', async () => {
    const page = { total: 120, page: 2, pageSize: 50, pages: 3, selectedCount: 3, records: [] };
    m.candidatePage.mockResolvedValue(page);
    const res = await get('?page=2');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(page);
    expect(m.candidatePage.mock.calls[0]![2]).toBe(2);
  });

  it('404 CAMPAIGN_NOT_FOUND for a malformed id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/campaigns/not-a-uuid/candidates', headers: auth });
    expect(res.statusCode).toBe(404);
  });
});

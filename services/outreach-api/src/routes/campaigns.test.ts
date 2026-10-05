import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Campaign, CampaignPlanResponse, CampaignsResponse, ListViewsResponse, type CampaignPreview, type FieldMap } from '@cti/contracts';
import { schema } from '@cti/db';
import { SalesforceApiError, type SalesforceClient } from '@cti/salesforce';
import { buildApp } from '../app.js';
import { CampaignSourceError } from '../campaigns/source.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { fakeDb, testConfig, type Fixtures } from '../test/harness.js';
import { registerCampaignRoutes } from './campaigns.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
const pv = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('../campaigns/preview.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../campaigns/preview.js')>()),
  previewCampaign: pv.preview,
}));

const cfg = testConfig({ SALESFORCE_CLIENT_ID: 'cid', SALESFORCE_REDIRECT_URI: 'http://api.test/api/connections/salesforce/callback' });
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const admin = { userId: ADMIN_ID, orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const member = { ...admin, isAdmin: false };
const auth = { authorization: 'Bearer t' };
const sql = (w: unknown) => new PgDialect().sqlToQuery(w as SQL);

const emptyObject = { notes: [], phones: [], email: null, doNotCall: null, emailOptOut: null, skipOnDialer: null, consent: null, webFormSource: null, state: null, leadManager: null };
const FIELD_MAP: FieldMap = { Lead: { ...emptyObject, phones: ['MobilePhone'] }, Opportunity: emptyObject };
const connection = { id: 'CONN1', orgId: 'O1', provider: 'salesforce', status: 'connected', fieldMap: FIELD_MAP };

function campaignRow(over: Record<string, unknown> = {}) {
  return {
    id: CAMPAIGN_ID, orgId: 'O1', name: 'Probate', sfObject: 'Lead', sourceKind: 'soql', listViewId: null, soql: 'SELECT Id FROM Lead', status: 'draft', pauseReason: null, pausedFrom: null,
    refreshMinutes: 240, touchDays: [0, 1, 3, 6, 10, 14], approvalsRemaining: 50, playbook: {}, memberCount: 0, lastRefreshedAt: null, lastRefreshError: null,
    createdBy: ADMIN_ID, createdAt: new Date('2026-10-04T12:00:00Z'), updatedAt: new Date('2026-10-04T12:00:00Z'), ...over,
  };
}

const sf = {
  listViews: vi.fn(async () => [{ id: '00B5f00000ABCDE', label: 'Open Leads', developerName: 'Open_Leads' }]),
  listViewSoql: vi.fn(async () => 'SELECT Id, Name FROM Lead WHERE IsConverted = false ORDER BY Name ASC NULLS FIRST, Id ASC NULLS FIRST'),
};
let clients: ReturnType<typeof vi.fn<SalesforceClientFactory>>;
let app: FastifyInstance;
let fixture: ReturnType<typeof fakeDb>;

async function build(fx: Fixtures = {}): Promise<FastifyInstance> {
  fixture = fakeDb({ organizations: [org], ...fx, tables: { crmConnections: [connection], campaigns: [campaignRow()], ...fx.tables } });
  return buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerCampaignRoutes(scope, { db: fixture.db, clients })] });
}

beforeEach(async () => {
  state.session = admin;
  clients = vi.fn<SalesforceClientFactory>(async () => sf as unknown as SalesforceClient);
  sf.listViews.mockClear();
  sf.listViewSoql.mockClear();
  pv.preview.mockReset();
  app = await build();
});
afterEach(async () => { await app.close(); });

describe('admin-only campaign routes', () => {
  it.each([
    ['POST', '/api/campaigns/preview', { sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Lead' } }],
    ['POST', '/api/campaigns', { name: 'X', sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Lead' } }],
    ['PATCH', `/api/campaigns/${CAMPAIGN_ID}`, { name: 'Y' }],
    ['POST', `/api/campaigns/${CAMPAIGN_ID}/status`, { status: 'dry_run' }],
  ] as const)('%s %s is 403 ADMIN_ONLY for a member, with no Salesforce call and no write', async (method, url, payload) => {
    state.session = member;
    const res = await app.inject({ method, url, headers: auth, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'ADMIN_ONLY' });
    expect(clients).not.toHaveBeenCalled();
    expect(pv.preview).not.toHaveBeenCalled();
    expect(fixture.writes).toEqual([]);
  });
});

describe('GET /api/crm/listviews', () => {
  it("lists the object's list views through the tenant connection", async () => {
    state.session = member;
    const res = await app.inject({ method: 'GET', url: '/api/crm/listviews?object=Opportunity', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(ListViewsResponse.parse(res.json())).toEqual({ listViews: [{ id: '00B5f00000ABCDE', label: 'Open Leads', developerName: 'Open_Leads' }] });
    expect(clients).toHaveBeenCalledWith('O1');
    expect(sf.listViews).toHaveBeenCalledWith('Opportunity');
  });

  it('400 for an object other than Lead or Opportunity; 409 CRM_NOT_CONNECTED without a connection', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/crm/listviews?object=Contact', headers: auth })).statusCode).toBe(400);
    clients.mockRejectedValue(new CrmNotConnectedError());
    const res = await app.inject({ method: 'GET', url: '/api/crm/listviews?object=Lead', headers: auth });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CRM_NOT_CONNECTED' });
  });
});

describe('POST /api/campaigns/preview', () => {
  const body = { sfObject: 'Lead', source: { kind: 'soql', soql: "SELECT Id FROM Lead WHERE Status = 'Open'" } };
  const preview: CampaignPreview = { total: 3, examined: 3, eligible: 2, skipped: { closed: 1 }, sample: [] };

  it("previews with the tenant's client and field map", async () => {
    pv.preview.mockResolvedValue(preview);
    const res = await app.inject({ method: 'POST', url: '/api/campaigns/preview', headers: auth, payload: body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(preview);
    expect(pv.preview).toHaveBeenCalledWith({ db: fixture.db, client: sf, orgId: 'O1', fieldMap: FIELD_MAP }, body);
  });

  it.each([
    ['too_large', 'The query returns more than 50,000 records. Narrow the query.'],
    ['salesforce_error', "INVALID_FIELD: No such column 'Foo__c' on entity 'Lead'"],
  ] as const)('422 INVALID_SOURCE with the source error code %s in details', async (code, message) => {
    pv.preview.mockRejectedValue(new CampaignSourceError(message, code));
    const res = await app.inject({ method: 'POST', url: '/api/campaigns/preview', headers: auth, payload: body });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INVALID_SOURCE', error: message, details: { code } });
  });

  it('409 CRM_NOT_CONNECTED when the tenant has no usable connection or field map', async () => {
    await app.close();
    app = await build({ tables: { crmConnections: [{ ...connection, status: 'broken' }] } });
    const res = await app.inject({ method: 'POST', url: '/api/campaigns/preview', headers: auth, payload: body });
    expect(res.statusCode).toBe(409);
    expect(pv.preview).not.toHaveBeenCalled();
  });

  it('502 SALESFORCE_ERROR for any other Salesforce failure; 400 for a bad body', async () => {
    pv.preview.mockRejectedValue(new SalesforceApiError('query failed (500)', 500, [{ errorCode: 'UNKNOWN_EXCEPTION', message: 'boom' }]));
    const res = await app.inject({ method: 'POST', url: '/api/campaigns/preview', headers: auth, payload: body });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ code: 'SALESFORCE_ERROR' });
    expect((await app.inject({ method: 'POST', url: '/api/campaigns/preview', headers: auth, payload: { sfObject: 'Contact' } })).statusCode).toBe(400);
  });
});

describe('GET /api/campaigns', () => {
  it("lists the tenant's campaigns without archived ones by default", async () => {
    state.session = member;
    const res = await app.inject({ method: 'GET', url: '/api/campaigns', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(CampaignsResponse.parse(res.json()).campaigns.map((c) => c.id)).toEqual([CAMPAIGN_ID]);
    const where = sql(fixture.captured.where.at(-1));
    expect(where.sql).toBe('("campaigns"."org_id" = $1 and "campaigns"."status" <> $2)');
    expect(where.params).toEqual(['O1', 'archived']);
  });

  it('includes archived with ?archived=1, still tenant-scoped, and never returns another tenant row', async () => {
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ status: 'archived' }), campaignRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orgId: 'O2' })] } });
    const res = await app.inject({ method: 'GET', url: '/api/campaigns?archived=1', headers: auth });
    expect(res.json().campaigns.map((c: { status: string }) => c.status)).toEqual(['archived']);
    expect(sql(fixture.captured.where.at(-1)).sql).toBe('"campaigns"."org_id" = $1');
  });
});

describe('POST /api/campaigns', () => {
  it('creates a draft from pasted SOQL, storing the validated query', async () => {
    await app.close();
    app = await build({ insertDefaults: campaignRow() });
    const res = await app.inject({ method: 'POST', url: '/api/campaigns', headers: auth, payload: { name: ' Probate ', sfObject: 'Lead', source: { kind: 'soql', soql: "  SELECT Id FROM Lead WHERE Status = 'Open' " } } });
    expect(res.statusCode).toBe(201);
    const created = Campaign.parse(res.json());
    expect(created).toMatchObject({ status: 'draft', name: 'Probate', source: { kind: 'soql', soql: "SELECT Id FROM Lead WHERE Status = 'Open'" } });
    expect(fixture.writes).toEqual([{ op: 'insert', table: schema.campaigns, values: {
      orgId: 'O1', name: 'Probate', sfObject: 'Lead', sourceKind: 'soql', listViewId: null, soql: "SELECT Id FROM Lead WHERE Status = 'Open'", status: 'draft', createdBy: ADMIN_ID,
    } }]);
  });

  it("creates from a list view, storing the list view's described SOQL", async () => {
    await app.close();
    app = await build({ insertDefaults: campaignRow() });
    const res = await app.inject({ method: 'POST', url: '/api/campaigns', headers: auth, payload: { name: 'Open', sfObject: 'Lead', source: { kind: 'list_view', listViewId: '00B5f00000ABCDE' } } });
    expect(res.statusCode).toBe(201);
    expect(res.json().source).toEqual({ kind: 'list_view', listViewId: '00B5f00000ABCDE' });
    expect(sf.listViewSoql).toHaveBeenCalledWith('Lead', '00B5f00000ABCDE');
    expect(fixture.writes[0]!.values).toMatchObject({ sourceKind: 'list_view', listViewId: '00B5f00000ABCDE', soql: expect.stringMatching(/^SELECT Id, Name FROM Lead/) });
  });

  it('422 INVALID_SOURCE (object_mismatch) and no insert when the query is for another object', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/campaigns', headers: auth, payload: { name: 'X', sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Opportunity' } } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'INVALID_SOURCE', details: { code: 'object_mismatch' } });
    expect(fixture.writes).toEqual([]);
  });

  it('409 CRM_NOT_CONNECTED and no insert without a connection', async () => {
    clients.mockRejectedValue(new CrmNotConnectedError());
    const res = await app.inject({ method: 'POST', url: '/api/campaigns', headers: auth, payload: { name: 'X', sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Lead' } } });
    expect(res.statusCode).toBe(409);
    expect(fixture.writes).toEqual([]);
  });
});

describe('GET /api/campaigns/:id', () => {
  it('returns the campaign, looked up by id and tenant', async () => {
    state.session = member;
    const res = await app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(Campaign.parse(res.json()).id).toBe(CAMPAIGN_ID);
    const where = sql(fixture.captured.where.at(-1));
    expect(where.sql).toBe('("campaigns"."id" = $1 and "campaigns"."org_id" = $2)');
    expect(where.params).toEqual([CAMPAIGN_ID, 'O1']);
  });

  it.each([
    ['a non-uuid id', '/api/campaigns/not-a-uuid', {}],
    ['an unknown id', `/api/campaigns/${CAMPAIGN_ID}`, { tables: { campaigns: [] } }],
    ["another tenant's campaign", `/api/campaigns/${CAMPAIGN_ID}`, { tables: { campaigns: [campaignRow({ orgId: 'O2' })] } }],
  ])('404 CAMPAIGN_NOT_FOUND for %s', async (_label, url, fx) => {
    await app.close();
    app = await build(fx as Fixtures);
    const res = await app.inject({ method: 'GET', url, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
  });
});

describe('PATCH /api/campaigns/:id', () => {
  it('updates only the given settings, tenant-scoped', async () => {
    await app.close();
    app = await build({ updateReturning: [campaignRow({ refreshMinutes: 120, touchDays: [0, 2, 5] })] });
    const res = await app.inject({ method: 'PATCH', url: `/api/campaigns/${CAMPAIGN_ID}`, headers: auth, payload: { refreshMinutes: 120, touchDays: [0, 2, 5] } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ refreshMinutes: 120, touchDays: [0, 2, 5] });
    expect(fixture.writes).toEqual([{ op: 'update', table: schema.campaigns, values: { refreshMinutes: 120, touchDays: [0, 2, 5], updatedAt: expect.any(Date) } }]);
    expect(sql(fixture.captured.where.at(-1)).sql).toBe('("campaigns"."id" = $1 and "campaigns"."org_id" = $2)');
  });

  it.each([
    ['touch days that do not start at 0', { touchDays: [1, 2] }],
    ['a refresh under an hour', { refreshMinutes: 30 }],
    ['nothing to change', {}],
  ])('400 VALIDATION for %s', async (_label, payload) => {
    const res = await app.inject({ method: 'PATCH', url: `/api/campaigns/${CAMPAIGN_ID}`, headers: auth, payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION' });
    expect(fixture.writes).toEqual([]);
  });

  it('409 CAMPAIGN_ARCHIVED for an archived campaign', async () => {
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ status: 'archived' })] } });
    const res = await app.inject({ method: 'PATCH', url: `/api/campaigns/${CAMPAIGN_ID}`, headers: auth, payload: { name: 'Y' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'CAMPAIGN_ARCHIVED' });
  });
});

describe('POST /api/campaigns/:id/status', () => {
  const change = (status: string) => app.inject({ method: 'POST', url: `/api/campaigns/${CAMPAIGN_ID}/status`, headers: auth, payload: { status } });

  it.each([
    ['draft', 'dry_run', null],
    ['dry_run', 'paused', 'manual'],
    ['paused', 'active', null],
    ['active', 'archived', null],
  ] as const)('%s → %s sets pause_reason %s, compare-and-swap on the current status', async (from, to, pauseReason) => {
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ status: from, pauseReason: from === 'paused' ? 'crm_broken' : null })] }, updateReturning: [campaignRow({ status: to, pauseReason })] });
    const res = await change(to);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: to, pauseReason });
    expect(fixture.writes).toEqual([{ op: 'update', table: schema.campaigns, values: { status: to, pauseReason, pausedFrom: to === 'paused' ? from : null, updatedAt: expect.any(Date) } }]);
    const where = sql(fixture.captured.where.at(-1));
    expect(where.sql).toBe('("campaigns"."id" = $1 and "campaigns"."org_id" = $2 and "campaigns"."status" = $3)');
    expect(where.params).toEqual([CAMPAIGN_ID, 'O1', from]);
  });

  it.each([['draft', 'active'], ['active', 'dry_run'], ['archived', 'dry_run']] as const)('409 BAD_TRANSITION %s → %s, no write', async (from, to) => {
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ status: from })] } });
    const res = await change(to);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'BAD_TRANSITION', details: { from, to } });
    expect(fixture.writes.filter((w) => w.op === 'update')).toEqual([]);
  });

  it('409 BAD_TRANSITION when the status changed underneath (the compare-and-swap matched no row)', async () => {
    const res = await change('dry_run');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'BAD_TRANSITION' });
  });

  it('400 for a status outside the request enum (draft cannot be requested)', async () => {
    expect((await change('draft')).statusCode).toBe(400);
  });
});

describe('GET /api/campaigns/:id/plan', () => {
  const planRow = {
    enrollmentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', status: 'active', exitReason: null, sfRecordId: '00Q000000000001AAA', name: 'Ann', ownerName: 'Rep One',
    triage: null, nextTouch: { seq: 1, channel: 'rep_call', status: 'planned', dueAt: '2026-10-05T14:00:00+00:00', gateAudit: [] },
  };

  it('returns a page of the plan for a tenant campaign, filtered by status and cursor', async () => {
    await app.close();
    app = await build({ selectResults: [[planRow], [{ status: 'active', count: 1 }]] });
    state.session = member;
    const cursor = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const res = await app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}/plan?status=active&cursor=${cursor}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(CampaignPlanResponse.parse(res.json())).toEqual({
      rows: [{ ...planRow, nextTouch: { ...planRow.nextTouch, dueAt: '2026-10-05T14:00:00.000Z' } }], nextCursor: null, counts: { active: 1 },
    });
    // [0] requireContext, [1] the campaign lookup, [2] the page, [3] the counts.
    expect(sql(fixture.captured.where[1]).sql).toBe('("campaigns"."id" = $1 and "campaigns"."org_id" = $2)');
    const page = sql(fixture.captured.where[2]);
    expect(page.sql).toBe('("campaign_enrollments"."org_id" = $1 and "campaign_enrollments"."campaign_id" = $2 and "campaign_enrollments"."status" = $3 and "campaign_enrollments"."id" > $4)');
    expect(page.params).toEqual(['O1', CAMPAIGN_ID, 'active', cursor]);
  });

  it('400 for a malformed cursor or status; 404 for a campaign of another tenant', async () => {
    expect((await app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}/plan?cursor=nope`, headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}/plan?status=sleeping`, headers: auth })).statusCode).toBe(400);
    await app.close();
    app = await build({ tables: { campaigns: [campaignRow({ orgId: 'O2' })] } });
    const res = await app.inject({ method: 'GET', url: `/api/campaigns/${CAMPAIGN_ID}/plan`, headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'CAMPAIGN_NOT_FOUND' });
  });
});

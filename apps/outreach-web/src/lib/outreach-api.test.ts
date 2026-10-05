import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api';
import * as outreach from './outreach-api';
import { CAMPAIGN_ID, LIST_VIEW_ID, campaign, connection, fieldMap, preview } from '../test/outreach-fixtures';
import { respond, StubResponse, stubApi } from '../test/stub-api';

afterEach(() => vi.unstubAllGlobals());

const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';
const emptyPlan = { rows: [], nextCursor: null, counts: { active: 3 } };

interface Case { name: string; call: () => Promise<unknown>; route: string; response: unknown; body?: unknown }

const cases: Case[] = [
  { name: 'getConnection', call: () => outreach.getConnection(), route: 'GET /api/connections/salesforce', response: connection() },
  { name: 'startConnection', call: () => outreach.startConnection(), route: 'POST /api/connections/salesforce/start', response: { url: 'https://login.salesforce.com/services/oauth2/authorize?state=s1' } },
  { name: 'saveFieldMap', call: () => outreach.saveFieldMap(fieldMap()), route: 'PUT /api/connections/salesforce/field-map', response: respond(204), body: fieldMap() },
  { name: 'disconnect', call: () => outreach.disconnect(), route: 'DELETE /api/connections/salesforce', response: respond(204) },
  { name: 'listViews', call: () => outreach.listViews('Opportunity'), route: 'GET /api/crm/listviews?object=Opportunity', response: { listViews: [{ id: LIST_VIEW_ID, label: 'My open', developerName: 'My_Open' }] } },
  { name: 'previewCampaign', call: () => outreach.previewCampaign({ sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Lead' } }), route: 'POST /api/campaigns/preview', response: preview(), body: { sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FROM Lead' } } },
  { name: 'listCampaigns', call: () => outreach.listCampaigns(), route: 'GET /api/campaigns', response: { campaigns: [campaign()] } },
  { name: 'listCampaigns (archived)', call: () => outreach.listCampaigns({ archived: true }), route: 'GET /api/campaigns?archived=1', response: { campaigns: [] } },
  { name: 'createCampaign', call: () => outreach.createCampaign({ name: 'Spring sellers', sfObject: 'Lead', source: { kind: 'list_view', listViewId: LIST_VIEW_ID } }), route: 'POST /api/campaigns', response: campaign({ status: 'draft' }), body: { name: 'Spring sellers', sfObject: 'Lead', source: { kind: 'list_view', listViewId: LIST_VIEW_ID } } },
  { name: 'getCampaign', call: () => outreach.getCampaign(CAMPAIGN_ID), route: `GET /api/campaigns/${CAMPAIGN_ID}`, response: campaign() },
  { name: 'updateCampaign', call: () => outreach.updateCampaign(CAMPAIGN_ID, { refreshMinutes: 120 }), route: `PATCH /api/campaigns/${CAMPAIGN_ID}`, response: campaign({ refreshMinutes: 120 }), body: { refreshMinutes: 120 } },
  { name: 'changeCampaignStatus', call: () => outreach.changeCampaignStatus(CAMPAIGN_ID, 'active'), route: `POST /api/campaigns/${CAMPAIGN_ID}/status`, response: campaign({ status: 'active' }), body: { status: 'active' } },
  { name: 'getPlan', call: () => outreach.getPlan(CAMPAIGN_ID), route: `GET /api/campaigns/${CAMPAIGN_ID}/plan`, response: emptyPlan },
  { name: 'getPlan (cursor, status)', call: () => outreach.getPlan(CAMPAIGN_ID, { cursor: 'c1', status: 'exited' }), route: `GET /api/campaigns/${CAMPAIGN_ID}/plan?cursor=c1&status=exited`, response: emptyPlan },
  { name: 'getReview', call: () => outreach.getReview(), route: 'GET /api/review', response: { items: [] } },
  { name: 'decideReview', call: () => outreach.decideReview(ENROLLMENT_ID, 'confirm'), route: `POST /api/review/${ENROLLMENT_ID}`, response: respond(204), body: { decision: 'confirm' } },
];

describe('outreach-api', () => {
  it.each(cases)('$name sends $route and returns the parsed body', async ({ call, route, response, body }) => {
    const calls = stubApi({ [route]: response });
    const result = await call();
    expect(calls).toHaveLength(1);
    expect(`${calls[0]?.method} ${calls[0]?.url}`).toBe(route);
    expect(calls[0]?.body).toEqual(body);
    if (!(response instanceof StubResponse)) expect(result).toEqual(response);
  });

  it('rejects a body that does not match the contract', async () => {
    stubApi({ [`GET /api/campaigns/${CAMPAIGN_ID}`]: { ...campaign(), status: 'running' } });
    await expect(outreach.getCampaign(CAMPAIGN_ID)).rejects.toThrow();
  });

  it('surfaces a 422 INVALID_SOURCE as ApiRequestError carrying the server message', async () => {
    stubApi({ 'POST /api/campaigns/preview': respond(422, { error: "unexpected token: 'FORM'", code: 'INVALID_SOURCE', details: { code: 'salesforce_error' } }) });
    const err = await outreach.previewCampaign({ sfObject: 'Lead', source: { kind: 'soql', soql: 'SELECT Id FORM Lead' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({ status: 422, code: 'INVALID_SOURCE', message: "unexpected token: 'FORM'" });
  });
});

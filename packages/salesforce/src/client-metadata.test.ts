import { describe, expect, it, vi } from 'vitest';
import { SalesforceClient } from './client.js';
import { SalesforceApiError } from './errors.js';
import { fakeFetch, type FakeScript } from './fake-fetch.js';

const INSTANCE = 'https://gg.my.salesforce.com';

function client(script: FakeScript) {
  const http = fakeFetch(script);
  const tokens = {
    current: vi.fn(async () => ({ accessToken: 't', instanceUrl: INSTANCE })),
    refresh: vi.fn(async () => ({ accessToken: 't2', instanceUrl: INSTANCE })),
  };
  return { sf: new SalesforceClient({ tokens, apiVersion: 'v60.0', fetchImpl: http.impl }), http };
}

describe('SalesforceClient.describe', () => {
  it('maps the describe fields and drops malformed entries', async () => {
    const { sf, http } = client([
      {
        status: 200,
        body: {
          name: 'Lead',
          fields: [
            { name: 'Notes__c', type: 'textarea', label: 'Notes', length: 32768 },
            { name: 'MobilePhone', type: 'phone', label: 'Mobile' },
            { name: 'Broken' },
          ],
        },
      },
    ]);
    expect(await sf.describe('Lead')).toEqual({
      name: 'Lead',
      fields: [
        { name: 'Notes__c', type: 'textarea', label: 'Notes', length: 32768 },
        { name: 'MobilePhone', type: 'phone', label: 'Mobile' },
      ],
    });
    expect(http.calls[0]!.url).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Lead/describe`);
  });

  it('throws SalesforceApiError on >= 400', async () => {
    const { sf } = client([{ status: 404, body: [{ errorCode: 'NOT_FOUND' }] }]);
    await expect(sf.describe('Nope__c')).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

describe('SalesforceClient.listViews', () => {
  it('parses and sorts by label', async () => {
    const { sf, http } = client([
      {
        status: 200,
        body: {
          done: true,
          listviews: [
            { id: '00B2', label: 'Zeta Leads', developerName: 'Zeta_Leads' },
            { id: '00B1', label: 'Alpha Leads', developerName: 'Alpha_Leads' },
            { id: '00B3' },
          ],
        },
      },
    ]);
    expect(await sf.listViews('Lead')).toEqual([
      { id: '00B1', label: 'Alpha Leads', developerName: 'Alpha_Leads' },
      { id: '00B2', label: 'Zeta Leads', developerName: 'Zeta_Leads' },
    ]);
    expect(http.calls[0]!.url).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Lead/listviews`);
  });

  it('follows nextRecordsUrl when Salesforce pages the list', async () => {
    const { sf, http } = client([
      {
        status: 200,
        body: {
          done: false,
          nextRecordsUrl: '/services/data/v60.0/sobjects/Opportunity/listviews?offset=25',
          listviews: [{ id: '00B2', label: 'B', developerName: 'B' }],
        },
      },
      { status: 200, body: { done: true, listviews: [{ id: '00B1', label: 'A', developerName: 'A' }] } },
    ]);
    expect((await sf.listViews('Opportunity')).map((v) => v.id)).toEqual(['00B1', '00B2']);
    expect(http.calls[1]!.url).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Opportunity/listviews?offset=25`);
  });

  it('throws SalesforceApiError on >= 400', async () => {
    const { sf } = client([{ status: 403, body: [{ errorCode: 'INSUFFICIENT_ACCESS' }] }]);
    await expect(sf.listViews('Lead')).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

describe('SalesforceClient.listViewSoql', () => {
  it('returns .query from the list view describe', async () => {
    const soql = 'SELECT Name, Id FROM Lead WHERE Status = \'Open\' ORDER BY Name ASC NULLS FIRST, Id ASC NULLS FIRST';
    const { sf, http } = client([{ status: 200, body: { id: '00B5e00000AbCdE', query: soql, columns: [] } }]);
    expect(await sf.listViewSoql('Lead', '00B5e00000AbCdE')).toBe(soql);
    expect(http.calls[0]!.url).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Lead/listviews/00B5e00000AbCdE/describe`);
  });

  it('throws SalesforceApiError when the describe has no query', async () => {
    const { sf } = client([{ status: 200, body: { id: '00B5e00000AbCdE' } }]);
    await expect(sf.listViewSoql('Lead', '00B5e00000AbCdE')).rejects.toBeInstanceOf(SalesforceApiError);
  });

  it('throws SalesforceApiError on >= 400', async () => {
    const { sf } = client([{ status: 404, body: [{ errorCode: 'NOT_FOUND' }] }]);
    await expect(sf.listViewSoql('Opportunity', '00B000000000000')).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

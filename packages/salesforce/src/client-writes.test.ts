import { describe, expect, it, vi } from 'vitest';
import { COMPOSITE_BATCH_LIMIT, SalesforceClient } from './client.js';
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

describe('SalesforceClient.createRecords', () => {
  it('POSTs /composite/sobjects with allOrNone false and attributes.type per record', async () => {
    const { sf, http } = client([
      {
        status: 200,
        body: [
          { id: '00T000000000001AAA', success: true, errors: [] },
          { success: false, errors: [{ statusCode: 'INVALID_FIELD', message: 'No such column', fields: ['CTI_Origin__c'] }] },
        ],
      },
    ]);
    const results = await sf.createRecords([
      { sobject: 'Task', fields: { Subject: 'Campaign call', WhoId: '00Q000000000001' } },
      { sobject: 'Task', fields: { Subject: 'AI text sent', CTI_Origin__c: 'AI Outreach' } },
    ]);
    expect(http.calls[0]!.method).toBe('POST');
    expect(http.calls[0]!.url).toBe(`${INSTANCE}/services/data/v60.0/composite/sobjects`);
    expect(JSON.parse(http.calls[0]!.body!)).toEqual({
      allOrNone: false,
      records: [
        { attributes: { type: 'Task' }, Subject: 'Campaign call', WhoId: '00Q000000000001' },
        { attributes: { type: 'Task' }, Subject: 'AI text sent', CTI_Origin__c: 'AI Outreach' },
      ],
    });
    expect(results).toEqual([
      { id: '00T000000000001AAA', success: true, errors: [] },
      { success: false, errors: [{ statusCode: 'INVALID_FIELD', message: 'No such column', fields: ['CTI_Origin__c'] }] },
    ]);
  });

  it('makes no call for an empty list', async () => {
    const { sf, http } = client([]);
    expect(await sf.createRecords([])).toEqual([]);
    expect(http.calls).toHaveLength(0);
  });

  it(`rejects more than ${COMPOSITE_BATCH_LIMIT} records without calling Salesforce`, async () => {
    const { sf, http } = client([]);
    const many = Array.from({ length: COMPOSITE_BATCH_LIMIT + 1 }, () => ({ sobject: 'Task', fields: {} }));
    await expect(sf.createRecords(many)).rejects.toBeInstanceOf(RangeError);
    expect(http.calls).toHaveLength(0);
  });

  it('throws SalesforceApiError when the request fails or the answer does not align', async () => {
    const one = [{ sobject: 'Task', fields: { Subject: 'x' } }];
    await expect(client([{ status: 400, body: [{ errorCode: 'JSON_PARSER_ERROR' }] }]).sf.createRecords(one)).rejects.toBeInstanceOf(SalesforceApiError);
    await expect(client([{ status: 200, body: [] }]).sf.createRecords(one)).rejects.toBeInstanceOf(SalesforceApiError);
    await expect(client([{ status: 200, body: { not: 'an array' } }]).sf.createRecords(one)).rejects.toBeInstanceOf(SalesforceApiError);
  });

  it('normalizes a malformed per-record result to a failure', async () => {
    const { sf } = client([{ status: 200, body: [{ success: false, errors: [{}] }] }]);
    expect(await sf.createRecords([{ sobject: 'Task', fields: {} }])).toEqual([
      { success: false, errors: [{ statusCode: 'UNKNOWN_ERROR', message: '' }] },
    ]);
  });
});

describe('SalesforceClient.updateRecords', () => {
  it('PATCHes /composite/sobjects with allOrNone false, attributes.type, and id', async () => {
    const { sf, http } = client([{ status: 200, body: [{ id: '00Q000000000001AAA', success: true, errors: [] }] }]);
    const results = await sf.updateRecords([
      { sobject: 'Lead', id: '00Q000000000001AAA', fields: { DoNotCall: true, HasOptedOutOfEmail: true } },
    ]);
    expect(http.calls[0]!.method).toBe('PATCH');
    expect(http.calls[0]!.url).toBe(`${INSTANCE}/services/data/v60.0/composite/sobjects`);
    expect(JSON.parse(http.calls[0]!.body!)).toEqual({
      allOrNone: false,
      records: [{ attributes: { type: 'Lead' }, id: '00Q000000000001AAA', DoNotCall: true, HasOptedOutOfEmail: true }],
    });
    expect(results).toEqual([{ id: '00Q000000000001AAA', success: true, errors: [] }]);
  });

  it('the explicit id wins over a field of the same name', async () => {
    const { sf, http } = client([{ status: 200, body: [{ id: '00Q000000000001AAA', success: true, errors: [] }] }]);
    await sf.updateRecords([{ sobject: 'Lead', id: '00Q000000000001AAA', fields: { id: 'spoofed' } }]);
    expect(JSON.parse(http.calls[0]!.body!).records[0].id).toBe('00Q000000000001AAA');
  });
});

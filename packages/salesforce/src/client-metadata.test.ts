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

  it('carries the write flags, picklist values and record types (plan 1D)', async () => {
    const { sf } = client([
      {
        status: 200,
        body: {
          name: 'Lead',
          createable: true,
          updateable: true,
          fields: [
            {
              name: 'Status',
              type: 'picklist',
              label: 'Lead Status',
              length: 255,
              updateable: true,
              createable: true,
              calculated: false,
              nillable: false,
              restrictedPicklist: true,
              picklistValues: [
                { value: 'Working', label: 'Working', active: true, defaultValue: false },
                { value: 'Old', label: 'Old', active: false },
                { label: 'No value', active: true },
                { value: 'NoLabel', active: true },
              ],
            },
            { name: 'Days_Open__c', type: 'double', label: 'Days Open', calculated: true, updateable: false, createable: false },
            { name: 'Odd__c', type: 'string', label: 'Odd', updateable: 'yes', nillable: 1 },
          ],
          recordTypeInfos: [
            { recordTypeId: '0128X000000AAAAQAA', name: 'Seller', developerName: 'Seller', available: true, defaultRecordTypeMapping: true, master: false },
            { recordTypeId: '0128X000000BBBBQAA', name: 'Buyer', developerName: 'Buyer', available: false, defaultRecordTypeMapping: false },
            { recordTypeId: '012000000000000AAA', name: 'Master', available: true, defaultRecordTypeMapping: false },
          ],
        },
      },
    ]);
    const d = await sf.describe('Lead');
    expect(d.createable).toBe(true);
    expect(d.updateable).toBe(true);
    expect(d.fields).toEqual([
      {
        name: 'Status',
        type: 'picklist',
        label: 'Lead Status',
        length: 255,
        updateable: true,
        createable: true,
        calculated: false,
        nillable: false,
        restrictedPicklist: true,
        picklistValues: [
          { value: 'Working', label: 'Working', active: true },
          { value: 'Old', label: 'Old', active: false },
          { value: 'NoLabel', label: 'NoLabel', active: true },
        ],
      },
      { name: 'Days_Open__c', type: 'double', label: 'Days Open', calculated: true, updateable: false, createable: false },
      { name: 'Odd__c', type: 'string', label: 'Odd' },
    ]);
    expect(d.fields[2]).not.toHaveProperty('updateable');
    expect(d.fields[2]).not.toHaveProperty('nillable');
    expect(d.recordTypeInfos).toEqual([
      { recordTypeId: '0128X000000AAAAQAA', name: 'Seller', developerName: 'Seller', available: true, defaultRecordTypeMapping: true },
      { recordTypeId: '0128X000000BBBBQAA', name: 'Buyer', developerName: 'Buyer', available: false, defaultRecordTypeMapping: false },
    ]);
  });

  it('leaves the object flags and record types out when Salesforce does not send them', async () => {
    const { sf } = client([{ status: 200, body: { name: 'Task', createable: 'true', fields: [] } }]);
    const d = await sf.describe('Task');
    expect(d).toEqual({ name: 'Task', fields: [] });
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

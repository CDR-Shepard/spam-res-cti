import { describe, expect, it } from 'vitest';
import { ContactChannel, CrmConnectionStatus, FieldMap, ListViewsResponse, SfObject, StartConnectionResponse } from './index.js';

const leadMap = {
  notes: ['Notes__c', 'Description'],
  phones: ['MobilePhone', 'Phone'],
  email: 'Email',
  doNotCall: 'DoNotCall',
  emailOptOut: 'HasOptedOutOfEmail',
  skipOnDialer: 'Skip_on_Dialer__c',
  consent: 'AI_Call_Consent__c',
  webFormSource: 'Lead_Form_Source__c',
  state: 'State',
  leadManager: 'LeadManager__c',
};
const oppMap = {
  notes: ['Agent_Notes__c'],
  phones: ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'],
  email: null,
  doNotCall: null,
  emailOptOut: null,
  skipOnDialer: null,
  consent: null,
  webFormSource: null,
  state: null,
  leadManager: null,
};

describe('crm contracts', () => {
  it('Salesforce objects and contact channels are closed sets', () => {
    expect(SfObject.options).toEqual(['Lead', 'Opportunity']);
    expect(SfObject.safeParse('Contact').success).toBe(false);
    expect(ContactChannel.options).toEqual(['call', 'sms', 'email']);
  });

  it('FieldMap round-trips a Lead map and an Opportunity map with nulls', () => {
    const map = { Lead: leadMap, Opportunity: oppMap };
    expect(FieldMap.parse(map)).toEqual(map);
  });

  it.each([
    ['21 notes fields', { ...leadMap, notes: Array.from({ length: 21 }, (_, i) => `N${i}__c`) }],
    ['7 phone fields', { ...leadMap, phones: Array.from({ length: 7 }, (_, i) => `P${i}__c`) }],
    ['a missing key', (({ leadManager: _drop, ...rest }) => rest)(leadMap)],
    ['undefined instead of null', { ...leadMap, email: undefined }],
  ])('FieldMap rejects %s', (_label, lead) => {
    expect(FieldMap.safeParse({ Lead: lead, Opportunity: oppMap }).success).toBe(false);
  });

  it('CrmConnectionStatus: the not-configured shape and a broken connection', () => {
    const none = { configured: false, connected: false, status: null, instanceUrl: null, username: null, connectedAt: null, lastError: null, fieldMap: null };
    expect(CrmConnectionStatus.parse(none)).toEqual(none);
    const broken = {
      configured: true,
      connected: true,
      status: 'broken',
      instanceUrl: 'https://gg.my.salesforce.com',
      username: 'integration@gg.example',
      connectedAt: '2026-10-04T12:00:00.000Z',
      lastError: 'refresh failed: invalid_grant',
      fieldMap: { Lead: leadMap, Opportunity: oppMap },
    };
    expect(CrmConnectionStatus.parse(broken)).toEqual(broken);
    expect(CrmConnectionStatus.safeParse({ ...broken, status: 'expired' }).success).toBe(false);
  });

  it('StartConnectionResponse needs an absolute URL; ListViewsResponse lists id/label/developerName', () => {
    expect(StartConnectionResponse.safeParse({ url: 'https://login.salesforce.com/services/oauth2/authorize?x=1' }).success).toBe(true);
    expect(StartConnectionResponse.safeParse({ url: '/relative' }).success).toBe(false);
    const views = { listViews: [{ id: '00B5f00000ABCDE', label: 'My Leads', developerName: 'MyLeads' }] };
    expect(ListViewsResponse.parse(views)).toEqual(views);
    expect(ListViewsResponse.safeParse({ listViews: [{ id: '00B', label: 'x' }] }).success).toBe(false);
  });
});

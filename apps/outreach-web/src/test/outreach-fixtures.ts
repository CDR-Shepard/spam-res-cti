import type { Campaign, CampaignPreview, CrmConnectionStatus, FieldMap } from '@cti/contracts';

export const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';
export const LIST_VIEW_ID = '00B5e00000AbCdE';

export function fieldMap(): FieldMap {
  return {
    Lead: { notes: ['Notes__c', 'Description'], phones: ['MobilePhone', 'Phone'], email: 'Email', doNotCall: 'DoNotCall', emailOptOut: 'HasOptedOutOfEmail', skipOnDialer: 'Skip_on_Dialer__c', consent: null, webFormSource: 'Lead_Form_Source__c', state: 'State', leadManager: 'LeadManager__c' },
    Opportunity: { notes: ['Agent_Notes__c'], phones: ['Mobile_Phone__c', 'Phone__c', 'Other_Phone__c'], email: null, doNotCall: null, emailOptOut: null, skipOnDialer: null, consent: null, webFormSource: null, state: null, leadManager: null },
  };
}

export function connection(over: Partial<CrmConnectionStatus> = {}): CrmConnectionStatus {
  return {
    configured: true,
    connected: true,
    status: 'connected',
    instanceUrl: 'https://gghomes.my.salesforce.com',
    username: 'integration@gghomes.com',
    connectedAt: '2026-10-01T15:00:00.000Z',
    lastError: null,
    fieldMap: fieldMap(),
    ...over,
  };
}

export function campaign(over: Partial<Campaign> = {}): Campaign {
  return {
    id: CAMPAIGN_ID,
    name: 'Spring sellers',
    sfObject: 'Lead',
    source: { kind: 'list_view', listViewId: LIST_VIEW_ID },
    status: 'dry_run',
    pauseReason: null,
    refreshMinutes: 240,
    touchDays: [0, 1, 3, 6, 10, 14],
    memberCount: 1250,
    lastRefreshedAt: '2026-10-04T15:00:00.000Z',
    lastRefreshError: null,
    createdAt: '2026-10-01T15:00:00.000Z',
    ...over,
  };
}

export function preview(): CampaignPreview {
  return {
    total: 4210,
    examined: 2000,
    eligible: 1500,
    skipped: { no_contact_point: 120, opted_out: 40, blocked: 5, dnc: 60, sf_do_not_call: 90, sf_email_opt_out: 10, skip_on_dialer: 75, in_other_campaign: 80, closed: 20 },
    sample: [
      { sfRecordId: '00Q5e00000Abc01', name: 'Jane Seller', ownerName: 'Rep One', channels: ['call', 'sms'], skipReason: null },
      { sfRecordId: '00Q5e00000Abc02', name: null, ownerName: null, channels: [], skipReason: 'no_contact_point' },
    ],
  };
}

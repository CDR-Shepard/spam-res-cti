/** Task 27: can this tenant's connection write back and convert? Read-only checks, shown on the settings card. */
import { describe, expect, it } from 'vitest';
import { WritebackReadiness, type AiCallBookingSettings } from '@cti/contracts';
import type { SObjectDescribe } from '@cti/salesforce';
import { DescribeCache } from '../research/describe.js';
import { DEFAULT_AI_CALL_BOOKING } from '../settings.js';
import { fakeSfWrites, soapFaultAnswer, userInfoAnswer, type WriteQueryRoute } from '../test/fake-sf-writes.js';
import { prodDescribe } from '../test/writeback-describes.js';
import { writebackReadiness } from './readiness.js';

const GRANT = '0058X00000Fsx39QAB';
const US = '0058X0000Integ1QAA';
const BOOKING: AiCallBookingSettings = { ...DEFAULT_AI_CALL_BOOKING, specialists: [GRANT] };
const PSA = /^SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = /;
const USERS = /^SELECT Id, FirstName, Name, IsActive, TimeZoneSidKey FROM User/;

const object = (name: string, over: Partial<SObjectDescribe> = {}): SObjectDescribe => ({ name, fields: [], createable: true, ...over });
const recordTypes = (name: string) => [
  { recordTypeId: '012000000000001AAA', name: 'Master', developerName: 'Master', available: true, defaultRecordTypeMapping: false },
  { recordTypeId: '012000000000002AAA', name, developerName: name.replace(/ /g, '_'), available: true, defaultRecordTypeMapping: true },
];

function org(o: { describes?: Record<string, SObjectDescribe>; queries?: WriteQueryRoute[]; soapFault?: string; grantActive?: boolean } = {}) {
  const f = fakeSfWrites({
    describes: {
      Lead: prodDescribe('Lead'),
      Opportunity: { ...prodDescribe('Opportunity'), createable: true, recordTypeInfos: recordTypes('Homeowner Opportunity') },
      Event: object('Event'),
      Task: object('Task'),
      FeedItem: object('FeedItem'),
      Account: object('Account', { recordTypeInfos: recordTypes('Person Account') }),
      Contact: object('Contact'),
      ...o.describes,
    },
    queries: [...(o.queries ?? []), [PSA, [{ Id: '0Pa8X00000Psa1QAA' }]], [USERS, [{ Id: GRANT, FirstName: 'Grant', Name: 'Grant Golden', IsActive: o.grantActive ?? true, TimeZoneSidKey: 'America/Los_Angeles' }]]],
  });
  f.onSoap = () => (o.soapFault ? soapFaultAnswer(o.soapFault, 'API is not enabled for this Organization or Partner') : userInfoAnswer(US));
  return f;
}
const check = (f: ReturnType<typeof org>, booking = BOOKING) => writebackReadiness(f.client, new DescribeCache(), 'org-1', booking);

describe('writebackReadiness', () => {
  it('all good: ready and convert-ready, no items, the record types and the owner shown', async () => {
    const f = org();
    const r = await check(f);
    expect(WritebackReadiness.safeParse(r).success).toBe(true);
    expect(r).toEqual({
      ready: true,
      convertReady: true,
      convertRecordTypes: { account: 'Person Account', opportunity: 'Homeowner Opportunity' },
      appointmentOwner: { id: GRANT, name: 'Grant Golden', title: null, isActive: true },
      items: [],
    });
    expect(f.soql).toContain(`SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${US}' AND PermissionSet.PermissionsConvertLeads = true LIMIT 1`);
    expect(f.creates).toEqual([]);
    expect(f.updates).toEqual([]);
  });

  it('a Lead describe without AI Last Call Changes: not ready, one missing item', async () => {
    const r = await check(org({ describes: { Lead: prodDescribe('Lead', ['AI_Last_Call_Changes__c']) } }));
    expect(r.ready).toBe(false);
    expect(r.items).toEqual([{ object: 'Lead', field: 'AI_Last_Call_Changes__c', label: 'AI_Last_Call_Changes__c', problem: 'missing' }]);
  });

  it('Status present but not updateable: not ready, not_updateable; a missing tenant-optional field is not listed', async () => {
    const lead = prodDescribe('Lead', ['Spanish_Speaker__c']);
    const fields = lead.fields.map((f) => (f.name === 'Status' ? { ...f, updateable: false } : f));
    const r = await check(org({ describes: { Lead: { ...lead, fields } } }));
    expect(r.ready).toBe(false);
    expect(r.items).toEqual([{ object: 'Lead', field: 'Status', label: 'Status', problem: 'not_updateable' }]);
  });

  it('FeedItem not createable: cannot_create and not ready; Task not createable is listed but does not block', async () => {
    const r = await check(org({ describes: { FeedItem: object('FeedItem', { createable: false }) } }));
    expect(r.ready).toBe(false);
    expect(r.items).toEqual([{ object: 'FeedItem', field: null, label: 'FeedItem', problem: 'cannot_create' }]);
    const t = await check(org({ describes: { Task: object('Task', { createable: false }) } }));
    expect(t).toMatchObject({ ready: true, items: [{ object: 'Task', field: null, label: 'Task', problem: 'cannot_create' }] });
  });

  it('SOAP getUserInfo faulting: not convert-ready, soap_unavailable (no permission query)', async () => {
    const f = org({ soapFault: 'API_DISABLED_FOR_ORG' });
    const r = await check(f);
    expect(r.convertReady).toBe(false);
    expect(r.ready).toBe(true);
    expect(r.items).toEqual([{ object: 'Lead', field: null, label: 'SOAP API (Lead conversion)', problem: 'soap_unavailable' }]);
    expect(f.soql.some((q) => PSA.test(q))).toBe(false);
  });

  it('no Convert Leads permission: cannot_convert; an Opportunity the user cannot create: cannot_create', async () => {
    const r = await check(org({ queries: [[PSA, []]], describes: { Account: object('Account', { createable: false }) } }));
    expect(r.convertReady).toBe(false);
    expect(r.items).toEqual([
      { object: 'Lead', field: null, label: 'Convert Leads permission', problem: 'cannot_convert' },
      { object: 'Account', field: null, label: 'Account', problem: 'cannot_create' },
    ]);
  });

  it('the appointment owner is Grant while active; null when inactive or the list is empty', async () => {
    expect((await check(org({ grantActive: false }))).appointmentOwner).toBeNull();
    const f = org();
    expect((await check(f, { ...BOOKING, specialists: [] })).appointmentOwner).toBeNull();
    expect(f.soql.some((q) => USERS.test(q))).toBe(false);
  });
});

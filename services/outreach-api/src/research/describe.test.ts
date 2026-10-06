import type { SalesforceClient, SObjectDescribe } from '@cti/salesforce';
import { describe, expect, it, vi } from 'vitest';
import { describeOf } from '../test/fake-sf-client.js';
import { DescribeCache, describeObject, readableFields } from './describe.js';

const field = (name: string, type = 'string') => ({ name, type, label: `${name} label` });

describe('readableFields', () => {
  const d: SObjectDescribe = {
    name: 'Lead',
    fields: [
      field('Name'),
      field('Photo', 'base64'),
      field('Id', 'id'),
      field('Address', 'address'),
      field('Geo', 'location'),
      field('Secret__c', 'encryptedstring'),
      field("Bad'Field"),
      field('1bad'),
      field('Phone', 'phone'),
      field('Notes__c', 'textarea'),
    ],
  };
  it('drops binary, compound and masked types and unsafe names, puts Id first, keeps describe order', () => {
    expect(readableFields(d, 100).map((f) => f.name)).toEqual(['Id', 'Name', 'Phone', 'Notes__c']);
  });
  it('puts the pinned field right after Id, matched case-insensitively, and keeps it inside the cap', () => {
    const wide = describeOf('Lead', [['Id', 'id'], ['Name'], ['Phone'], ['AI_Call_Consent__c', 'boolean']]);
    expect(readableFields(wide, 100, 'ai_call_consent__c').map((f) => f.name)).toEqual(['Id', 'AI_Call_Consent__c', 'Name', 'Phone']);
    expect(readableFields(wide, 2, 'AI_Call_Consent__c').map((f) => f.name)).toEqual(['Id', 'AI_Call_Consent__c']);
    expect(readableFields(wide, 100, 'Missing__c').map((f) => f.name)).toEqual(['Id', 'Name', 'Phone', 'AI_Call_Consent__c']);
  });
  it('Fix 1 (I-2): pins a list of fields in its order after Id, each matched case-insensitively, skipping absent ones', () => {
    const wide = describeOf('Lead', [['Id', 'id'], ['Name'], ['Timeline__c', 'picklist'], ['Phone'], ['AI_Call_Consent__c', 'boolean'], ['Condition__c', 'picklist']]);
    expect(readableFields(wide, 100, ['ai_call_consent__c', 'condition__c', 'Missing__c', 'TIMELINE__C']).map((f) => f.name)).toEqual([
      'Id', 'AI_Call_Consent__c', 'Condition__c', 'Timeline__c', 'Name', 'Phone',
    ]);
    expect(readableFields(wide, 3, ['Timeline__c', 'Condition__c']).map((f) => f.name)).toEqual(['Id', 'Timeline__c', 'Condition__c']);
    expect(readableFields(wide, 100, [null, 'Timeline__c']).map((f) => f.name)).toEqual(['Id', 'Timeline__c', 'Name', 'Phone', 'AI_Call_Consent__c', 'Condition__c']);
  });
  it('carries the label and caps at max', () => {
    expect(readableFields(d, 2)).toEqual([
      { name: 'Id', label: 'Id label' },
      { name: 'Name', label: 'Name label' },
    ]);
  });
});

describe('describeObject', () => {
  it('describes once per org and object within the TTL, again after it, and per org', async () => {
    let now = 1_000;
    const cache = new DescribeCache({ ttlMs: 100, now: () => now });
    const describeFn = vi.fn(async (name: string) => ({ name, fields: [] }));
    const client = { describe: describeFn } as unknown as SalesforceClient;
    await describeObject(client, cache, 'org1', 'Lead');
    await describeObject(client, cache, 'org1', 'Lead');
    expect(describeFn).toHaveBeenCalledTimes(1);
    await describeObject(client, cache, 'org2', 'Lead');
    expect(describeFn).toHaveBeenCalledTimes(2);
    await describeObject(client, cache, 'org1', 'Opportunity');
    expect(describeFn).toHaveBeenCalledTimes(3);
    now += 101;
    await describeObject(client, cache, 'org1', 'Lead');
    expect(describeFn).toHaveBeenCalledTimes(4);
  });
});

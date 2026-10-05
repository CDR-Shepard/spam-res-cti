import type { SalesforceClient, SObjectDescribe } from '@cti/salesforce';
import { describe, expect, it, vi } from 'vitest';
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

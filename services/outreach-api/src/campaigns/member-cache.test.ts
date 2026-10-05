import { describe, expect, it, vi } from 'vitest';
import type { CampaignRow } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { campaignMemberIds, MemberIdCache, memberCacheKey } from './member-cache.js';

const campaign = { id: 'C1', orgId: 'O1', sfObject: 'Lead', sourceKind: 'soql', listViewId: null, soql: 'SELECT Id FROM Lead' } as unknown as CampaignRow;

describe('MemberIdCache', () => {
  it('expires entries after the TTL and evicts the oldest past the max', () => {
    let t = 0;
    const cache = new MemberIdCache({ ttlMs: 1000, max: 2, now: () => t });
    cache.set('a', ['1']);
    cache.set('b', ['2']);
    cache.set('c', ['3']);
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toEqual(['2']);
    t = 1001;
    expect(cache.get('b')).toBeNull();
  });
});

describe('memberCacheKey', () => {
  it('changes when the query text changes, so an edited source never reads stale members', () => {
    expect(memberCacheKey(campaign)).not.toBe(memberCacheKey({ ...campaign, soql: 'SELECT Id FROM Lead WHERE IsConverted = false' }));
  });
});

describe('campaignMemberIds', () => {
  it('queries Salesforce once, then serves pages from the cache; fresh=true re-reads', async () => {
    const queryAll = vi.fn(async () => [{ Id: '00Q000000000001AAA' }, { Id: '00Q000000000002AAA' }]);
    const client = { queryAll } as unknown as SalesforceClient;
    const cache = new MemberIdCache();
    expect(await campaignMemberIds({ client, cache }, campaign)).toEqual(['00Q000000000001AAA', '00Q000000000002AAA']);
    await campaignMemberIds({ client, cache }, campaign);
    expect(queryAll).toHaveBeenCalledTimes(1);
    await campaignMemberIds({ client, cache }, campaign, { fresh: true });
    expect(queryAll).toHaveBeenCalledTimes(2);
  });
});

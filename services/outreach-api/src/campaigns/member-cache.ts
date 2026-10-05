/**
 * Member Ids per campaign, cached in this process so the lead picker can page
 * through up to 50,000 members without re-running the query on every click.
 * outreach-api runs one replica; a miss only costs one more Salesforce query.
 */
import { createHash } from 'node:crypto';
import { SfObject, type CampaignSource } from '@cti/contracts';
import type { CampaignRow } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { fetchMemberIds, MAX_CAMPAIGN_RECORDS, membershipSoql } from './source.js';

export const MEMBER_CACHE_TTL_MS = 10 * 60_000;
export const MEMBER_CACHE_MAX = 50;

export class MemberIdCache {
  private readonly entries = new Map<string, { at: number; ids: string[] }>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? MEMBER_CACHE_TTL_MS;
    this.max = opts.max ?? MEMBER_CACHE_MAX;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): string[] | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (this.now() - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.ids;
  }

  set(key: string, ids: string[]): void {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), ids });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

export function campaignSource(c: CampaignRow): CampaignSource {
  return c.sourceKind === 'list_view' && c.listViewId ? { kind: 'list_view', listViewId: c.listViewId } : { kind: 'soql', soql: c.soql };
}

/** Campaign id plus a hash of what decides membership, so an edited source misses. */
export function memberCacheKey(c: CampaignRow): string {
  const source = c.sourceKind === 'list_view' ? `lv:${c.listViewId ?? ''}` : `q:${c.soql}`;
  return `${c.id}:${createHash('sha256').update(source).digest('hex').slice(0, 16)}`;
}

/** The campaign's member Ids in query order (de-duplicated, capped at MAX_CAMPAIGN_RECORDS). */
export async function campaignMemberIds(
  deps: { client: SalesforceClient; cache: MemberIdCache },
  c: CampaignRow,
  opts: { fresh?: boolean } = {},
): Promise<string[]> {
  const key = memberCacheKey(c);
  if (!opts.fresh) {
    const hit = deps.cache.get(key);
    if (hit) return hit;
  }
  const soql = await membershipSoql(deps.client, { sfObject: SfObject.parse(c.sfObject), source: campaignSource(c) });
  const ids = await fetchMemberIds(deps.client, soql, MAX_CAMPAIGN_RECORDS);
  deps.cache.set(key, ids);
  return ids;
}

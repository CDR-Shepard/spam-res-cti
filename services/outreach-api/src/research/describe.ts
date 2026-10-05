import type { SalesforceClient, SObjectDescribe } from '@cti/salesforce';
import { FIELD_API_NAME } from '../crm/field-map.js';
import { SKIPPED_FIELD_TYPES } from './limits.js';

export const DESCRIBE_TTL_MS = 10 * 60_000;

export class DescribeCache {
  private readonly entries = new Map<string, { at: number; d: SObjectDescribe }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(opts: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? DESCRIBE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }
  get(key: string): SObjectDescribe | null {
    const hit = this.entries.get(key);
    return hit && this.now() - hit.at <= this.ttlMs ? hit.d : null;
  }
  set(key: string, d: SObjectDescribe): void {
    this.entries.set(key, { at: this.now(), d });
  }
}

/** The describe of `sobject` as the integration user sees it (field-level security already applied by Salesforce). */
export async function describeObject(client: SalesforceClient, cache: DescribeCache, orgId: string, sobject: string): Promise<SObjectDescribe> {
  const key = `${orgId}:${sobject}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const d = await client.describe(sobject);
  cache.set(key, d);
  return d;
}

/**
 * Every readable, non-binary, non-compound field: `Id` first, then `pinned` (the consent field,
 * matched case-insensitively, when the describe has it), then describe order, capped.
 */
export function readableFields(d: SObjectDescribe, max: number, pinned: string | null = null): Array<{ name: string; label: string }> {
  const kept = d.fields.filter((f) => !SKIPPED_FIELD_TYPES.has(f.type) && FIELD_API_NAME.test(f.name));
  const isPinned = (name: string): boolean => pinned !== null && name !== 'Id' && name.toLowerCase() === pinned.toLowerCase();
  const head = [...kept.filter((f) => f.name === 'Id'), ...kept.filter((f) => isPinned(f.name))];
  const rest = kept.filter((f) => f.name !== 'Id' && !isPinned(f.name));
  return [...head, ...rest].slice(0, max).map((f) => ({ name: f.name, label: f.label }));
}

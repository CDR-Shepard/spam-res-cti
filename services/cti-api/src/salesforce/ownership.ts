/**
 * The ONE ownership rule: may this rep have a Salesforce Task written on this
 * record? Applied in three places — the rollover worker (no next-day copy), the
 * after-call sync worker (no Task), and POST /calls (the `taskAllowed` flag the
 * softphone honors).
 *
 * It NEVER blocks placing a call. A rep can dial anyone; what the gate protects
 * is another rep's activity history, which is what the org actually reports on.
 *
 * Objects the rule does not name (custom objects like `Deal__c`) are ALLOWED:
 * `findByPhone` can match one, and refusing to log a call because we don't know
 * an object's ownership model would silently drop real activity.
 */
import { soqlEscape, soqlQuery } from './client.js';

export type OwnedObject = 'Lead' | 'Contact' | 'Opportunity' | 'Task';

export interface OwnershipSnapshot {
  type: OwnedObject | 'other';
  ownerId: string | null;
  leadManagerId?: string | null;
}

export function objectTypeForId(id: string): OwnedObject | 'other' {
  const p = id.slice(0, 3);
  return p === '00Q' ? 'Lead' : p === '003' ? 'Contact' : p === '006' ? 'Opportunity' : p === '00T' ? 'Task' : 'other';
}

/** The rule: Lead/Contact/Task → owner; Opportunity → owner OR Lead_Manager__c; unnamed objects → allowed. */
export function callerMayCreateTaskOn(s: OwnershipSnapshot, callerSfUserId: string): boolean {
  if (s.type === 'other') return true;
  if (s.ownerId === callerSfUserId) return true;
  return s.type === 'Opportunity' && !!s.leadManagerId && s.leadManagerId === callerSfUserId;
}

const TTL_MS = 5 * 60_000;
/** Sweep expired entries once the cache passes this size. Ownership is looked up
 *  per dialed record, so an unswept Map would grow for the life of the process. */
const CACHE_SWEEP_AT = 5_000;
const cache = new Map<string, { at: number; snap: OwnershipSnapshot }>();
let warnedLeadManager = false;

function remember(recordId: string, snap: OwnershipSnapshot): OwnershipSnapshot {
  if (cache.size >= CACHE_SWEEP_AT) {
    const stale = Date.now() - TTL_MS;
    for (const [k, v] of cache) if (v.at < stale) cache.delete(k);
  }
  cache.set(recordId, { at: Date.now(), snap });
  return snap;
}

/**
 * Owner (and, for an Opportunity, Lead_Manager__c) of a record, cached 5 minutes.
 * Errors are NOT cached — they propagate so the caller can fail closed and retry.
 */
export async function fetchOwnership(userId: string, recordId: string): Promise<OwnershipSnapshot> {
  const hit = cache.get(recordId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.snap;
  const type = objectTypeForId(recordId);
  if (type === 'other') return remember(recordId, { type, ownerId: null });
  // The org may not have Lead_Manager__c at all. That is a configuration fact,
  // not a failure — and one we only need to learn ONCE. After the first
  // INVALID_FIELD the flag routes every later Opportunity straight to the
  // owner-only query below, instead of paying a guaranteed 400 (and a second
  // round-trip) against the org's API limits on every cache miss forever.
  if (type === 'Opportunity' && !warnedLeadManager) {
    try {
      const r = await soqlQuery<{ OwnerId: string; Lead_Manager__c?: string | null }>(
        userId,
        `SELECT OwnerId, Lead_Manager__c FROM Opportunity WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`,
      );
      return remember(recordId, { type, ownerId: r[0]?.OwnerId ?? null, leadManagerId: r[0]?.Lead_Manager__c ?? null });
    } catch (err) {
      if (!/INVALID_FIELD/.test((err as Error).message)) throw err;
      warnedLeadManager = true;
      console.warn('[ownership] Lead_Manager__c not found on Opportunity — gate is owner-only');
    }
  }
  // Owner-only: Lead/Contact/Task, and an Opportunity in an org without the field
  // (no lead manager to consider, so the gate is the owner alone).
  const r = await soqlQuery<{ OwnerId: string }>(
    userId,
    `SELECT OwnerId FROM ${type} WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`,
  );
  return remember(recordId, { type, ownerId: r[0]?.OwnerId ?? null });
}

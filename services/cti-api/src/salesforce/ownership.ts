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
 *
 * 2026-08-26 (pseudo-queue Users): live prod evidence showed the org also
 * models some queues as regular Users, not Groups — Salesforce does not allow
 * a Group to own an Opportunity, so queues like "Opportunity Hunt Queue" and
 * "Closer Hunt Queue LA/SD" exist as `005…` Users instead of `00G…` Groups.
 * `isQueueLikeOwner` extends the existing `00G` rule to also recognize a
 * User owner whose Name matches "queue" as a whole word — same "queues
 * aren't people" reasoning as the 00G rule, just a second way the org
 * represents one.
 */
import { soqlEscape, soqlQuery } from './client.js';

export type OwnedObject = 'Lead' | 'Contact' | 'Opportunity' | 'Task';

export interface OwnershipSnapshot {
  type: OwnedObject | 'other';
  ownerId: string | null;
  /** Owner.Name, when the fetch path selected it. Absent/null on older cached
   *  shapes or a partial API response — that just means the queue-name rule
   *  (see `isQueueLikeOwner`) cannot fire, not that ownership is unknown. */
  ownerName?: string | null;
  leadManagerId?: string | null;
}

export function objectTypeForId(id: string): OwnedObject | 'other' {
  const p = id.slice(0, 3);
  return p === '00Q' ? 'Lead' : p === '003' ? 'Contact' : p === '006' ? 'Opportunity' : p === '00T' ? 'Task' : 'other';
}

/**
 * Is this owner a queue, not a person? True for either:
 *  - a real Salesforce Group/Queue id (`OwnerId` prefix `00G`), regardless of
 *    name, OR
 *  - a User (`OwnerId` prefix `005`) whose Name matches "queue" as a whole
 *    word, case-insensitively (ruling 2026-08-26: the org also models some
 *    queues as regular Users, because Salesforce does not allow Groups to own
 *    Opportunities — e.g. "Closer Hunt Queue LA", "Opportunity Hunt Queue").
 *    A missing/null name never matches — rule 2 simply doesn't fire — and the
 *    word-boundary keeps a real name like "Queued Reports" from matching.
 *
 * Exported and pure so the decision reads as one rule and tests hit it
 * directly, instead of duplicating the two conditions inline at every gate.
 */
export function isQueueLikeOwner(ownerId: string | null | undefined, ownerName: string | null | undefined): boolean {
  if (ownerId?.startsWith('00G')) return true;
  if (!ownerId?.startsWith('005')) return false;
  return !!ownerName && /\bqueue\b/i.test(ownerName);
}

/**
 * The rule: Lead/Contact/Task → owner; Opportunity → owner OR LeadManager__c;
 * a queue-owned record (see `isQueueLikeOwner` — a `00G` Group, or a `005`
 * User whose Name matches "queue") → allowed for ANY rep, for every object
 * type the rule covers (ruling 2026-08-26: queues aren't people, so nobody is
 * being poached — this is the team's dominant call pattern, e.g. the LA/SD
 * Hunt Queue leads, and the pseudo-queue Users used where Opportunities can't
 * be Group-owned); unnamed objects → allowed.
 */
export function callerMayCreateTaskOn(s: OwnershipSnapshot, callerSfUserId: string): boolean {
  if (s.type === 'other') return true;
  if (isQueueLikeOwner(s.ownerId, s.ownerName)) return true;
  if (s.ownerId === callerSfUserId) return true;
  return s.type === 'Opportunity' && !!s.leadManagerId && s.leadManagerId === callerSfUserId;
}

const TTL_MS = 5 * 60_000;
/** Sweep expired entries once the cache passes this size. Ownership is looked up
 *  per dialed record, so an unswept Map would grow for the life of the process. */
const CACHE_SWEEP_AT = 5_000;
const cache = new Map<string, { at: number; snap: OwnershipSnapshot }>();
/** Warn deduper ONLY. It must never gate the query itself: this process serves
 *  many orgs (salesforce_connections is per user), so one org missing the field
 *  cannot be allowed to decide what we ask every other org. */
let warnedLeadManager = false;

/** Cache key. SOQL runs under the CALLING user's sharing rules, so the same
 *  record id legitimately answers differently per rep — a rep who cannot see a
 *  record gets zero rows, and serving that to its actual owner would silently
 *  suppress their Task. */
const cacheKey = (userId: string, recordId: string): string => `${userId}:${recordId}`;

function remember(key: string, snap: OwnershipSnapshot): OwnershipSnapshot {
  if (cache.size >= CACHE_SWEEP_AT) {
    const stale = Date.now() - TTL_MS;
    for (const [k, v] of cache) if (v.at < stale) cache.delete(k);
  }
  cache.set(key, { at: Date.now(), snap });
  return snap;
}

/** Drop the process-wide cache and the warn-once flag. Tests only. */
export function _resetOwnershipForTests(): void {
  cache.clear();
  warnedLeadManager = false;
}

/**
 * Owner (and, for an Opportunity, LeadManager__c) of a record, cached 5 minutes
 * per (user, record). Zero rows → `{ ownerId: null }`: the rep cannot see the
 * record, so no Task belongs on it.
 *
 * Errors are NOT cached — they propagate so the caller can fail closed and retry.
 */
export async function fetchOwnership(userId: string, recordId: string): Promise<OwnershipSnapshot> {
  const key = cacheKey(userId, recordId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.snap;
  const type = objectTypeForId(recordId);
  if (type === 'other') return remember(key, { type, ownerId: null });
  if (type === 'Opportunity') {
    try {
      const r = await soqlQuery<{ OwnerId: string; LeadManager__c?: string | null; Owner?: { Name?: string | null } | null }>(
        userId,
        `SELECT OwnerId, LeadManager__c, Owner.Name FROM Opportunity WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`,
      );
      return remember(key, {
        type,
        ownerId: r[0]?.OwnerId ?? null,
        ownerName: r[0]?.Owner?.Name ?? null,
        leadManagerId: r[0]?.LeadManager__c ?? null,
      });
    } catch (err) {
      // The org may not have LeadManager__c at all. That is a configuration
      // fact, not a failure: fall through to the owner-only query for THIS
      // lookup. The log line is deduped; the query is not.
      if (!/INVALID_FIELD/.test((err as Error).message)) throw err;
      if (!warnedLeadManager) {
        warnedLeadManager = true;
        console.warn('[ownership] LeadManager__c not found on Opportunity — gate is owner-only');
      }
    }
  }
  // Owner-only: Lead/Contact/Task, and an Opportunity in an org without the field
  // (no lead manager to consider, so the gate is the owner alone). Owner.Name
  // is selected here too — the polymorphic Owner relationship is valid on all
  // four object types this branch serves.
  const r = await soqlQuery<{ OwnerId: string; Owner?: { Name?: string | null } | null }>(
    userId,
    `SELECT OwnerId, Owner.Name FROM ${type} WHERE Id = '${soqlEscape(recordId)}' LIMIT 1`,
  );
  return remember(key, { type, ownerId: r[0]?.OwnerId ?? null, ownerName: r[0]?.Owner?.Name ?? null });
}

/**
 * The ids whose ownership the rule actually names. Objects it does not name are
 * allowed outright, so a caller can use this to skip the round-trip entirely —
 * including the one that resolves the caller's own Salesforce user id.
 */
export function gatedIds(ids: Array<string | null | undefined>): string[] {
  return ids.filter((id): id is string => !!id && objectTypeForId(id) !== 'other');
}

/**
 * May this rep have a Task written that attaches to ALL of these records?
 *
 * A call Task carries a WhoId AND a WhatId, and the rule is "no Task on a record
 * the caller does not own or manage" — so every attached id has to pass, not
 * just the first one. Custom objects are skipped without a lookup.
 *
 * `lookup` is required rather than defaulted to `fetchOwnership`, which needs a
 * userId this signature does not carry: callers bind their own, e.g.
 * `(id) => fetchOwnership(call.userId, id)`. Tests inject a fake.
 *
 * Sequential on purpose: it short-circuits on the first failure, and there are
 * at most two ids. A lookup that throws propagates — the caller fails closed.
 */
export async function mayCreateTaskOn(
  ids: Array<string | null | undefined>,
  callerSfUserId: string,
  lookup: (recordId: string) => Promise<OwnershipSnapshot>,
): Promise<boolean> {
  for (const id of gatedIds(ids)) {
    if (!callerMayCreateTaskOn(await lookup(id), callerSfUserId)) return false;
  }
  return true;
}

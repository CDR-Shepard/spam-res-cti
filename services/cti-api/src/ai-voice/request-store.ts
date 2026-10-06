/**
 * Idempotency for POST /internal/ai-calls (migration 0053): a key is reserved BEFORE
 * anything is dialed, and its answer is stored afterwards, so a replay or a retry after a
 * lost response gets the stored answer and never a second call. The query builders are
 * exported so their SQL is pinned by rendering it (request-store.test.ts), as store.ts does.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { InternalAiCallResponse } from '@cti/contracts';
import { schema } from '@cti/db';
import type { Db } from '../dialer/pick-did.js';

/** An unanswered reservation not touched (reserved or taken over: updated_at) for this long is treated as a crashed request. */
export const STALE_REQUEST_MS = 10 * 60_000;
export const requestHash = (rawBody: string): string => createHash('sha256').update(rawBody, 'utf8').digest('hex');

const r = schema.aiCallRequests;
export type AiCallRequestRow = typeof r.$inferSelect;

export interface FoundCall {
  id: string;
  status: string;
  blockReason: string | null;
  callSid: string | null;
}

export interface AiCallRequestStore {
  /** Reserves the key; `existing` when it was already taken (by an earlier or a concurrent request). */
  reserve(a: { orgId: string; key: string; hash: string; userId: string }): Promise<{ kind: 'new' } | { kind: 'existing'; row: AiCallRequestRow }>;
  /** Stores the answer of an UNANSWERED key; a key that already has an answer keeps it (S-5). */
  complete(orgId: string, key: string, response: InternalAiCallResponse): Promise<void>;
  /**
   * Atomically takes over an unanswered reservation whose updated_at is older than STALE_REQUEST_MS (a crashed request):
   * one UPDATE stamps updated_at, so of any number of concurrent retries exactly one gets `true` (S-3). created_at is
   * NEVER restamped: it stays the original reservation, so every retry looks for a call from there (M-A). Never frees the
   * key: an unanswered reservation is only ever taken over, so a retry cannot dial while another is in flight.
   */
  takeOver(orgId: string, key: string): Promise<boolean>;
  /**
   * The ai_calls row a crashed request may have produced: a record key finds a real call on the record, a test or practice
   * key a call of its own kind to the number it rang (Fix 1, I-2: a practice call carries the real record id, so a record
   * key must never take it for the real call).
   */
  findCallSince(a: CallLookup): Promise<FoundCall | null>;
  /**
   * Records the call a request just inserted on its still-unanswered reservation (final review m3), before it is dialed,
   * so a crashed request's retry finds exactly that call by its key. Does not touch updated_at (the stale clock).
   */
  linkCall(orgId: string, key: string, aiCallId: string): Promise<void>;
  /** The call a reservation was linked to, by id (the same org and starter). */
  findCall(orgId: string, userId: string, aiCallId: string): Promise<FoundCall | null>;
}

export interface CallLookup {
  orgId: string;
  userId: string;
  sfRecordId: string | null;
  toE164: string | null;
  /** practice_browser (plan 1E) is never looked up by its leg: a crashed practice request only adopts its linked call. */
  kind: 'record' | 'test' | 'practice' | 'practice_browser';
  since: Date;
}

const RESERVE_ATTEMPTS = 3;
const byKey = (orgId: string, key: string) => and(eq(r.orgId, orgId), eq(r.idempotencyKey, key));

export function reserveQuery(db: Db, a: { orgId: string; key: string; hash: string; userId: string }) {
  return db
    .insert(r)
    .values({ orgId: a.orgId, idempotencyKey: a.key, requestHash: a.hash, userId: a.userId })
    .onConflictDoNothing()
    .returning({ key: r.idempotencyKey });
}

export function findRequestQuery(db: Db, orgId: string, key: string) {
  return db.select().from(r).where(byKey(orgId, key)).limit(1);
}

export function completeQuery(db: Db, orgId: string, key: string, response: InternalAiCallResponse) {
  return db
    .update(r)
    .set({ aiCallId: response.aiCallId, response, updatedAt: sql`now()` })
    .where(and(byKey(orgId, key), isNull(r.response)));
}

export function takeOverQuery(db: Db, orgId: string, key: string) {
  return db
    .update(r)
    .set({ updatedAt: sql`now()` })
    .where(and(byKey(orgId, key), isNull(r.response), lt(r.updatedAt, sql`now() - make_interval(secs => ${STALE_REQUEST_MS / 1000})`)))
    .returning({ key: r.idempotencyKey });
}

export function linkCallQuery(db: Db, orgId: string, key: string, aiCallId: string) {
  return db
    .update(r)
    .set({ aiCallId })
    .where(and(byKey(orgId, key), isNull(r.response), isNull(r.aiCallId)));
}

export function findCallByIdQuery(db: Db, orgId: string, userId: string, aiCallId: string) {
  const c = schema.aiCalls;
  return db
    .select({ id: c.id, status: c.status, blockReason: c.blockReason, callSid: c.callSid })
    .from(c)
    .where(and(eq(c.orgId, orgId), eq(c.startedBy, userId), eq(c.id, aiCallId)))
    .limit(1);
}

export function findCallSinceQuery(db: Db, a: CallLookup) {
  const c = schema.aiCalls;
  const target =
    a.kind === 'record'
      ? and(eq(c.sfRecordId, a.sfRecordId ?? ''), eq(c.isTest, false))
      : and(eq(c.toE164, a.toE164 ?? ''), eq(c.isTest, true), eq(c.practice, a.kind === 'practice' || a.kind === 'practice_browser'));
  return db
    .select({ id: c.id, status: c.status, blockReason: c.blockReason, callSid: c.callSid })
    .from(c)
    .where(and(eq(c.orgId, a.orgId), eq(c.startedBy, a.userId), target, gte(c.createdAt, a.since)))
    .orderBy(desc(c.createdAt))
    .limit(1);
}

/** The live store. `dbOf` is resolved on each call, so registering the routes never opens a database. */
export function drizzleAiCallRequestStore(dbOf: () => Db): AiCallRequestStore {
  return {
    async reserve(a) {
      const db = dbOf();
      for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
        if ((await reserveQuery(db, a)).length > 0) return { kind: 'new' };
        const [row] = await findRequestQuery(db, a.orgId, a.key);
        if (row) return { kind: 'existing', row };
        // The row vanished between the two statements (an operator's cleanup): reserve again (never act without a reservation).
      }
      throw new Error('ai_call_requests: the key could be neither reserved nor read');
    },
    async complete(orgId, key, response) {
      await completeQuery(dbOf(), orgId, key, response);
    },
    async takeOver(orgId, key) {
      return (await takeOverQuery(dbOf(), orgId, key)).length > 0;
    },
    async findCallSince(a) {
      const [row] = await findCallSinceQuery(dbOf(), a);
      return row ?? null;
    },
    async linkCall(orgId, key, aiCallId) {
      await linkCallQuery(dbOf(), orgId, key, aiCallId);
    },
    async findCall(orgId, userId, aiCallId) {
      const [row] = await findCallByIdQuery(dbOf(), orgId, userId, aiCallId);
      return row ?? null;
    },
  };
}

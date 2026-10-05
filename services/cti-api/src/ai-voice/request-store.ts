/**
 * Idempotency for POST /internal/ai-calls (migration 0053): a key is reserved BEFORE
 * anything is dialed, and its answer is stored afterwards, so a replay or a retry after a
 * lost response gets the stored answer and never a second call. The query builders are
 * exported so their SQL is pinned by rendering it (request-store.test.ts), as store.ts does.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { InternalAiCallResponse } from '@cti/contracts';
import { schema } from '@cti/db';
import type { Db } from '../dialer/pick-did.js';

/** An unanswered reservation older than this is treated as a crashed request. */
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
  complete(orgId: string, key: string, response: InternalAiCallResponse): Promise<void>;
  /** Frees an unanswered reservation (an answered one is never removed). */
  release(orgId: string, key: string): Promise<void>;
  /** The ai_calls row a crashed request may have produced. */
  findCallSince(a: { orgId: string; userId: string; sfRecordId: string | null; toE164: string | null; since: Date }): Promise<FoundCall | null>;
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
    .where(byKey(orgId, key));
}

export function releaseQuery(db: Db, orgId: string, key: string) {
  return db.delete(r).where(and(eq(r.orgId, orgId), eq(r.idempotencyKey, key), isNull(r.response)));
}

export function findCallSinceQuery(db: Db, a: Parameters<AiCallRequestStore['findCallSince']>[0]) {
  const c = schema.aiCalls;
  const target = a.sfRecordId !== null ? eq(c.sfRecordId, a.sfRecordId) : eq(c.toE164, a.toE164 ?? '');
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
        // Released between the two statements: reserve again (never act without a reservation).
      }
      throw new Error('ai_call_requests: the key could be neither reserved nor read');
    },
    async complete(orgId, key, response) {
      await completeQuery(dbOf(), orgId, key, response);
    },
    async release(orgId, key) {
      await releaseQuery(dbOf(), orgId, key);
    },
    async findCallSince(a) {
      const [row] = await findCallSinceQuery(dbOf(), a);
      return row ?? null;
    },
  };
}

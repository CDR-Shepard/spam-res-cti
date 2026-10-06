/**
 * Test a record limits (plan 1E, spec §8.2), counted in Postgres so they survive restarts and replicas. Each check runs in
 * one transaction under `pg_advisory_xact_lock(hashtext('rtest:' || userId))`, then the caller's insert, so two quick
 * clicks by the same admin cannot both pass. The tenant's per-day count is read under the admin's lock only: two admins
 * starting at the same instant may overshoot it by one each, which the daily AI budget still bounds.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { spentTodayMicros, utcDay } from '../ai/budget.js';
import { PREVIEW_STALE_MS } from './store.js';

export { PREVIEW_STALE_MS };
export const PREVIEWS_PER_HOUR = 10;
export const PREVIEWS_PER_DAY = 40;
export const CALLS_PER_HOUR = 6;
/**
 * A test call with no answer yet (the trigger is in flight, or its answer was lost and cti-api stored none) blocks the next
 * one this long. As the 1D practice guard (ai-calls/practice-guard.ts): a lost answer's call is found by its key in
 * ai_call_requests (cti-api links it there when it inserts it) and blocks while live; an answer that placed nothing frees at once.
 */
export const UNANSWERED_CALL_MS = 2 * 60_000;
const HOUR_MS = 60 * 60_000;
/** A live AI call older than this no longer blocks: a stuck row must not lock an admin out. */
const LIVE_CALL_MAX_AGE_MS = HOUR_MS;
/** ai_calls statuses after which the call is over. */
const TERMINAL_CALL_STATUSES = ['completed', 'failed', 'blocked', 'transferred'] as const;

export type LimitRefusal =
  /** `limit` says which window refused, for the words; `retryAt` is when it next allows one. */
  | { code: 'RATE_LIMITED'; retryAt: Date; limit: 'previews_per_hour' | 'previews_per_day' | 'calls_per_hour' }
  | { code: 'PREVIEW_RUNNING' }
  | { code: 'CALL_IN_PROGRESS' }
  | { code: 'AI_BUDGET_SPENT' };
export type LimitResult<T> = { ok: true; value: T } | { ok: false; refusal: LimitRefusal };

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => d.toISOString();

/** Runs `check` then `insert` in one transaction under this admin's advisory lock; a refusal inserts nothing. */
async function underLock<T>(db: Db, userId: string, check: (tx: Db) => Promise<LimitRefusal | null>, insert: (tx: Db) => Promise<T>): Promise<LimitResult<T>> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rtest:${userId}`}))`);
    const refusal = await check(tx);
    if (refusal) return { ok: false, refusal };
    return { ok: true, value: await insert(tx) };
  });
}

interface WindowCount {
  n: number;
  oldest: Date | string | null;
}

async function previewRefusal(tx: Db, a: { orgId: string; userId: string; now: Date; budgetMicros: number }): Promise<LimitRefusal | null> {
  const { orgId, userId, now } = a;
  const [running] = rows<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from ai_record_tests
      where org_id = ${orgId}::uuid and requested_by = ${userId}::uuid and status = 'running'
        and created_at > ${iso(new Date(now.getTime() - PREVIEW_STALE_MS))}::timestamptz`),
  );
  if (running!.n > 0) return { code: 'PREVIEW_RUNNING' };
  const [hour] = rows<WindowCount>(
    await tx.execute(sql`
      select count(*)::int as n, min(created_at) as oldest from ai_record_tests
      where org_id = ${orgId}::uuid and requested_by = ${userId}::uuid
        and created_at > ${iso(new Date(now.getTime() - HOUR_MS))}::timestamptz`),
  );
  if (hour!.n >= PREVIEWS_PER_HOUR) {
    return { code: 'RATE_LIMITED', retryAt: new Date(new Date(hour!.oldest!).getTime() + HOUR_MS), limit: 'previews_per_hour' };
  }
  const dayStart = new Date(`${utcDay(now)}T00:00:00.000Z`);
  const [day] = rows<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from ai_record_tests
      where org_id = ${orgId}::uuid and created_at >= ${iso(dayStart)}::timestamptz`),
  );
  if (day!.n >= PREVIEWS_PER_DAY) return { code: 'RATE_LIMITED', retryAt: new Date(dayStart.getTime() + 24 * HOUR_MS), limit: 'previews_per_day' };
  if ((await spentTodayMicros(tx, orgId, now)) >= a.budgetMicros) return { code: 'AI_BUDGET_SPENT' };
  return null;
}

async function callRefusal(tx: Db, a: { orgId: string; userId: string; now: Date }): Promise<LimitRefusal | null> {
  const { orgId, userId, now } = a;
  const terminal = sql.join(TERMINAL_CALL_STATUSES.map((s) => sql`${s}`), sql`, `);
  const [live] = rows<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n
      from ai_record_test_calls c
      left join ai_call_requests q on c.ai_call_id is null and q.org_id = c.org_id and q.idempotency_key = c.idempotency_key
      left join ai_calls a on a.id = coalesce(c.ai_call_id, q.ai_call_id) and a.org_id = c.org_id
      where c.org_id = ${orgId}::uuid and c.requested_by = ${userId}::uuid
        and (
          (a.id is not null and a.status not in (${terminal})
            and a.created_at > ${iso(new Date(now.getTime() - LIVE_CALL_MAX_AGE_MS))}::timestamptz)
          or (a.id is null and c.result is null and q.response is null
            and c.created_at > ${iso(new Date(now.getTime() - UNANSWERED_CALL_MS))}::timestamptz)
        )`),
  );
  if (live!.n > 0) return { code: 'CALL_IN_PROGRESS' };
  const [hour] = rows<WindowCount>(
    await tx.execute(sql`
      select count(*)::int as n, min(created_at) as oldest from ai_record_test_calls
      where org_id = ${orgId}::uuid and requested_by = ${userId}::uuid
        and created_at > ${iso(new Date(now.getTime() - HOUR_MS))}::timestamptz`),
  );
  if (hour!.n >= CALLS_PER_HOUR) return { code: 'RATE_LIMITED', retryAt: new Date(new Date(hour!.oldest!).getTime() + HOUR_MS), limit: 'calls_per_hour' };
  return null;
}

/** In one transaction: the advisory lock, the preview limits and the budget, then `insert` when allowed. */
export async function withPreviewLimit<T>(
  db: Db,
  a: { orgId: string; userId: string; now: Date; budgetMicros: number },
  insert: (tx: Db) => Promise<T>,
): Promise<LimitResult<T>> {
  return underLock(db, a.userId, (tx) => previewRefusal(tx, a), insert);
}

/** In one transaction: the advisory lock, the live-call and hourly call limits, then `insert` when allowed. */
export async function withCallLimit<T>(db: Db, a: { orgId: string; userId: string; now: Date }, insert: (tx: Db) => Promise<T>): Promise<LimitResult<T>> {
  return underLock(db, a.userId, (tx) => callRefusal(tx, a), insert);
}

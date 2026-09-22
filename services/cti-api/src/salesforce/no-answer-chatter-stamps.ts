/**
 * The STAMP half of the "No answer" sweep — one chunk of records, posted and
 * then written back to dialer_queue_items as the sweep's own record of what
 * Salesforce said. Split out of no-answer-chatter-worker.ts, which keeps the
 * scan / claim / retry machinery; nothing here knows about claims or backoff.
 *
 * Every write lands on EVERY qualifying item of a record (both attempts), and
 * those stamps are the idempotency key: `selectNoAnswerRecords` never selects a
 * record with a stamped attempt again. So a stamp that misses an item is not a
 * cosmetic gap — it is a re-post on the next pass.
 *
 * AT-LEAST-ONCE. The post and the stamp that records it cannot be one atomic
 * step (one is Salesforce, one is Postgres), so a chunk is stamped IMMEDIATELY
 * after its request returns, before the worker sends the next. A crash — or a
 * timeout whose request actually landed — re-posts at most ONE chunk's worth.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { createFeedItems, type FeedItemResult } from './client.js';
import { withTimeout } from './followup-worker.js';
import { noAnswerText, type NoAnswerRecord } from './no-answer-chatter.js';

/** Ceiling on one Collections POST. Longer than a read, as in followup-worker:
 *  it MUTATES Salesforce, and abandoning it early only buys a duplicate chunk. */
export const SF_POST_TIMEOUT_MS = 60_000;

const queueItems = schema.dialerQueueItems;

/** What posting and stamping a chunk needs. The worker's deps extend this. */
export interface StampDeps {
  db: ReturnType<typeof getDb>;
  /** One Collections POST (≤200), on the rep's own token — the rep is the author. */
  createFeedItems: typeof createFeedItems;
}

/** Terminal skip for every qualifying item of these records. One UPDATE per reason. */
export async function stampSkips(deps: StampDeps, sessionId: string, reason: string, itemIds: ReadonlyArray<string>): Promise<void> {
  await deps.db.update(queueItems)
    .set({ noAnswerSkipReason: reason })
    .where(and(eq(queueItems.sessionId, sessionId), inArray(queueItems.id, [...itemIds])));
}

/**
 * The posted FeedItem ids for one chunk, in ONE statement: every qualifying item
 * of a record (both attempts) gets that record's id. One statement, so the chunk
 * is stamped entirely or not at all — never a half-stamped chunk that a retry
 * would half re-post. The WHERE lists every item of every posted record; a
 * CASE arm with no matching row in the WHERE would be a silent no-op.
 */
export async function stampFeedItemIds(
  deps: StampDeps,
  sessionId: string,
  posted: ReadonlyArray<{ record: NoAnswerRecord; feedItemId: string }>,
): Promise<void> {
  const whens = posted.flatMap(({ record, feedItemId }) =>
    record.itemIds.map((itemId) => sql`when ${itemId}::uuid then ${feedItemId}::text`));
  await deps.db.update(queueItems)
    .set({ noAnswerFeedItemId: sql`case ${queueItems.id} ${sql.join(whens, sql` `)} end` })
    .where(and(eq(queueItems.sessionId, sessionId), inArray(queueItems.id, posted.flatMap((p) => p.record.itemIds))));
}

/** Item ids grouped by terminal skip reason, in first-seen order. Every record's
 *  items are kept — two records skipped for the same reason are both stamped. */
export function groupByReason(skips: ReadonlyArray<{ reason: string; record: NoAnswerRecord }>): Map<string, string[]> {
  const byReason = new Map<string, string[]>();
  for (const { reason, record } of skips) byReason.set(reason, [...(byReason.get(reason) ?? []), ...record.itemIds]);
  return byReason;
}

/**
 * Post one chunk and stamp its outcome before returning. A thrown request leaves
 * the chunk untouched (transient — the caller backs off); a per-record rejection
 * is Salesforce's final word on that record and is stamped as a skip.
 */
export async function postChunk(
  deps: StampDeps,
  session: { id: string; userId: string },
  chunk: ReadonlyArray<NoAnswerRecord>,
): Promise<void> {
  const results: FeedItemResult[] = await withTimeout(
    deps.createFeedItems(session.userId, chunk.map((r) => ({ parentId: r.recordId, body: noAnswerText(r.reasons) }))),
    SF_POST_TIMEOUT_MS,
    'feed item create',
  );
  // `createFeedItems` guarantees index alignment (it throws otherwise).
  const outcomes = chunk.map((record, i) => ({ record, result: results[i]! }));
  const rejected = outcomes.flatMap(({ record, result }) => (result.ok ? [] : [{ reason: result.statusCode, record, message: result.message }]));
  const posted = outcomes.flatMap(({ record, result }) => (result.ok ? [{ record, feedItemId: result.id }] : []));

  for (const r of rejected) {
    console.warn('[no-answer-chatter] post rejected', { sessionId: session.id, recordId: r.record.recordId, statusCode: r.reason, message: r.message });
  }
  for (const [reason, itemIds] of groupByReason(rejected)) await stampSkips(deps, session.id, reason, itemIds);
  // IMMEDIATELY, before the next chunk goes out — see AT-LEAST-ONCE in the header.
  if (posted.length > 0) await stampFeedItemIds(deps, session.id, posted);
}

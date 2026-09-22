/**
 * "No answer" Chatter worker — when a power-dial run ends, post one
 * "No answer (Power Dialer) — …" FeedItem, AS THE REP, on every record of the run
 * that was dialed and never connected, and only on records the rep owns.
 *
 * SCAN-BASED ON PURPOSE. Nothing enqueues work for this worker: each tick looks
 * for sessions that are `done`/`stopped` and not yet swept
 * (`no_answer_chatter_at IS NULL`). There is no enqueue step to lose, every way a
 * run can end is covered without naming it (the rep's Stop, the queue running
 * dry, the abandoned-run reaper), and dialer/engine.ts does not know this exists.
 *
 * NO HISTORICAL BACKFILL — two independent guards, both required:
 *  1. migration 0040 stamps every session that ended before the feature existed,
 *     and every session — whatever its status — not touched in 24h;
 *  2. `selectNoAnswerRecords` counts only misses that SETTLED inside
 *     SWEEP_WINDOW_MS (24h), by the item's own `updated_at`.
 * The scan, the claim, and `sweepEligible` also refuse a session whose
 * `updated_at` is older than 24h, but that is a pre-filter (and the index key),
 * not the guard: `stopSession` stamps the session clock on a paused/ready run
 * too, so a run paused weeks ago and stopped today looks fresh. Only the
 * attempt's clock says when the dial happened. Together, a bad deploy order, a
 * restored backup, a stale run stopped late, or a long stretch with the kill
 * switch off cannot turn into thousands of posts on old records, authored by
 * reps, that nobody can take back.
 *
 * AT-LEAST-ONCE. The post and the stamp that records it cannot be one atomic
 * step (one is Salesforce, one is Postgres). Posts go out in chunks of 200 and
 * each chunk's FeedItem ids are stamped IMMEDIATELY, before the next chunk is
 * sent — so a crash, or a timeout whose request actually landed, re-posts at most
 * ONE chunk's worth. A duplicate "No answer" is the accepted failure mode; a lost
 * one is not. The stamps are also the idempotency key: a record with any stamped
 * attempt is never selected again (`selectNoAnswerRecords`).
 *
 * ONE OWNER PER SESSION. The claim is a timestamp, and a claim older than
 * STUCK_AFTER_MS is up for grabs — that is how a dead worker's session gets
 * picked up, but it also means a worker that is merely SLOW (nothing bounds a
 * Postgres write) can have its claim taken while it is still running. So the
 * claim stamp is carried through the sweep: it is re-checked right before every
 * post (`assertStillClaimed`), and every later write to the session is
 * conditional on it (`patchClaimed`). A worker that lost its claim stops before
 * its next post and never clears, backs off, or finishes the new owner's claim.
 * The overlap that remains is the one chunk that was already in flight.
 *
 * `dialer_sessions.updated_at` is NEVER written here. It is the run's
 * last-status-flip clock (the engine stamps it on every flip), and the scan
 * pre-filter and the settle window read it — bumping it on a claim would slide
 * a session forward in time forever. Nor is `dialer_queue_items.updated_at`:
 * that is the attempt's settle time, the clock the 24h guard actually reads.
 *
 * Mirrors salesforce/followup-worker.ts (deps injection, CAS claim, backoff,
 * stuck-claim reaping, single-flight loop).
 */
import { and, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { getDb, schema } from '@cti/db';
import type { AppConfig } from '../config.js';
import type { DialerItem } from '../dialer/session-store.js';
import { FEED_ITEMS_PER_REQUEST, createFeedItems, type FeedItemResult } from './client.js';
import { isSalesforceAuthError, withTimeout } from './followup-worker.js';
import { SWEEP_WINDOW_MS, gateIdsFor, noAnswerText, selectNoAnswerRecords, verdictFor, type NoAnswerRecord } from './no-answer-chatter.js';
import { fetchOwnershipBatch, type OwnershipSnapshot } from './ownership.js';

/** Defined beside the predicate that reads it (no-answer-chatter.ts); re-exported
 *  because it is part of this worker's contract too (scan, claim, `sweepEligible`). */
export { SWEEP_WINDOW_MS };

export const MAX_ATTEMPTS = 8;
/** Doubling: 30s, 1m, 2m … ≈63 minutes over 8 attempts — long enough for a rep
 *  whose Salesforce token died to sign back in. */
export const BACKOFF_BASE_MS = 30_000;
/** How long after a run ends we keep waiting for a still-`dialing` item to settle. */
export const SETTLE_WINDOW_MS = 10 * 60_000;
/** …and how soon we look again while waiting. */
export const SETTLE_RECHECK_MS = 15_000;
export const CANDIDATE_LIMIT = 5;
export const LOOP_INTERVAL_MS = 15_000;
/** Ceiling on the whole batched ownership lookup (a handful of SOQL queries). */
export const OWNERSHIP_TIMEOUT_MS = 120_000;
/** Ceiling on one Collections POST. Longer than a read, as in followup-worker:
 *  it MUTATES Salesforce, and abandoning it early only buys a duplicate chunk. */
export const SF_POST_TIMEOUT_MS = 60_000;
/** A claim older than this is presumed dead. A run is capped at 500 records
 *  (routes/dialer.ts), so the Salesforce side of a sweep is bounded: the ownership
 *  lookup plus three posts, each at its timeout, is 5 minutes. This is twice
 *  that. The Postgres side is NOT bounded, which is why a claim is also
 *  re-checked before every post — see ONE OWNER PER SESSION in the header. */
export const STUCK_AFTER_MS = 10 * 60_000;

type Session = typeof schema.dialerSessions.$inferSelect;
const sessions = schema.dialerSessions;
const queueItems = schema.dialerQueueItems;

export interface NoAnswerChatterDeps {
  db: ReturnType<typeof getDb>;
  /** Batched owner lookup, run as the rep. Absent id = not returned by Salesforce. */
  ownership: (userId: string, ids: ReadonlyArray<string>) => Promise<Map<string, OwnershipSnapshot>>;
  /** One Collections POST (≤200), on the rep's own token — the rep is the author. */
  createFeedItems: typeof createFeedItems;
  now: () => Date;
}

/** What a successful claim hands the sweep: which attempt this is (from
 *  RETURNING — the row's truth, not our stale read + 1) and the exact stamp that
 *  proves the claim is still ours. */
interface Claim {
  attempts: number;
  heldSince: Date;
}

/** Another worker reaped our claim. Not a failure of the session — it is theirs now. */
class ClaimLostError extends Error {}

const ENDED: Array<Session['status']> = ['done', 'stopped'];

/**
 * Everything that makes a session sweepable RIGHT NOW: ended, not yet swept,
 * last flipped inside the last 24h, past its backoff floor, and unclaimed — or
 * claimed by a worker that has been gone longer than any sweep can take (this
 * IS the stuck-claim reaper; there is no separate reset pass).
 *
 * The 24h clause here is a PRE-FILTER (it is what the partial index covers),
 * not the no-backfill guard — see the header: `updated_at` is a status-flip
 * clock, and the guard that counts is on each attempt's own clock.
 *
 * One list, used by BOTH the scan and the claim. The claim is the last gate
 * before anything is posted, and a replica holding a candidate list from a few
 * seconds ago must not act on a session another replica has since swept, backed
 * off, or claimed.
 */
function sweepableNow(now: Date): Array<SQL | undefined> {
  return [
    inArray(sessions.status, ENDED),
    isNull(sessions.noAnswerChatterAt),
    gt(sessions.updatedAt, new Date(now.getTime() - SWEEP_WINDOW_MS)),
    or(isNull(sessions.noAnswerChatterNextAt), lte(sessions.noAnswerChatterNextAt, now)),
    or(isNull(sessions.noAnswerChatterClaimedAt), lte(sessions.noAnswerChatterClaimedAt, new Date(now.getTime() - STUCK_AFTER_MS))),
  ];
}

/**
 * Pure — the "owed a sweep" half of that decision, re-made in code so it is
 * testable without a database (same reasoning as `nudgeEligible` in
 * followup-worker.ts). A session that passes still posts nothing unless its
 * misses settled inside the window (`attemptedWithinWindow`).
 */
export function sweepEligible(session: Pick<Session, 'status' | 'updatedAt' | 'noAnswerChatterAt'>, now: Date): boolean {
  if (!ENDED.includes(session.status)) return false;
  if (session.noAnswerChatterAt != null) return false;
  return session.updatedAt.getTime() > now.getTime() - SWEEP_WINDOW_MS;
}

/**
 * CONDITIONAL claim: only the replica whose UPDATE matches owns the session —
 * Railway runs the old and the new container side by side on every deploy.
 * Null when another replica won.
 *
 * `deps.now()`, not the tick's clock: staleness is measured from this stamp, and
 * a batch can take minutes — a top-of-tick stamp would make the last session of
 * a batch look half-stuck the moment it was claimed.
 */
async function claimSession(deps: NoAnswerChatterDeps, sessionId: string): Promise<Claim | null> {
  const now = deps.now();
  const rows = await deps.db.update(sessions)
    .set({ noAnswerChatterClaimedAt: now, noAnswerChatterAttempts: sql`${sessions.noAnswerChatterAttempts} + 1` })
    .where(and(eq(sessions.id, sessionId), ...sweepableNow(now)))
    .returning({ attempts: sessions.noAnswerChatterAttempts });
  return rows[0] ? { attempts: rows[0].attempts, heldSince: now } : null;
}

/** This session, while — and only while — our claim on it stands. */
function claimedBy(sessionId: string, claim: Claim): SQL | undefined {
  return and(eq(sessions.id, sessionId), eq(sessions.noAnswerChatterClaimedAt, claim.heldSince));
}

/** Called right before each irreversible step. See ONE OWNER PER SESSION. */
async function assertStillClaimed(deps: NoAnswerChatterDeps, sessionId: string, claim: Claim): Promise<void> {
  const mine = await deps.db.query.dialerSessions.findFirst({ columns: { id: true }, where: claimedBy(sessionId, claim) });
  if (!mine) throw new ClaimLostError(sessionId);
}

/** A sweep-bookkeeping write. `updatedAt` is deliberately unrepresentable here —
 *  see the header: it is the run's "ended at" clock and this worker never moves it. */
type SweepPatch = Omit<PgUpdateSetSource<typeof sessions>, 'updatedAt'>;

/** Every write after the claim goes through here: it lands only if the claim is
 *  still ours, so a reaped worker can never clear or finish the new owner's claim. */
async function patchClaimed(deps: NoAnswerChatterDeps, sessionId: string, claim: Claim, patch: SweepPatch): Promise<void> {
  await deps.db.update(sessions).set(patch).where(claimedBy(sessionId, claim));
}

/** Swept — or given up on. Either way this session is never looked at again. */
function finished(now: Date): SweepPatch {
  return { noAnswerChatterAt: now, noAnswerChatterClaimedAt: null, noAnswerChatterNextAt: null };
}

/**
 * SETTLE CHECK. `stopSession` flips the run to `stopped` BEFORE it hangs up the
 * in-flight dial (on purpose — see engine.ts), so for a moment an ended run still
 * has a `dialing` item whose `no_connect` has not landed. Sweeping now would miss
 * that attempt. Past the window a lost webhook must not wedge the sweep: proceed,
 * and the row is simply not an attempt.
 */
function stillSettling(session: Pick<Session, 'updatedAt'>, items: ReadonlyArray<Pick<DialerItem, 'status'>>, now: Date): boolean {
  return now.getTime() - session.updatedAt.getTime() < SETTLE_WINDOW_MS && items.some((i) => i.status === 'dialing');
}

/** Hand the claim back — and the attempt with it: waiting is not failing. */
function settleRelease(now: Date): SweepPatch {
  return {
    noAnswerChatterClaimedAt: null,
    noAnswerChatterAttempts: sql`greatest(${sessions.noAnswerChatterAttempts} - 1, 0)`,
    noAnswerChatterNextAt: new Date(now.getTime() + SETTLE_RECHECK_MS),
  };
}

async function loadItems(deps: NoAnswerChatterDeps, sessionId: string): Promise<DialerItem[]> {
  return deps.db.query.dialerQueueItems.findMany({ where: eq(queueItems.sessionId, sessionId) });
}

/** Terminal skip for every qualifying item of these records. One UPDATE per reason. */
async function stampSkips(deps: NoAnswerChatterDeps, sessionId: string, reason: string, itemIds: ReadonlyArray<string>): Promise<void> {
  await deps.db.update(queueItems)
    .set({ noAnswerSkipReason: reason })
    .where(and(eq(queueItems.sessionId, sessionId), inArray(queueItems.id, [...itemIds])));
}

/**
 * The posted FeedItem ids for one chunk, in ONE statement: every qualifying item
 * of a record (both attempts) gets that record's id. One statement, so the chunk
 * is stamped entirely or not at all — never a half-stamped chunk that a retry
 * would half re-post.
 */
async function stampFeedItemIds(
  deps: NoAnswerChatterDeps,
  sessionId: string,
  posted: ReadonlyArray<{ record: NoAnswerRecord; feedItemId: string }>,
): Promise<void> {
  const whens = posted.flatMap(({ record, feedItemId }) =>
    record.itemIds.map((itemId) => sql`when ${itemId}::uuid then ${feedItemId}::text`));
  await deps.db.update(queueItems)
    .set({ noAnswerFeedItemId: sql`case ${queueItems.id} ${sql.join(whens, sql` `)} end` })
    .where(and(eq(queueItems.sessionId, sessionId), inArray(queueItems.id, posted.flatMap((p) => p.record.itemIds))));
}

function chunksOf<T>(list: ReadonlyArray<T>, size: number): T[][] {
  return Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
}

/** Item ids grouped by terminal skip reason, in first-seen order. */
function groupByReason(skips: ReadonlyArray<{ reason: string; record: NoAnswerRecord }>): Map<string, string[]> {
  const byReason = new Map<string, string[]>();
  for (const { reason, record } of skips) byReason.set(reason, [...(byReason.get(reason) ?? []), ...record.itemIds]);
  return byReason;
}

/**
 * Post one chunk and stamp its outcome before returning. A thrown request leaves
 * the chunk untouched (transient — the caller backs off); a per-record rejection
 * is Salesforce's final word on that record and is stamped as a skip.
 */
async function postChunk(deps: NoAnswerChatterDeps, session: Session, chunk: ReadonlyArray<NoAnswerRecord>): Promise<void> {
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

/**
 * Ownership for the whole run at once, THEN the posts. A lookup that throws
 * leaves through the caller's catch with nothing posted: fail closed, never post
 * unverified. Skips are stamped first — they are terminal and need no Salesforce
 * write, so a later failure cannot cost them.
 */
async function postOwnedRecords(deps: NoAnswerChatterDeps, session: Session, claim: Claim, records: ReadonlyArray<NoAnswerRecord>): Promise<void> {
  const gateIds = [...new Set(records.flatMap(gateIdsFor))];
  const owners = await withTimeout(deps.ownership(session.userId, gateIds), OWNERSHIP_TIMEOUT_MS, 'ownership batch');
  const verdicts = records.map((record) => ({ record, reason: verdictFor(record, owners, session.sfOwnerId) }));

  for (const [reason, itemIds] of groupByReason(verdicts.filter((v) => v.reason !== 'post'))) {
    await stampSkips(deps, session.id, reason, itemIds);
  }
  const postable = verdicts.filter((v) => v.reason === 'post').map((v) => v.record);
  for (const chunk of chunksOf(postable, FEED_ITEMS_PER_REQUEST)) {
    await assertStillClaimed(deps, session.id, claim);
    await postChunk(deps, session, chunk);
  }
}

/** How many records are STILL owed a post — read back from what is actually
 *  stamped. Only for the give-up log, so a failure here is a null, not a throw. */
async function recordsStillOwed(deps: NoAnswerChatterDeps, sessionId: string): Promise<number | null> {
  try {
    return selectNoAnswerRecords(await loadItems(deps, sessionId), deps.now()).length;
  } catch {
    return null;
  }
}

/** Transient failure: back off and retry — or, out of attempts, give up loudly. */
async function failSession(deps: NoAnswerChatterDeps, session: Session, claim: Claim, err: unknown): Promise<void> {
  // A dead token reads the same as any other failure here ON PURPOSE: unlike the
  // rollover, nothing is half-done and the rep may well sign back in within the
  // ~63-minute retry window. The flag is only so the log says why.
  const reason = isSalesforceAuthError(err) ? 'reconnect Salesforce' : (err instanceof Error ? err.message : String(err)).slice(0, 500);
  if (claim.attempts >= MAX_ATTEMPTS) {
    const recordsLeft = await recordsStillOwed(deps, session.id);
    console.error('[no-answer-chatter] giving up', { sessionId: session.id, userId: session.userId, recordsLeft, attempts: claim.attempts, reason });
    await patchClaimed(deps, session.id, claim, finished(deps.now()));
    return;
  }
  console.warn('[no-answer-chatter] sweep failed; will retry', { sessionId: session.id, attempts: claim.attempts, reason });
  const delay = BACKOFF_BASE_MS * 2 ** (claim.attempts - 1);
  await patchClaimed(deps, session.id, claim, { noAnswerChatterClaimedAt: null, noAnswerChatterNextAt: new Date(deps.now().getTime() + delay) });
}

/** One claimed session, start to finish. Handles its own Salesforce failures. */
async function sweepSession(deps: NoAnswerChatterDeps, session: Session, claim: Claim): Promise<void> {
  try {
    const items = await loadItems(deps, session.id);
    if (stillSettling(session, items, deps.now())) {
      await patchClaimed(deps, session.id, claim, settleRelease(deps.now()));
      return;
    }
    // Nothing owed (everyone answered, the run never dialed, or every miss is
    // older than the window) → finished, and not a single Salesforce call was
    // spent finding that out.
    const records = selectNoAnswerRecords(items, deps.now());
    if (records.length > 0) await postOwnedRecords(deps, session, claim, records);
    await patchClaimed(deps, session.id, claim, finished(deps.now()));
  } catch (err) {
    if (err instanceof ClaimLostError) {
      console.warn('[no-answer-chatter] claim lost mid-sweep; another worker owns it', { sessionId: session.id });
      return;
    }
    await failSession(deps, session, claim, err);
  }
}

function liveDeps(): NoAnswerChatterDeps {
  return { db: getDb(), ownership: fetchOwnershipBatch, createFeedItems, now: () => new Date() };
}

/** Never throws: one bad session — or a database that is down — must not take
 *  the loop, or the sessions behind it, with it. */
export async function runNoAnswerChatterTick(deps: NoAnswerChatterDeps = liveDeps()): Promise<{ processed: number }> {
  let processed = 0;
  try {
    const candidates = await deps.db.query.dialerSessions.findMany({
      where: and(...sweepableNow(deps.now())),
      orderBy: (t, { asc }) => [asc(t.updatedAt)],
      limit: CANDIDATE_LIMIT,
    });
    for (const session of candidates) {
      try {
        if (!sweepEligible(session, deps.now())) continue;
        const claim = await claimSession(deps, session.id);
        if (!claim) continue; // another replica claimed it
        processed++;
        await sweepSession(deps, session, claim);
      } catch (err) {
        // sweepSession handles Salesforce failures itself; a throw here means a
        // DB write failed. The claim it leaves behind is reaped after STUCK_AFTER_MS.
        console.error('[no-answer-chatter] session crashed', { sessionId: session.id, err: (err as Error).message });
      }
    }
  } catch (err) {
    console.error('[no-answer-chatter] tick failed', { err: (err as Error).message });
  }
  return { processed };
}

/** Drive from server.ts (via `maybeStartNoAnswerChatterLoop`). Single-flight — a
 *  slow tick is never overlapped. */
export function startNoAnswerChatterLoop(intervalMs = LOOP_INTERVAL_MS): NodeJS.Timeout {
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    runNoAnswerChatterTick()
      .catch((err) => console.error('[no-answer-chatter] tick error', err))
      .finally(() => { running = false; });
  }, intervalMs);
}

/**
 * THE KILL SWITCH. `NO_ANSWER_CHATTER=off` means the loop is never started — no
 * scan, no claim, no post. Extracted from server.ts (which runs `main()` on
 * import and so cannot be tested) because a loop nothing pins is a feature that
 * can silently stop existing. Returns the timer for `close()`, or null when off.
 *
 * Turning it back ON sweeps the runs that ended in the last 24h and nothing
 * older — the same window as everything else here.
 */
export function maybeStartNoAnswerChatterLoop(
  cfg: Pick<AppConfig, 'NO_ANSWER_CHATTER'>,
  start: (intervalMs: number) => NodeJS.Timeout = startNoAnswerChatterLoop,
): NodeJS.Timeout | null {
  return cfg.NO_ANSWER_CHATTER === 'on' ? start(LOOP_INTERVAL_MS) : null;
}

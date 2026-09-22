/**
 * "No answer" Chatter posts at the end of a power-dial run — the PURE half.
 *
 * The product rule, in the owner's words: "on the ones where it attempted a
 * call, at the end of the power dial session, it should post in Chatter 'no
 * answer', from the user that is power dialing" — on records they own, only.
 *
 * This file decides WHICH records of an ended run are owed a post, whether the
 * rep may post on each, and WHAT the post says. It reads nothing and writes
 * nothing: the worker (no-answer-chatter-worker.ts) hands it the run's queue
 * items and one batched ownership lookup, and acts on the answers. The ownership
 * RULE is not re-stated here — `verdictFor` only applies `callerMayCreateTaskOn`
 * (ownership.ts), the one rule every Salesforce write in this service shares.
 */
import type { DialerItem } from '../dialer/session-store.js';
import { callerMayCreateTaskOn, objectTypeForId, type OwnershipSnapshot } from './ownership.js';

/**
 * The `no_connect` outcomes that are a REAL attempt: the phone was dialed and
 * the call ran its course without the rep talking to anyone.
 *
 * `canceled` is deliberately absent. It is what Twilio reports when the rep's
 * own Stop/Skip cut a call that was still ringing — the rep chose not to wait,
 * and a deliberate skip must never manufacture activity on the record (the same
 * reasoning `skipCurrent` in dialer/engine.ts stamps-before-hangup for).
 * `connected` is not a miss at all.
 */
export const ATTEMPT_OUTCOMES = ['no_answer', 'voicemail', 'busy', 'fax', 'hangup', 'failed'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/**
 * An attempt older than this is never posted on — the second half of the
 * no-historical-backfill guard (the first is migration 0040's pre-stamp).
 *
 * Measured on the ATTEMPT, not the session. `dialer_sessions.updated_at` moves
 * on every status flip: a run paused on the 1st and stopped on the 20th (a rep
 * pressing Stop on a stale summary, an admin cleanup) has a fresh session clock
 * and 19-day-old dials. The item's `updated_at` is stamped when the attempt
 * settles (`setItem` / the miss CAS in dialer/engine.ts) and moves for nothing
 * else, so it is the only clock that says when the dial actually happened.
 */
export const SWEEP_WINDOW_MS = 24 * 60 * 60_000;

/** How each attempt outcome reads to a human in the feed. */
const OUTCOME_LABEL: Readonly<Record<AttemptOutcome, string>> = {
  no_answer: 'no answer',
  voicemail: 'voicemail',
  busy: 'busy',
  fax: 'fax machine',
  hangup: 'hung up',
  failed: 'call failed',
};

/** The only objects a post may land on. A Task run keeps an unresolvable Task
 *  as a row whose `recordId` IS the Task id; such a row can never be dialed (so
 *  never `no_connect`), but the guard is here anyway: a FeedItem on a Task — or
 *  on an object the ownership rule does not name — is never what was asked for. */
const POSTABLE_TYPES: ReadonlySet<string> = new Set(['Lead', 'Contact', 'Opportunity']);

/** The columns of a queue item this decision reads. */
export type SweepItem = Pick<
  DialerItem,
  | 'id' | 'recordId' | 'objectType' | 'status' | 'outcome' | 'attempt' | 'ordinal' | 'taskId'
  | 'noAnswerFeedItemId' | 'noAnswerSkipReason' | 'updatedAt'
>;

/** One record owed a "No answer" post, with everything the worker needs. */
export interface NoAnswerRecord {
  recordId: string;
  /** EVERY qualifying item of the record, attempt then ordinal — all of them get
   *  the same stamp, which is what makes the sweep idempotent. */
  itemIds: string[];
  /** One reason per qualifying item, same order. NOT de-duplicated. */
  reasons: AttemptOutcome[];
  /** Distinct Task ids the attempts were dialed from (Task runs); empty otherwise. */
  taskIds: string[];
}

function isAttemptOutcome(outcome: string | null): outcome is AttemptOutcome {
  return outcome != null && (ATTEMPT_OUTCOMES as readonly string[]).includes(outcome);
}

/**
 * Did this attempt settle inside the sweep window? Strict: an item at exactly
 * NOW-24h is out. Exported so the boundary is pinned on its own — it is the
 * predicate that stands between a stale dial and an irreversible post.
 */
export function attemptedWithinWindow(item: Pick<SweepItem, 'updatedAt'>, now: Date): boolean {
  return item.updatedAt.getTime() > now.getTime() - SWEEP_WINDOW_MS;
}

/** STATUS decides, then outcome: a `skipped` row can carry any text in `outcome`
 *  ('out_of_hours', a DID-skip reason…) and is never an attempt. Nor is a miss
 *  that settled outside the window — it is simply not counted, and needs no
 *  stamp: a run whose misses are all stale finishes with nothing to post. */
function isAttempt(item: SweepItem, now: Date): boolean {
  return item.status === 'no_connect' && isAttemptOutcome(item.outcome) && attemptedWithinWindow(item, now);
}

const isStamped = (item: SweepItem): boolean => item.noAnswerFeedItemId != null || item.noAnswerSkipReason != null;
/** The rep reached them: `connected` is a live talk, `done` one the rep closed with Next. */
const wasReached = (item: SweepItem): boolean => item.status === 'connected' || item.status === 'done';
const byAttemptThenOrdinal = (a: SweepItem, b: SweepItem): number =>
  (a.attempt ?? 1) - (b.attempt ?? 1) || a.ordinal - b.ordinal;

/**
 * The records of one ended run that are owed a "No answer" post.
 *
 * A record qualifies when it has at least one real attempt (see
 * `ATTEMPT_OUTCOMES`), NONE of its items reached the person (a connect on the
 * retry means the rep talked to them — "no answer" would be false), and none of
 * its attempts is already stamped. The last clause is the idempotency rule: the
 * worker stamps every qualifying item of a record at once, so any stamp means
 * the record was already handled — posted or terminally skipped — by an earlier
 * pass. Re-selecting it would post twice.
 *
 * Returned in run order (each record's first qualifying ordinal), so the worker's
 * 200-record chunks are the same on a retry as they were the first time.
 *
 * `now` bounds which misses count at all — see `SWEEP_WINDOW_MS`.
 */
export function selectNoAnswerRecords(items: ReadonlyArray<SweepItem>, now: Date): NoAnswerRecord[] {
  const byRecord = new Map<string, SweepItem[]>();
  for (const item of items) byRecord.set(item.recordId, [...(byRecord.get(item.recordId) ?? []), item]);

  const selected: Array<NoAnswerRecord & { firstOrdinal: number }> = [];
  for (const [recordId, group] of byRecord) {
    if (!POSTABLE_TYPES.has(objectTypeForId(recordId))) continue;
    if (group.some(wasReached)) continue;
    const attempts = group.filter((i) => isAttempt(i, now)).sort(byAttemptThenOrdinal);
    if (attempts.length === 0 || attempts.some(isStamped)) continue;
    selected.push({
      recordId,
      itemIds: attempts.map((a) => a.id),
      // Narrowed by `isAttempt` above; the cast only restates it for the compiler.
      reasons: attempts.map((a) => a.outcome as AttemptOutcome),
      taskIds: [...new Set(attempts.flatMap((a) => (a.taskId ? [a.taskId] : [])))],
      firstOrdinal: Math.min(...attempts.map((a) => a.ordinal)),
    });
  }
  return selected
    .sort((a, b) => a.firstOrdinal - b.firstOrdinal)
    .map(({ firstOrdinal: _firstOrdinal, ...record }) => record);
}

/**
 * Every id the ownership gate must pass for this record. A Task run dials a
 * PERSON off a TASK, and "tasks that they own" is part of the rule — so the
 * Task's assignee is gated as well as the record's owner, exactly as
 * `mayCreateTaskOn([recordId, taskId], …)` would.
 */
export function gateIdsFor(record: NoAnswerRecord): string[] {
  return [record.recordId, ...record.taskIds];
}

/** What the sweep does with one record. The two skips are TERMINAL — they are
 *  stamped as `no_answer_skip_reason` and never looked at again. */
export type SweepVerdict = 'post' | 'not-owner' | 'not-found';

/**
 * "Only the ones that they own." Applies the shared rule to every id the record
 * is gated on; the first id that fails decides.
 *
 * `owners` is one batched lookup for the whole run (`fetchOwnershipBatch`). An id
 * ABSENT from it was not returned by Salesforce — deleted, or the rep cannot
 * read it — and an unverifiable record is never posted on: `not-found`, not a
 * benefit of the doubt. (A lookup that FAILED never gets this far: it throws,
 * and the worker retries the whole session.)
 */
export function verdictFor(
  record: NoAnswerRecord,
  owners: ReadonlyMap<string, OwnershipSnapshot>,
  callerSfUserId: string,
): SweepVerdict {
  for (const id of gateIdsFor(record)) {
    const snapshot = owners.get(id);
    if (!snapshot) return 'not-found';
    if (!callerMayCreateTaskOn(snapshot, callerSfUserId)) return 'not-owner';
  }
  return 'post';
}

/**
 * The post body. Exact format — reps and managers will read thousands of these:
 *   No answer (Power Dialer) — 1 attempt: voicemail
 *   No answer (Power Dialer) — 2 attempts: no answer, voicemail
 * The dash is an em dash (U+2014).
 */
export function noAnswerText(reasons: ReadonlyArray<AttemptOutcome>): string {
  const n = reasons.length;
  return `No answer (Power Dialer) — ${n} ${n === 1 ? 'attempt' : 'attempts'}: ${reasons.map((r) => OUTCOME_LABEL[r]).join(', ')}`;
}

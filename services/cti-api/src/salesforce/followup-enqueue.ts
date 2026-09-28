import type { RolloverEnqueue } from '../dialer/engine.js';
import { getDb, schema } from '@cti/db';

/** The subset of the DB surface `enqueueFollowupRollover` needs — satisfied by
 *  both a plain `getDb()` handle and a `PgTransaction`, so the engine's
 *  miss-path CAS (dialer/engine.ts `handleDialOutcome`) can enqueue the
 *  rollover job INSIDE its transaction instead of after it. */
export type RolloverDb = Pick<ReturnType<typeof getDb>, 'insert'>;

/** The insert itself, returned unawaited so its rendered SQL is pinned
 *  (followup-enqueue.test.ts). A BARE `onConflictDoNothing()` on purpose —
 *  see `enqueueFollowupRollover` for the key it relies on; naming a target is
 *  the partial-index trap (42P10) the house rules forbid. */
export function rolloverJobInsert(db: RolloverDb, job: RolloverEnqueue) {
  return db.insert(schema.followupRolloverJobs).values({ ...job, status: 'pending' }).onConflictDoNothing();
}

/** Idempotent: a duplicated webhook's second enqueue is a no-op — the conflict
 *  is on `followup_rollover_unique`, UNIQUE(user_id, record_id, from_date).
 *  That key is also the product rule: ONE rollover per person per day. On a Task
 *  run two follow-up tasks for the SAME person both miss and both call this, and
 *  this single INSERT ... ON CONFLICT DO NOTHING collapses them into ONE job —
 *  the FIRST miss's `sourceTaskId` (and `businessDays`) wins and names the
 *  template the copy is made from. That is intended, not a dropped write: the
 *  worker completes EVERY same-day follow-up on that person and creates exactly
 *  one copy, so the rep gets one item instead of a pile.
 *
 *  Runs INSIDE the engine's row-locked transaction (dialer/engine.ts
 *  `handleDialOutcome`), so this MUST stay a single local INSERT — no network
 *  I/O, no retries, no extra queries; anything slower here stalls the rep's
 *  dialing run. */
export async function enqueueFollowupRollover(db: RolloverDb, job: RolloverEnqueue): Promise<void> {
  await rolloverJobInsert(db, job);
}

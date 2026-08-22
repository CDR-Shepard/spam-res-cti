import type { RolloverEnqueue } from '../dialer/engine.js';
import { getDb, schema } from '../db/index.js';

/** The subset of the DB surface `enqueueFollowupRollover` needs — satisfied by
 *  both a plain `getDb()` handle and a `PgTransaction`, so the engine's
 *  miss-path CAS (dialer/engine.ts `handleDialOutcome`) can enqueue the
 *  rollover job INSIDE its transaction instead of after it. */
export type RolloverDb = Pick<ReturnType<typeof getDb>, 'insert'>;

/** Idempotent: a duplicated webhook's second enqueue is a no-op — the conflict
 *  target is `followup_rollover_source_unique`, UNIQUE(user_id,
 *  COALESCE(source_task_id, record_id), from_date), so on a Task run two
 *  follow-up tasks for the SAME person still enqueue two distinct jobs. Runs INSIDE
 *  the engine's row-locked transaction (dialer/engine.ts `handleDialOutcome`),
 *  so this MUST stay a single local INSERT ... ON CONFLICT DO NOTHING — no
 *  network I/O, no retries, no extra queries; anything slower here stalls the
 *  rep's dialing run. */
export async function enqueueFollowupRollover(db: RolloverDb, job: RolloverEnqueue): Promise<void> {
  await db.insert(schema.followupRolloverJobs).values({ ...job, status: 'pending' }).onConflictDoNothing();
}

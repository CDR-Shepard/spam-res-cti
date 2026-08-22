import type { RolloverEnqueue } from '../dialer/engine.js';
import { getDb, schema } from '../db/index.js';

/** Idempotent: a duplicated webhook's second enqueue is a no-op. */
export async function enqueueFollowupRollover(db: ReturnType<typeof getDb>, job: RolloverEnqueue): Promise<void> {
  await db.insert(schema.followupRolloverJobs).values({ ...job, status: 'pending' }).onConflictDoNothing();
}

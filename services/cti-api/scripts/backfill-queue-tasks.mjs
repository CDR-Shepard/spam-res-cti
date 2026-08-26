#!/usr/bin/env node
/**
 * Backfill: re-queue Salesforce Task sync for calls the OLD ownership gate
 * blocked because their record was queue-owned (OwnerId prefix `00G` — a
 * Salesforce Group id, e.g. the LA/SD Hunt Queue). Ruling 2026-08-26 now
 * allows those (see src/salesforce/ownership.ts). This script does NOT
 * re-decide ownership itself — it just re-queues the sync so syncOne's gate
 * (src/salesforce/sync.ts), which now has the new rule, gets a chance to run
 * again. A call still blocked by a DIFFERENT rep's ownership stays blocked:
 * the gate re-checks on every reprocess and returns `{ skipped: 'not-owner' }`
 * exactly as before.
 *
 * Every call this script targets already has a `salesforce_sync_jobs` row
 * with status='succeeded' — the old gate's skip was recorded as a SUCCESSFUL
 * no-op (lastError='not-owner'; see `syncJobLastError` in sync.ts), not a
 * failure, so nothing was ever going to retry it on its own.
 *
 * Why resetting the row to 'pending' is enough (read runSyncTick before
 * changing this): the tick selects jobs with
 * `status = 'pending' AND next_attempt_at <= now()`, LIMIT 10, and the
 * production loop (startSyncLoop) ticks every 5s — so a job set back to
 * 'pending' with `next_attempt_at = now()` is picked up on one of the next
 * few ticks with no other state to touch. The two sweeps that also run at
 * the top of every tick do not interfere: reapStuckJobs only touches
 * 'in_flight' jobs, and sweepUnloggedCalls only touches calls with a NULL
 * disposition (every candidate here already has one).
 *
 * Usage:
 *   node scripts/backfill-queue-tasks.mjs           # dry run: prints the plan
 *   node scripts/backfill-queue-tasks.mjs --apply   # writes: resets rows to pending
 *
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL — the CTI Postgres database.
 *
 * NOT executed as part of this change. The controller runs --apply post-deploy.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DB_URL) {
  console.error('no DB url (set DATABASE_URL or DATABASE_PUBLIC_URL)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  // Candidates: dispositioned, no Task yet, has a record to attach a Task to,
  // and recent — this backfill covers the cutover window, not a full
  // historical replay (an old skip is presumed already acted on some other
  // way by now).
  const { rows: calls } = await client.query(`
    select id, disposition, salesforce_who_id, salesforce_what_id, created_at
    from calls
    where disposition is not null
      and salesforce_task_id is null
      and (salesforce_who_id is not null or salesforce_what_id is not null)
      and created_at > now() - interval '24 hours'
    order by created_at
  `);

  console.log(`${calls.length} candidate call(s) from the last 24h.`);

  let reset = 0;
  let missingJob = 0;
  let notSucceeded = 0;

  for (const call of calls) {
    const { rows: jobs } = await client.query(
      'select id, status from salesforce_sync_jobs where call_id = $1',
      [call.id],
    );
    const job = jobs[0];
    if (!job) {
      missingJob++;
      console.log(`SKIP  ${call.id}  no salesforce_sync_jobs row found (unexpected — investigate before re-running)`);
      continue;
    }
    if (job.status !== 'succeeded') {
      notSucceeded++;
      console.log(
        `SKIP  ${call.id}  job ${job.id} status=${job.status} (not the succeeded-skip case this backfill targets)`,
      );
      continue;
    }
    console.log(
      `${APPLY ? 'RESET' : 'PLAN '} ${call.id}  job ${job.id}  disposition="${call.disposition}"` +
        `  who=${call.salesforce_who_id ?? '(none)'}  what=${call.salesforce_what_id ?? '(none)'}`,
    );
    if (APPLY) {
      await client.query(
        "update salesforce_sync_jobs set status = 'pending', next_attempt_at = now(), updated_at = now() where id = $1",
        [job.id],
      );
    }
    reset++;
  }

  console.log('');
  console.log(
    `candidates: ${calls.length}  ${APPLY ? 'reset' : 'to reset'}: ${reset}` +
      `  missing job: ${missingJob}  not succeeded: ${notSucceeded}`,
  );
  if (!APPLY) console.log('DRY RUN — re-run with --apply to write.');
} finally {
  await client.end();
}

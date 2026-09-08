#!/usr/bin/env node
/**
 * Replay salesforce_sync_jobs stuck on a converted-lead match
 * (CANNOT_UPDATE_CONVERTED_LEAD). See the converted-lead-fix brief:
 * findByPhone used to return a converted Lead ahead of the live Contact
 * (both carry the same phone after a Salesforce conversion), so the sync
 * job's Task write was rejected by Salesforce and the job retried forever
 * (or landed 'failed' after MAX_ATTEMPTS).
 *
 * Re-running syncOne alone does NOT fix these jobs — sync.ts:334 only calls
 * findByPhone when the call has NEITHER a stored who nor what id, and these
 * calls already have the dead Lead id stored in calls.salesforce_who_id.
 * This script clears that stale id (ONLY when it still starts with '00Q',
 * the Lead id prefix — every other value is left untouched) and resets the
 * job to 'pending' so the next sync tick re-runs findByPhone, which (after
 * the fix in salesforce/client.ts) now excludes converted leads and prefers
 * the Contact.
 *
 * For each matching job, in ONE transaction:
 *   1. calls.salesforce_who_id -> null (only if it currently starts with '00Q')
 *   2. salesforce_sync_jobs -> status='pending', attempts=0, last_error=null,
 *      next_attempt_at=now(), updated_at=now()
 *
 * Idempotent: once a job is reset its last_error is null, so it no longer
 * matches this script's selection filter on a later run — re-running is a
 * harmless no-op for already-repaired jobs.
 *
 * IMPORTANT-3 (fix wave): a selected row's `salesforce_who_id` is not always
 * the stale Lead id — a row can already carry a non-null
 * `salesforce_what_id` (e.g. a Deal__c match from before the conversion), in
 * which case the reset attaches the replayed Task to that What WITHOUT
 * restoring a Who (person) link, because sync.ts only re-runs findByPhone
 * when BOTH ids are empty. The dry run now joins `calls` and reports THREE
 * groups so an operator can see this before choosing --apply:
 *   - fullyReMatch: who is the stale Lead id, what is empty — a clean re-match.
 *   - attachWithoutPersonLink: who is the stale Lead id, what is already set
 *     — the Task still lands (a Task on the deal beats no Task), but the
 *     person link for that call is permanently gone.
 *   - guardExcluded: who is not a Lead id at all — the clear-who guard above
 *     will not touch it, so resetting the job changes nothing.
 *
 * Usage:
 *   node scripts/replay-converted-lead-jobs.mjs           # dry run (default)
 *   node scripts/replay-converted-lead-jobs.mjs --apply   # writes the resets
 *
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL — the CTI Postgres database.
 * Never run this against production without reviewing the dry-run plan first.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/**
 * Stuck sync jobs, joined to `calls` so an operator can see whether a reset
 * will fully re-match a person, attach to an existing What without a person
 * link, or do nothing at all (see the module doc comment, IMPORTANT-3). The
 * original version of this query never joined `calls`, so the dry run could
 * not reveal any of this before an operator ran --apply.
 */
export const SELECT_STUCK_JOBS_SQL = `select j.id, j.call_id, j.status, c.salesforce_who_id, c.salesforce_what_id
   from salesforce_sync_jobs j
   join calls c on c.id = j.call_id
  where j.last_error like '%CONVERTED_LEAD%'
    and j.status in ('failed', 'pending')
  order by j.call_id`;

/**
 * Clears a stale Lead id. Guard unchanged from the original script: only a
 * '00Q'-prefixed id is nulled, so this can never clobber a Contact,
 * Opportunity, or Deal__c id — or an id set by some other path.
 */
export const CLEAR_STALE_LEAD_WHO_SQL = `update calls set salesforce_who_id = null
    where id = $1 and salesforce_who_id like '00Q%'`;

/**
 * Resets one job to pending for replay.
 *
 * MINOR-6: re-guarded with the same predicate used to select the job
 * (last_error / status) so a job a concurrent tick already carried to
 * 'succeeded' between the SELECT above and this UPDATE cannot be flipped
 * back to 'pending' underneath it. Also stamps `updated_at = now()`, per the
 * schema comment on salesforceSyncJobs (packages/db/src/schema.ts) — a job's
 * `updatedAt` is what the sync worker uses to detect (and reap) an orphaned
 * 'in_flight' tick, so a reset that skips it looks stale to that check.
 */
export const RESET_JOB_SQL = `update salesforce_sync_jobs
    set status = 'pending', attempts = 0, last_error = null, next_attempt_at = now(), updated_at = now()
  where id = $1
    and last_error like '%CONVERTED_LEAD%'
    and status in ('failed', 'pending')`;

/**
 * Splits the stuck-job rows (as returned by SELECT_STUCK_JOBS_SQL — snake_case
 * `salesforce_who_id` / `salesforce_what_id`) into the three groups described
 * in the module doc comment (IMPORTANT-3). Pure and DB-free so it is directly
 * unit-testable.
 */
export function classifyJobs(jobs) {
  const fullyReMatch = [];
  const attachWithoutPersonLink = [];
  const guardExcluded = [];
  for (const job of jobs) {
    const who = job.salesforce_who_id;
    const isStaleLead = typeof who === 'string' && who.startsWith('00Q');
    if (!isStaleLead) {
      guardExcluded.push(job);
    } else if (job.salesforce_what_id == null) {
      fullyReMatch.push(job);
    } else {
      attachWithoutPersonLink.push(job);
    }
  }
  return { fullyReMatch, attachWithoutPersonLink, guardExcluded };
}

/**
 * ROLLBACK in its own try/catch (MINOR-6). Without this, a connection that
 * drops mid-batch throws OUT of the ROLLBACK call itself and aborts the
 * whole batch loop, not just the one row that failed — every job after the
 * dropped connection would be silently skipped rather than reported.
 */
export async function safeRollback(client) {
  try {
    await client.query('ROLLBACK');
  } catch (err) {
    console.error(`  rollback failed: ${err.message}`);
  }
}

function printSample(label, rows) {
  if (rows.length === 0) return;
  console.log(`\n${label} (up to 10):`);
  for (const row of rows.slice(0, 10)) {
    console.log(
      `  ${row.call_id} (job ${row.id}, status=${row.status}) who=${row.salesforce_who_id ?? 'null'} what=${row.salesforce_what_id ?? 'null'}`,
    );
  }
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
  if (!DB_URL) {
    console.error('no DB url (set DATABASE_URL or DATABASE_PUBLIC_URL)');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const { rows: jobs } = await client.query(SELECT_STUCK_JOBS_SQL);

    console.log(`${jobs.length} sync job(s) stuck on a converted-lead match.`);
    if (jobs.length === 0) return;

    const { fullyReMatch, attachWithoutPersonLink, guardExcluded } = classifyJobs(jobs);
    console.log(`  ${fullyReMatch.length} will fully re-match (who is the stale Lead id, what is empty).`);
    console.log(
      `  ${attachWithoutPersonLink.length} will attach to an existing What WITHOUT a person link ` +
        `(who is the stale Lead id, what is already set) — a Task on the deal beats no Task, but the person link is lost.`,
    );
    console.log(
      `  ${guardExcluded.length} excluded entirely by the '00Q%' guard (who is not a Lead id) — resetting will not change salesforce_who_id.`,
    );
    printSample('Fully re-match', fullyReMatch);
    printSample('Attach-without-person-link', attachWithoutPersonLink);
    printSample('Guard-excluded (reset would be a no-op on salesforce_who_id)', guardExcluded);

    if (!APPLY) {
      console.log('\nDRY RUN — re-run with --apply to reset these jobs for replay.');
      return;
    }

    let reset = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await client.query('BEGIN');
        await client.query(CLEAR_STALE_LEAD_WHO_SQL, [job.call_id]);
        await client.query(RESET_JOB_SQL, [job.id]);
        await client.query('COMMIT');
        reset++;
      } catch (err) {
        await safeRollback(client);
        failed++;
        console.error(`  failed to reset job ${job.id} (call ${job.call_id}): ${err.message}`);
      }
    }
    console.log(`\nReset ${reset}/${jobs.length} job(s) to pending for replay${failed ? `, ${failed} failed` : ''}.`);
  } finally {
    await client.end();
  }
}

// Only run against a real database when this file is executed directly
// (`node scripts/replay-converted-lead-jobs.mjs`) — never on import, so the
// pure helpers above can be unit-tested without DATABASE_URL or a live DB.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

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
 *      next_attempt_at=now()
 *
 * Idempotent: once a job is reset its last_error is null, so it no longer
 * matches this script's selection filter on a later run — re-running is a
 * harmless no-op for already-repaired jobs.
 *
 * Usage:
 *   node scripts/replay-converted-lead-jobs.mjs           # dry run (default)
 *   node scripts/replay-converted-lead-jobs.mjs --apply   # writes the resets
 *
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL — the CTI Postgres database.
 * Never run this against production without reviewing the dry-run plan first.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!DB_URL) {
  console.error('no DB url (set DATABASE_URL or DATABASE_PUBLIC_URL)');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const { rows: jobs } = await client.query(
    `select j.id, j.call_id, j.status
       from salesforce_sync_jobs j
      where j.last_error like '%CONVERTED_LEAD%'
        and j.status in ('failed', 'pending')
      order by j.call_id`,
  );

  console.log(`${jobs.length} sync job(s) stuck on a converted-lead match.`);
  if (jobs.length === 0) process.exit(0);

  console.log('Sample call ids (up to 10):');
  for (const job of jobs.slice(0, 10)) {
    console.log(`  ${job.call_id} (job ${job.id}, status=${job.status})`);
  }

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to reset these jobs for replay.');
    process.exit(0);
  }

  let reset = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await client.query('BEGIN');
      // Guard: only clear a stale LEAD id ('00Q' prefix). Never clobbers a
      // Contact/Opportunity/Deal__c id or an id set by some other path.
      await client.query(
        `update calls set salesforce_who_id = null
          where id = $1 and salesforce_who_id like '00Q%'`,
        [job.call_id],
      );
      await client.query(
        `update salesforce_sync_jobs
            set status = 'pending', attempts = 0, last_error = null, next_attempt_at = now()
          where id = $1`,
        [job.id],
      );
      await client.query('COMMIT');
      reset++;
    } catch (err) {
      await client.query('ROLLBACK');
      failed++;
      console.error(`  failed to reset job ${job.id} (call ${job.call_id}): ${err.message}`);
    }
  }
  console.log(`\nReset ${reset}/${jobs.length} job(s) to pending for replay${failed ? `, ${failed} failed` : ''}.`);
} finally {
  await client.end();
}

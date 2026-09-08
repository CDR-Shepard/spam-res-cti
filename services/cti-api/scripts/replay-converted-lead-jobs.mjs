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
 * IMPORTANT-1 (fix wave 2): a job selected as `pending`/`failed` can be
 * claimed by a concurrent `runSyncTick` (flipped to `in_flight`, then parked
 * `failed` again) between this script's SELECT and its own transaction.
 * `replayOneJob` checks `RESET_JOB_SQL`'s rowCount and rolls back (never
 * commits a half-repair) when that happens, reporting the row as `skipped`
 * rather than `reset` — re-run the script to pick a skipped job back up.
 * `--apply` also prints one audit line per row it actually resets (the old
 * `salesforce_who_id` it destroyed), since this is a live production write.
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
    } else if (!job.salesforce_what_id) {
      // MINOR-3 (fix wave 2): falsiness, not `== null` — matches sync.ts:339's
      // own runtime predicate (`if (!whoId && !whatId)`) exactly, so the
      // operator's dry-run breakdown never disagrees with what the sync
      // worker will actually do with the same row (e.g. an empty-string what
      // id classifies as "fully re-match" here exactly as it would there).
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

/**
 * Repairs ONE stuck job inside its own transaction: clears the stale Lead
 * who-id, then resets the job to pending for replay. Returns which of the
 * two real outcomes happened so `main()`'s summary line can never be a
 * fabricated success (IMPORTANT-1, fix wave 2).
 *
 * Live race this closes: this script SELECTs job J as `pending`; before this
 * transaction runs, a concurrent `runSyncTick` (sync.ts) claims J and flips
 * it to `in_flight`. The `calls` clear (first statement below) would still
 * apply — it targets `calls`, not the job — but `RESET_JOB_SQL`'s own
 * `status in ('failed','pending')` re-guard now matches ZERO rows, because
 * the job is `in_flight`. The OLD script never checked that `rowCount` and
 * committed anyway: the call ends up half-repaired (its stale who cleared)
 * while its job is never reset, so the in-flight `syncOne` re-reads the
 * (now-null) who, still can't produce a Task the way the operator expects,
 * and — once attempts exhaust — parks in `failed` forever, a status
 * `runSyncTick` never re-selects. The operator sees `reset++` regardless:
 * exactly the silent-success pattern this whole change exists to remove,
 * reintroduced in the remediation tool.
 *
 * Fix: check `RESET_JOB_SQL`'s rowCount. Zero rows → roll back (undoing the
 * `calls` clear too, so nothing is left half-applied) and report 'skipped'
 * so the operator knows to re-run — the row still matches
 * SELECT_STUCK_JOBS_SQL next time (its last_error/status are untouched by a
 * rolled-back transaction) and picks up the ambient IN_FLIGHT/pending state
 * cleanly then.
 *
 * Lock order is deliberately calls-then-jobs, matching `syncOne`'s own write
 * order at sync.ts:432-449 — no new deadlock edge between this script and
 * the live sync worker.
 */
export async function replayOneJob(client, job) {
  await client.query('BEGIN');
  await client.query(CLEAR_STALE_LEAD_WHO_SQL, [job.call_id]);
  const r = await client.query(RESET_JOB_SQL, [job.id]);
  if (r.rowCount === 0) {
    await safeRollback(client);
    return { status: 'skipped' };
  }
  await client.query('COMMIT');
  return { status: 'reset' };
}

/**
 * MINOR-4 (fix wave 2): one auditable line per row actually repaired by
 * --apply. This script mutates the live production database, and the value
 * it destroys (a dead converted-Lead pointer) should leave a record of what
 * changed and for which job/call. Returns null — nothing to print — for a
 * row the clear-who guard never touched (its `salesforce_who_id` didn't
 * start with '00Q'): `CLEAR_STALE_LEAD_WHO_SQL`'s own guard is a no-op there,
 * so nothing was actually destroyed.
 */
export function auditLine(job) {
  const who = job.salesforce_who_id;
  if (typeof who !== 'string' || !who.startsWith('00Q')) return null;
  return `  job ${job.id} call ${job.call_id} who=${who} → null`;
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
    let skipped = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        const result = await replayOneJob(client, job);
        if (result.status === 'skipped') {
          skipped++;
          console.warn(
            `  skipped job ${job.id} (call ${job.call_id}): status changed since the SELECT — re-run to pick it up`,
          );
          continue;
        }
        reset++;
        const line = auditLine(job);
        if (line) console.log(line);
      } catch (err) {
        await safeRollback(client);
        failed++;
        console.error(`  failed to reset job ${job.id} (call ${job.call_id}): ${err.message}`);
      }
    }
    console.log(
      `\nReset ${reset}/${jobs.length} job(s) to pending for replay` +
        (skipped ? `, ${skipped} skipped (status changed since the SELECT — re-run to pick them up)` : '') +
        (failed ? `, ${failed} failed` : '') +
        `.`,
    );
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

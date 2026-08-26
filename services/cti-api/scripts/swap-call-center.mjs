/**
 * Swap every CTI rep's Salesforce Call Center to Caller Reputation CTI.
 * Roster is DERIVED from the CTI users table (never hardcoded), matched to
 * SF Users by Email (usernames are 2-suffixed for several reps — match on
 * the Email FIELD, not Username). Idempotent: re-runs are no-ops.
 *
 * Usage:
 *   node scripts/swap-call-center.mjs             # dry run: prints the plan
 *   node scripts/swap-call-center.mjs --apply     # writes; records rollback json
 *   node scripts/swap-call-center.mjs --rollback swap-rollback-<ts>.json
 *
 * Env: DATABASE_URL (public), SF_ORG (default "_t2" = PRODUCTION).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import pg from 'pg';

const ORG = process.env.SF_ORG ?? '_t2';
const APPLY = process.argv.includes('--apply');
const ROLLBACK = process.argv.indexOf('--rollback');

function soql(q) {
  const out = execFileSync('sf', ['data', 'query', '-o', ORG, '-q', q, '--json'], { encoding: 'utf8' });
  return JSON.parse(out).result.records;
}
function sfUpdate(id, callCenterId) {
  execFileSync('sf', [
    'data', 'update', 'record', '-o', ORG, '-s', 'User', '-i', id,
    '-v', `CallCenterId='${callCenterId ?? ''}'`, '--json',
  ], { encoding: 'utf8' });
}

if (ROLLBACK !== -1) {
  const file = process.argv[ROLLBACK + 1];
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  for (const row of saved) {
    sfUpdate(row.sfId, row.previousCallCenterId);
    console.log(`rolled back ${row.email} -> ${row.previousCallCenterId ?? '(none)'}`);
  }
  process.exit(0);
}

const [target] = soql("SELECT Id, InternalName FROM CallCenter WHERE InternalName = 'CallerReputationCTI'");
if (!target) throw new Error('CallerReputationCTI call center not found in org');

const c = new pg.Client({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
const { rows: ctiUsers } = await c.query('select email from users order by email');
await c.end();

const emails = ctiUsers.map((u) => u.email.toLowerCase());
const inList = emails.map((e) => `'${e.replace(/'/g, "\\'")}'`).join(',');
const sfUsers = soql(`SELECT Id, Email, Name, CallCenterId FROM User WHERE IsActive = true AND Email IN (${inList})`);

const missing = emails.filter((e) => !sfUsers.some((u) => u.Email?.toLowerCase() === e));
if (missing.length) console.log(`no active SF user for: ${missing.join(', ')}`);

const plan = sfUsers.map((u) => ({
  sfId: u.Id, email: u.Email, name: u.Name,
  previousCallCenterId: u.CallCenterId ?? null,
  alreadyDone: u.CallCenterId === target.Id,
}));
for (const p of plan) {
  console.log(`${p.alreadyDone ? 'ok    ' : 'swap  '} ${p.name} <${p.email}>`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — ${plan.filter((p) => !p.alreadyDone).length} to change. Re-run with --apply.`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`swap-rollback-${stamp}.json`, JSON.stringify(plan, null, 2));
for (const p of plan.filter((x) => !x.alreadyDone)) {
  sfUpdate(p.sfId, target.Id);
  console.log(`swapped ${p.email}`);
}
const verify = soql(`SELECT Email, CallCenterId FROM User WHERE IsActive = true AND Email IN (${inList})`);
const bad = verify.filter((u) => u.CallCenterId !== target.Id);
console.log(bad.length ? `VERIFY FAILED for: ${bad.map((u) => u.Email).join(', ')}` : `VERIFIED: all ${verify.length} users on CallerReputationCTI`);

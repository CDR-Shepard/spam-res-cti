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
const API_VERSION = 'v61.0';

function soql(q) {
  const out = execFileSync('sf', ['data', 'query', '-o', ORG, '-q', q, '--json'], { encoding: 'utf8' });
  return JSON.parse(out).result.records;
}

// REST PATCH, not `sf data update record`: that command's `-v "Field=''"`
// syntax cannot express null for a lookup field, so a rollback of a rep
// whose previousCallCenterId was null (never on any CTI) would crash
// mid-loop. A JSON body expresses null natively, so this one path is used
// uniformly for both the --apply swap and the --rollback restore. Args are
// passed as an execFileSync array (no shell), so the JSON body needs no
// shell-escaping regardless of what it contains.
function sfUpdate(id, callCenterId) {
  const body = JSON.stringify({ CallCenterId: callCenterId ?? null });
  execFileSync('sf', [
    'api', 'request', 'rest', `/services/data/${API_VERSION}/sobjects/User/${id}`,
    '-X', 'PATCH', '-b', body, '-o', ORG,
  ], { encoding: 'utf8' });
}

if (ROLLBACK !== -1) {
  const file = process.argv[ROLLBACK + 1];
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const failures = [];
  for (const row of saved) {
    try {
      sfUpdate(row.sfId, row.previousCallCenterId);
      console.log(`rolled back ${row.email} -> ${row.previousCallCenterId ?? '(none)'}`);
    } catch (err) {
      failures.push({ email: row.email, sfId: row.sfId, error: err.message });
      console.error(`FAILED to roll back ${row.email} (${row.sfId}): ${err.message}`);
    }
  }
  if (failures.length) {
    console.error(`\nROLLBACK INCOMPLETE — ${failures.length} of ${saved.length} row(s) failed:`);
    for (const f of failures) console.error(`  ${f.email} (${f.sfId}): ${f.error}`);
    process.exit(1);
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

// Flag any email matched by more than one active SF user (e.g. a shared
// service/integration account) before the plan summary, in both dry-run and
// --apply — an --apply run would otherwise silently repoint every matching
// user's CallCenterId, including ones an operator didn't mean to touch.
const byEmail = new Map();
for (const u of sfUsers) {
  const key = u.Email?.toLowerCase();
  if (!key) continue;
  if (!byEmail.has(key)) byEmail.set(key, []);
  byEmail.get(key).push(u);
}
for (const [email, users] of byEmail) {
  if (users.length > 1) {
    console.log(`DUPLICATE EMAIL: ${email} matched ${users.length} users (${users.map((u) => u.Name).join(', ')})`);
  }
}

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

#!/usr/bin/env node
/**
 * One-shot inbound-team onboarding (roster of 2026-08-25, from Evren):
 * creates the CTI user row for each rep (adopted automatically at their first
 * Salesforce login — the login flow matches on email) and assigns 6 LA + 6 SD
 * from the unassigned agent reserve, labeling each number with the rep's name.
 * Idempotent: existing users are kept; assign only tops up to 6/6.
 *
 *   cd services/cti-api && PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-) \
 *     && env DATABASE_URL="$PUB" node scripts/onboard-inbound-reps.mjs
 *
 * Matt Cook + Tyler Lizola already hold their 12 (skipped here). The
 * Skip_On_Dialer permission set was granted to all 12 on 2026-08-25.
 */
import pg from 'pg';
import { execFileSync } from 'node:child_process';

const REPS = [
  ['danny@rethinkreteam.com', 'Danny Arredondo'],
  ['deivid@rethinkreteam.com', 'Deivid Lopez'],
  ['edward@rethinkreteam.com', 'Edward Jerome Maglalang'],
  ['garrettmartorello@gmail.com', 'Garrett Martorello'],
  ['jordyn@rethinkreteam.com', 'Jordyn Freedman'],
  ['matt@rethinkreteam.com', 'Matt Penrod'],
  ['norahnazzaro@gmail.com', 'Norah Nazzaro'],
  ['sam@rethinkreteam.com', 'Samuel Elwood'],
  ['greensethb@gmail.com', 'Seth Boisvert'],
  ['thomas@rethinkreteam.com', 'Thomas Wilkinson'],
];

const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const org = (await c.query("select id from organizations where sf_org_id = '00D5f000005w2kWEAQ'")).rows[0];
if (!org) { console.error('ERROR: org row not found'); process.exit(1); }
for (const [email, name] of REPS) {
  const r = await c.query(
    `insert into users (org_id, email, display_name, is_admin)
     select $1, $2, $3, false where not exists (select 1 from users where email = $2) returning id`,
    [org.id, email, name],
  );
  console.log(r.rowCount ? `created ${email} (${name})` : `exists  ${email}`);
}
await c.end();

for (const [email] of REPS) {
  const out = execFileSync('npx', ['tsx', 'scripts/buy-agent-numbers.ts', 'assign', '--email', email], {
    env: process.env, encoding: 'utf8',
  });
  const n = (out.match(/^ASSIGNED /gm) ?? []).length;
  const warn = out.split('\n').filter((l) => l.startsWith('WARN')).join('; ');
  console.log(`${email}: ${n} assigned${warn ? ` — ${warn}` : ''}`);
}
console.log('\nDone. Acceptance: railway run -s @cti/api -- env DATABASE_URL="$DATABASE_URL" npx tsx scripts/fleet-report.ts');

#!/usr/bin/env node
/**
 * Fairly distribute the CLEAN free reserve ('Agent Reserve *', unassigned,
 * active, health not spam_likely/degraded) across reps, lowest-usable-first —
 * the same round-robin as redistribute-pool.mjs but drawing from the reserve.
 * Use when the reserve is too small to top every thin rep to target via
 * `buy-agent-numbers.ts assign` (which gives one rep their full top-up and can
 * starve the rest).
 *
 * Usage:
 *   node scripts/assign-reserve-fair.mjs           # dry run
 *   node scripts/assign-reserve-fair.mjs --apply   # writes assignments
 *
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!DB_URL) { console.error('no DB url'); process.exit(1); }

const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const reserve = (
    await client.query(
      `select id, e164, substring(e164 from 3 for 3) as ac from outbound_numbers
       where kind = 'agent' and assigned_user_id is null and active
         and health not in ('spam_likely','degraded') and label like 'Agent Reserve%'
       order by e164`,
    )
  ).rows;
  if (reserve.length === 0) { console.log('clean reserve is empty.'); process.exit(0); }

  const reps = (
    await client.query(
      `select u.id, u.email,
         count(n.id) filter (where n.active and n.health not in ('spam_likely','degraded'))::int as usable
       from users u left join outbound_numbers n on n.assigned_user_id = u.id
       where u.email != 'dev@example.com'
       group by u.id, u.email`,
    )
  ).rows.map((r) => ({ ...r, usable: Number(r.usable) }));

  for (const num of reserve) {
    reps.sort((a, b) => a.usable - b.usable || a.email.localeCompare(b.email));
    const rep = reps[0];
    const tag = rep.email.split('@')[0];
    const label = `Agent ${tag} ${num.ac === '213' || num.ac === '323' ? 'LA' : 'SD'}`;
    console.log(`${APPLY ? 'ASSIGN' : 'PLAN  '} ${num.e164} -> ${rep.email} [${label}]`);
    if (APPLY) {
      await client.query(
        `update outbound_numbers set assigned_user_id = $1, label = $2
         where id = $3 and assigned_user_id is null`,
        [rep.id, label, num.id],
      );
    }
    rep.usable++;
  }

  reps.sort((a, b) => a.usable - b.usable || a.email.localeCompare(b.email));
  console.log(`\n${APPLY ? 'RESULT' : 'PROJECTED'} usable per rep:`);
  for (const r of reps) console.log(`  ${r.email}: ${r.usable}`);
  if (!APPLY) console.log('\nDRY RUN — re-run with --apply to write.');
} finally {
  await client.end();
}

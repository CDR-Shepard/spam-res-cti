#!/usr/bin/env node
/**
 * Redistribute the idle dialer pool's CLEAN numbers to the reps with the
 * thinnest usable rotations (ruling 2026-08-26: power dialing is disabled for
 * everyone, so the pool sits unused while reps starve for clean caller IDs).
 *
 * For each active dialer_pool number whose health is not spam_likely/degraded,
 * assign it to the rep with the FEWEST usable numbers at that moment
 * (ties broken by email), converting kind → 'agent' and labeling
 * "Agent <tag> SD" (619) / "Agent <tag> <area>" otherwise. Repeats until the
 * clean pool is empty — the classic lowest-first round-robin, so the final
 * distribution levels everyone as evenly as the count allows.
 *
 * Spam-flagged pool numbers are NOT touched (they stay parked in the pool for
 * NV remediation). The test DID +12054303297 is never dialer_pool kind, so it
 * cannot be drawn here. After this runs the pool has no usable numbers left:
 * re-buy the pool (buy-agent-numbers.ts buy-pool) before re-enabling power
 * dialing for anyone.
 *
 * Usage:
 *   node scripts/redistribute-pool.mjs           # dry run: prints the plan
 *   node scripts/redistribute-pool.mjs --apply   # writes the assignments
 *
 * Env: DATABASE_URL or DATABASE_PUBLIC_URL — the CTI Postgres database.
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
  const pool = (
    await client.query(
      `select id, e164, health, substring(e164 from 3 for 3) as ac from outbound_numbers
       where kind = 'dialer_pool' and active and health not in ('spam_likely','degraded')
       order by case health when 'healthy' then 0 else 1 end, e164`,
    )
  ).rows;
  if (pool.length === 0) {
    console.log('no clean dialer_pool numbers to redistribute.');
    process.exit(0);
  }

  const reps = (
    await client.query(
      `select u.id, u.email,
         count(n.id) filter (where n.active and n.health not in ('spam_likely','degraded'))::int as usable
       from users u left join outbound_numbers n on n.assigned_user_id = u.id
       where u.email != 'dev@example.com'
         -- Service users (the per-tenant "AI Agent" that 0036_tenancy inserts)
         -- are not reps. Matched on email rather than users.kind so this works
         -- both before and after that migration is applied to a database.
         and u.email not like 'ai-agent@%'
       group by u.id, u.email`,
    )
  ).rows.map((r) => ({ ...r, usable: Number(r.usable) }));

  for (const num of pool) {
    reps.sort((a, b) => a.usable - b.usable || a.email.localeCompare(b.email));
    const rep = reps[0];
    const tag = rep.email.split('@')[0];
    const label = `Agent ${tag} ${num.ac === '619' ? 'SD' : num.ac}`;
    console.log(`${APPLY ? 'ASSIGN' : 'PLAN  '} ${num.e164} (${num.health}) -> ${rep.email} [${label}]`);
    if (APPLY) {
      await client.query(
        `update outbound_numbers set kind = 'agent', assigned_user_id = $1, label = $2
         where id = $3 and kind = 'dialer_pool'`,
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

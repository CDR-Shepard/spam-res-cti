#!/usr/bin/env npx tsx
/** CSV of every active number and whether NumberVerifier has EVER reported on it.
 *  `enrolled=no` rows are the dashboard to-do list — see docs/runbooks/numberverifier-enrollment.md. */
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const rows = (await c.query(`select e164, kind, coalesce(label,'') label, (health_source = 'numberverifier') enrolled from outbound_numbers where active order by kind, e164`)).rows;
console.log('e164,kind,label,enrolled');
for (const r of rows) console.log(`${r.e164},${r.kind},"${r.label}",${r.enrolled ? 'yes' : 'no'}`);
console.error(`# ${rows.length} numbers, ${rows.filter((r) => !r.enrolled).length} not yet reported on by NumberVerifier`);
await c.end();

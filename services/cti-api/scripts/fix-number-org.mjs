/**
 * One-time data fix (2026-08-26): buy-agent-numbers.ts provisioned all 192
 * launch numbers into the oldest org row ("Dev Org") while every rep user
 * lives in the Salesforce org — so org-scoped rotation saw an empty pool and
 * no rep could dial from their new numbers ("pool exhausted" 409s).
 *
 * Moves to the Salesforce org exactly:
 *   (a) numbers assigned to a user whose org IS the Salesforce org, and
 *   (b) dialer_pool numbers still sitting in the old org.
 * Idempotent; prints before/after. Read-only unless --apply.
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const c = new pg.Client({
  connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
await c.connect();
try {
  const { rows: [target] } = await c.query(
    "select id, name from organizations where name like 'Salesforce Org %' order by created_at limit 1",
  );
  if (!target) throw new Error('no Salesforce org row');
  const { rows: [old] } = await c.query(
    "select id, name from organizations where id <> $1 order by created_at limit 1", [target.id],
  );
  console.log(`target org: ${target.name}; source org: ${old?.name ?? '(none)'}`);

  const misassigned = await c.query(
    `select n.id, n.e164, n.kind from outbound_numbers n
     join users u on u.id = n.assigned_user_id
     where u.org_id = $1 and n.org_id <> $1`, [target.id],
  );
  const pool = await c.query(
    `select id, e164 from outbound_numbers where kind = 'dialer_pool' and org_id <> $1`, [target.id],
  );
  console.log(`assigned-to-SF-users but wrong org: ${misassigned.rows.length}; dialer_pool wrong org: ${pool.rows.length}`);
  if (!APPLY) { console.log('DRY RUN — re-run with --apply'); process.exit(0); }

  await c.query('begin');
  const a = await c.query(
    `update outbound_numbers n set org_id = $1
     from users u where u.id = n.assigned_user_id and u.org_id = $1 and n.org_id <> $1`, [target.id],
  );
  const b = await c.query(
    `update outbound_numbers set org_id = $1 where kind = 'dialer_pool' and org_id <> $1`, [target.id],
  );
  await c.query('commit');
  console.log(`moved: ${a.rowCount} assigned + ${b.rowCount} pool`);
  const after = await c.query('select org_id, count(*)::int from outbound_numbers where active group by 1');
  console.log('numbers by org now:', JSON.stringify(after.rows));
} finally { await c.end(); }

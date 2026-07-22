#!/usr/bin/env node
// Read-only peek at dialer_handoffs (run via `railway run -s Postgres`).
// Optional: DELETE_PENDING=1 clears pending rows (used to remove a stray handoff
// created by a faulted flow test so it can't be auto-dialed).
import pg from 'pg';
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('no DB url'); process.exit(1); }
const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const summary = await c.query(
    "select status, count(*)::int n, max(created_at) as latest from dialer_handoffs group by status order by status",
  );
  console.log('HANDOFFS BY STATUS:', JSON.stringify(summary.rows));
  const recent = await c.query(
    "select left(salesforce_user_id,8) as sfuser8, object_type, jsonb_array_length(record_ids) as n_ids, status, created_at from dialer_handoffs order by created_at desc limit 5",
  );
  console.log('RECENT 5:', JSON.stringify(recent.rows));
  if (process.env.DELETE_PENDING === '1') {
    const del = await c.query("delete from dialer_handoffs where status='pending'");
    console.log('DELETED_PENDING:', del.rowCount);
  }
} finally { await c.end(); }

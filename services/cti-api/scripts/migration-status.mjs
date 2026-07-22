#!/usr/bin/env node
// Read-only: which migrations are applied in the target DB, plus a spot-check
// that the newest expected columns exist. Run via `railway run -s Postgres`.
import pg from 'pg';
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('no DB url'); process.exit(1); }
const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const applied = await c.query(
    "select filename from cti_schema_migrations order by filename desc limit 6",
  );
  console.log('APPLIED (latest 6):', applied.rows.map((r) => r.filename).join(', '));
  const col = await c.query(
    "select column_name from information_schema.columns where table_name='users' and column_name='no_answer_forward_e164'",
  );
  console.log('users.no_answer_forward_e164:', col.rowCount > 0 ? 'PRESENT' : 'ABSENT');
} finally { await c.end(); }

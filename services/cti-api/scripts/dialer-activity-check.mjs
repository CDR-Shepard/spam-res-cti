#!/usr/bin/env node
// Read-only: any real-world power-dialer activity yet? Run via `railway run -s Postgres`.
import pg from 'pg';
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!DB_URL) { console.error('no DB url'); process.exit(1); }
const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const h = await c.query("select status, count(*)::int n, max(created_at) latest from dialer_handoffs group by status");
  console.log('HANDOFFS:', JSON.stringify(h.rows));
  const s = await c.query("select status, count(*)::int n, max(created_at) latest from dialer_sessions group by status");
  console.log('SESSIONS:', JSON.stringify(s.rows));
  const qi = await c.query("select status, count(*)::int n from dialer_queue_items group by status");
  console.log('QUEUE_ITEMS:', JSON.stringify(qi.rows));
  // pool numbers ready + assigned reps
  const pool = await c.query("select count(*)::int total, count(*) filter (where active and health not in ('spam_likely','degraded'))::int healthy from outbound_numbers where kind='dialer_pool'");
  console.log('POOL:', JSON.stringify(pool.rows));
  const reps = await c.query("select count(*)::int n from outbound_numbers where kind='agent' and assigned_user_id is not null");
  console.log('AGENT_DIDS_ASSIGNED:', JSON.stringify(reps.rows));
} finally { await c.end(); }

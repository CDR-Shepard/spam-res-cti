import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
try {
  for (let i = 0; i < 12; i++) {
    const h = await c.query("select status, claimed_at from dialer_handoffs where id='c357d003-4c1b-4d2f-b6d0-16f2c78cfef4'");
    const s = await c.query("select id, status from dialer_sessions where user_id='c9c45940-0f17-4c1e-bb3e-d084ba93eb86' order by created_at desc limit 1");
    let item = '';
    if (s.rows[0]) {
      const qi = await c.query("select ordinal, status, call_id, from_number from dialer_queue_items where session_id=$1 order by ordinal", [s.rows[0].id]);
      item = JSON.stringify(qi.rows);
    }
    console.log(`[${i*3}s] handoff=${h.rows[0]?.status} session=${JSON.stringify(s.rows[0])} items=${item}`);
    await sleep(3000);
  }
} finally { await c.end(); }

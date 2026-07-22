#!/usr/bin/env node
/**
 * Buy dialer-pool DIDs on Twilio and register them in the CTI pool.
 *
 * The prod DB is private (internal Railway host) and Twilio creds live on a
 * different Railway service than the public DB proxy, so this runs in two
 * steps, each via `railway run` against the service that holds its secrets —
 * the operator never handles a secret:
 *
 *   # 1) BUY — Twilio creds come from the @cti/api service; writes a handoff file:
 *   MODE=buy POOL_API_BASE=https://ctiapi-production.up.railway.app \
 *     railway run -s @cti/api node services/cti-api/scripts/buy-pool-numbers.mjs
 *   # (dry run — omit CONFIRM_BUY; real purchase — add CONFIRM_BUY=1)
 *
 *   # 2) REGISTER — public DB URL comes from the Postgres service; reads the handoff file:
 *   MODE=register railway run -s Postgres node services/cti-api/scripts/buy-pool-numbers.mjs
 *
 * MODE=both (default) does buy+register in one process (only works where one
 * env has BOTH Twilio creds and a reachable DATABASE_URL, e.g. local dev).
 *
 * Registers as kind='dialer_pool', inbound_enabled=true, unassigned (shared
 * pool), provider='twilio'. Idempotent DB insert (skips an existing e164).
 */
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';

const PLAN = [
  { areaCode: '619', count: 5 }, // San Diego
  { areaCode: '951', count: 5 }, // Riverside / Inland Empire
];

const MODE = process.env.MODE || 'both'; // buy | register | both
const CONFIRM = process.env.CONFIRM_BUY === '1';
const HANDOFF = process.env.POOL_OUTFILE ||
  '/private/tmp/claude-501/-Users-cdrshepard-spam-res-cti/afd1f56e-293d-4ea6-9400-11116185f1f2/scratchpad/pool-buy.json';
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const API_BASE = process.env.POOL_API_BASE || process.env.API_PUBLIC_URL;
// Prefer the public proxy URL (reachable off-Railway); fall back to DATABASE_URL.
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const authHeader = () => 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
const twBase = () => `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}`;

async function twGet(path) {
  const res = await fetch(`${twBase()}${path}`, { headers: { authorization: authHeader() } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio GET ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function twPost(path, form) {
  const res = await fetch(`${twBase()}${path}`, {
    method: 'POST',
    headers: { authorization: authHeader(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio POST ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function searchAvailable(areaCode, count) {
  const data = await twGet(
    `/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&PageSize=${Math.max(count, 10)}`,
  );
  return (data.available_phone_numbers ?? []).slice(0, count).map((n) => n.phone_number);
}

async function doBuy() {
  if (!ACCOUNT || !TOKEN) die('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');
  if (!API_BASE) die('Set POOL_API_BASE (prod API base) or API_PUBLIC_URL.');
  if (!/^https:\/\//.test(API_BASE)) die(`Refusing a non-HTTPS voice webhook base: ${API_BASE}.`);
  const VOICE_URL = `${API_BASE}/telephony/twilio/inbound`;
  console.log(`Voice webhook for purchased DIDs: ${VOICE_URL}`);
  console.log(CONFIRM ? '*** CONFIRM_BUY=1 — WILL PURCHASE ***\n' : '--- DRY RUN (no purchase). Set CONFIRM_BUY=1 to buy. ---\n');

  const bought = [];
  // Persist after every purchase so a mid-batch failure never loses a number
  // that's already been charged to the account.
  const persist = () => { if (CONFIRM) writeFileSync(HANDOFF, JSON.stringify(bought, null, 2)); };
  try {
    for (const { areaCode, count } of PLAN) {
      const candidates = await searchAvailable(areaCode, count);
      if (candidates.length < count) console.warn(`WARN: only ${candidates.length}/${count} available in ${areaCode}.`);
      for (const cand of candidates) {
        if (!CONFIRM) {
          console.log(`[dry-run] ${areaCode}: would buy ${cand}`);
          continue;
        }
        const data = await twPost(`/IncomingPhoneNumbers.json`, {
          PhoneNumber: cand,
          VoiceUrl: VOICE_URL,
          VoiceMethod: 'POST',
          FriendlyName: `Dialer Pool ${areaCode}`,
        });
        const rec = { e164: data.phone_number, sid: data.sid, areaCode, label: `Dialer Pool ${areaCode}` };
        console.log(`BOUGHT: ${rec.e164} (${rec.sid}) [${areaCode}]`);
        bought.push(rec);
        persist();
      }
    }
  } finally {
    persist();
  }
  if (CONFIRM) console.log(`\nWrote ${bought.length} purchased number(s) → ${HANDOFF}`);
  else console.log('\nDry run complete — no handoff file written.');
}

async function doRegister() {
  if (!DB_URL) die('No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s Postgres`).');
  let bought;
  try { bought = JSON.parse(readFileSync(HANDOFF, 'utf8')); }
  catch { die(`Cannot read handoff file ${HANDOFF} — run MODE=buy CONFIRM_BUY=1 first.`); }
  if (!Array.isArray(bought) || bought.length === 0) die('Handoff file has no purchased numbers.');

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const orgRes = await client.query('select id, name, sf_org_id from organizations order by created_at asc limit 1');
    if (orgRes.rowCount === 0) die('No organization row found.');
    const org = orgRes.rows[0];
    console.log(`Target org: ${org.name} (${org.id}) sf_org_id=${org.sf_org_id ? 'SET' : 'null'}`);
    const summary = [];
    for (const rec of bought) {
      const dup = await client.query('select id from outbound_numbers where e164 = $1', [rec.e164]);
      if (dup.rowCount > 0) { console.log(`skip (already registered): ${rec.e164}`); summary.push({ ...rec, registered: 'dup' }); continue; }
      await client.query(
        `insert into outbound_numbers (org_id, e164, label, provider, active, twilio_sid, kind, inbound_enabled)
         values ($1,$2,$3,'twilio',true,$4,'dialer_pool',true)`,
        [org.id, rec.e164, rec.label, rec.sid],
      );
      console.log(`REGISTERED (dialer_pool): ${rec.e164}`);
      summary.push({ ...rec, registered: 'yes' });
    }
    console.table(summary);
  } finally {
    await client.end();
  }
}

async function doDbCheck() {
  if (!DB_URL) die('No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s Postgres`).');
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const org = await client.query('select id, name, sf_org_id from organizations order by created_at asc limit 1');
    const u = await client.query('select count(*)::int n from users');
    const reps = await client.query("select count(*)::int n from users where display_name ilike any (array['%cook%','%lizola%','%tyler%','%matt%'])");
    const nums = await client.query("select count(*)::int total, count(*) filter (where kind='dialer_pool')::int pool from outbound_numbers");
    const o = org.rows[0] || {};
    console.log(`org: ${o.name} (${o.id})  sf_org_id=${o.sf_org_id ? 'SET' : 'null'}  users=${u.rows[0].n}  beta_rep_matches=${reps.rows[0].n}  numbers=${nums.rows[0].total} pool=${nums.rows[0].pool}`);
  } finally { await client.end(); }
}

async function doColCheck() {
  if (!DB_URL) die('No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s Postgres`).');
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const r = await client.query(
      "select column_name from information_schema.columns where table_name='campaign_configs' and column_name='per_customer_max_attempts'",
    );
    console.log(r.rowCount > 0 ? 'COLUMN_PRESENT' : 'COLUMN_ABSENT');
  } finally { await client.end(); }
}

async function main() {
  if (MODE === 'colcheck') return doColCheck();
  if (MODE === 'dbcheck') return doDbCheck();
  if (MODE === 'buy') return doBuy();
  if (MODE === 'register') return doRegister();
  // both
  await doBuy();
  if (CONFIRM) await doRegister();
}
main().catch((e) => die(e.message));

#!/usr/bin/env node
/**
 * Buy dialer-pool DIDs on Twilio and register them in the CTI pool.
 *
 * Runs with PRODUCTION env injected via `railway run` (so it uses the prod
 * Twilio account + prod DATABASE_URL; the operator never handles the secrets):
 *
 *   # dry run — searches + shows what it WOULD buy, purchases nothing:
 *   cd services/cti-api && railway run node scripts/buy-pool-numbers.mjs
 *
 *   # real purchase (charges the Twilio account on file):
 *   cd services/cti-api && CONFIRM_BUY=1 railway run node scripts/buy-pool-numbers.mjs
 *
 * What it does per area code (default 619 x5, 951 x5):
 *   1. Searches Twilio AvailablePhoneNumbers (US/Local, voice-enabled).
 *   2. (confirm only) Purchases each, setting the Voice webhook to
 *      ${API_PUBLIC_URL}/telephony/twilio/inbound at purchase time.
 *   3. Inserts a row into outbound_numbers as kind='dialer_pool',
 *      inbound_enabled=true, unassigned (shared pool), provider='twilio'.
 *
 * Idempotency: purchasing is NOT idempotent — run once, deliberately. The DB
 * insert is guarded against an existing e164 (skips duplicates), so a re-run
 * after a partial failure won't double-insert already-registered numbers.
 */
import pg from 'pg';

const PLAN = [
  { areaCode: '619', count: 5 }, // San Diego
  { areaCode: '951', count: 5 }, // Riverside / Inland Empire
];

const CONFIRM = process.env.CONFIRM_BUY === '1';
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const API_PUBLIC_URL = process.env.API_PUBLIC_URL;
const DATABASE_URL = process.env.DATABASE_URL;

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}
if (!ACCOUNT || !TOKEN) die('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (run via `railway run`).');
if (!API_PUBLIC_URL) die('API_PUBLIC_URL not set.');
if (!DATABASE_URL) die('DATABASE_URL not set (run via `railway run`).');

const authHeader = 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
const VOICE_URL = `${API_PUBLIC_URL}/telephony/twilio/inbound`;
const twBase = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}`;

async function twGet(path) {
  const res = await fetch(`${twBase}${path}`, { headers: { authorization: authHeader } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio GET ${path} → ${res.status} ${JSON.stringify(data)}`);
  return data;
}
async function twPost(path, form) {
  const res = await fetch(`${twBase}${path}`, {
    method: 'POST',
    headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
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

async function purchase(phoneNumber, areaCode) {
  const data = await twPost(`/IncomingPhoneNumbers.json`, {
    PhoneNumber: phoneNumber,
    VoiceUrl: VOICE_URL,
    VoiceMethod: 'POST',
    FriendlyName: `Dialer Pool ${areaCode}`,
  });
  return { e164: data.phone_number, sid: data.sid };
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const orgRes = await client.query('select id, name from organizations order by created_at asc limit 1');
    if (orgRes.rowCount === 0) die('No organization row found in the target DB.');
    const org = orgRes.rows[0];
    console.log(`Target org: ${org.name} (${org.id})`);
    console.log(`Voice webhook for purchased DIDs: ${VOICE_URL}`);
    console.log(CONFIRM ? '*** CONFIRM_BUY=1 — WILL PURCHASE ***\n' : '--- DRY RUN (no purchase). Set CONFIRM_BUY=1 to buy. ---\n');

    const summary = [];
    for (const { areaCode, count } of PLAN) {
      const candidates = await searchAvailable(areaCode, count);
      if (candidates.length < count) {
        console.warn(`WARN: only ${candidates.length}/${count} numbers available in ${areaCode}.`);
      }
      for (const cand of candidates) {
        if (!CONFIRM) {
          console.log(`[dry-run] ${areaCode}: would buy ${cand} → register kind=dialer_pool`);
          summary.push({ areaCode, e164: cand, bought: false });
          continue;
        }
        const dup = await client.query('select id from outbound_numbers where e164 = $1', [cand]);
        if (dup.rowCount > 0) { console.log(`skip (already registered): ${cand}`); continue; }
        const { e164, sid } = await purchase(cand, areaCode);
        await client.query(
          `insert into outbound_numbers (org_id, e164, label, provider, active, twilio_sid, kind, inbound_enabled)
           values ($1,$2,$3,'twilio',true,$4,'dialer_pool',true)`,
          [org.id, e164, `Dialer Pool ${areaCode}`, sid],
        );
        console.log(`BOUGHT + registered: ${e164} (${sid}) [${areaCode}]`);
        summary.push({ areaCode, e164, sid, bought: true });
      }
    }
    console.log(`\nDone. ${summary.filter((s) => s.bought).length} purchased, ${summary.length} planned.`);
    console.table(summary);
  } finally {
    await client.end();
  }
}
main().catch((e) => die(e.message));

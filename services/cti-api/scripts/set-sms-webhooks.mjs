#!/usr/bin/env node
/**
 * Sets every active number's Twilio SmsUrl (+SmsMethod=POST) to our
 * inbound-texts webhook, so a text to any of our numbers reaches
 * POST /telephony/twilio/sms instead of disappearing — Twilio silently
 * accepts an inbound text with no SmsUrl configured and never shows it to us.
 * See docs/superpowers/specs/2026-09-25-inbound-texts-design.md, task 7.
 *
 * Covers every ACTIVE outbound_numbers row of kind 'agent' or 'dialer_pool'
 * that has a twilio_sid (SELECT_NUMBERS_SQL below). NEVER touches VoiceUrl,
 * VoiceApplicationSid, or anything else on the number — only SmsUrl/SmsMethod
 * are read (to decide what needs changing) and written.
 *
 * DRY RUN BY DEFAULT: fetches every number's CURRENT SmsUrl/SmsMethod from
 * Twilio and prints how many already match versus how many would change —
 * Twilio is never written to. Pass --apply to actually write the change.
 *
 * Usage — this needs BOTH a reachable Postgres AND Twilio creds, so run it via
 * the API service (which holds both):
 *   railway run -s @cti/api node scripts/set-sms-webhooks.mjs           # dry run
 *   railway run -s @cti/api node scripts/set-sms-webhooks.mjs --apply   # writes
 *
 * Env:
 *   DATABASE_PUBLIC_URL (preferred) or DATABASE_URL — `railway run -s @cti/api`
 *     injects that service's PRIVATE DATABASE_URL, whose host only resolves
 *     inside Railway's network. DATABASE_PUBLIC_URL (from the Postgres
 *     service's own variables) resolves from a laptop; prefer it here.
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / API_PUBLIC_URL — the @cti/api
 *     service's own variables; `railway run -s @cti/api` sets these for you.
 *
 * Never prints a secret — only e164s, Twilio sids, and counts.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function parseArgs(argv) {
  return { apply: argv.includes('--apply') };
}

/**
 * EXACT concatenation — no trailing-slash trim, no query string, no path
 * normalization. Must match routes/inbound-sms.ts's own
 * `${cfg.API_PUBLIC_URL}/telephony/twilio/sms` byte-for-byte: Twilio's
 * signature check hashes the exact request URL, so a mismatch here (a
 * trailing slash, a different scheme) would make every inbound text fail
 * signature validation once this script points Twilio at it.
 */
export function smsWebhookUrl(apiPublicUrl) {
  return `${apiPublicUrl}/telephony/twilio/sms`;
}

/** Every active number this script is responsible for. */
export const SELECT_NUMBERS_SQL = `select id, e164, twilio_sid, kind
   from outbound_numbers
  where active
    and kind in ('agent', 'dialer_pool')
    and twilio_sid is not null
  order by e164`;

/**
 * Pure classification: given the numbers and each one's CURRENT Twilio config
 * keyed by sid (missing entry = the GET for that number failed), splits them
 * into "already set" (SmsUrl + SmsMethod=POST exactly right — nothing to do),
 * "would change" (needs the write), and "fetch failed" (Twilio was
 * unreachable for that number; never guessed into either other bucket).
 */
export function classifyNumbers(numbers, configBySid, desiredUrl) {
  const alreadySet = [];
  const wouldChange = [];
  const fetchFailed = [];
  for (const n of numbers) {
    const cfg = configBySid.get(n.twilio_sid);
    if (cfg === undefined) {
      fetchFailed.push(n);
      continue;
    }
    const matches = cfg.smsUrl === desiredUrl && (cfg.smsMethod ?? '').toUpperCase() === 'POST';
    (matches ? alreadySet : wouldChange).push(n);
  }
  return { alreadySet, wouldChange, fetchFailed };
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

const authHeader = (sid, token) => 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
const twBase = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}`;

/** Reads ONLY the two fields this script cares about — never logs the rest of
 *  the Twilio response (it can carry other config we must not touch). */
async function fetchTwilioNumber(accountSid, authToken, numberSid) {
  const res = await fetch(`${twBase(accountSid)}/IncomingPhoneNumbers/${numberSid}.json`, {
    headers: { authorization: authHeader(accountSid, authToken) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio GET ${numberSid} -> ${res.status}`);
  return { smsUrl: data.sms_url ?? null, smsMethod: data.sms_method ?? null };
}

/** Writes ONLY SmsUrl/SmsMethod — Twilio's PATCH-by-POST leaves every field
 *  not included in the body untouched, so VoiceUrl/VoiceApplicationSid/etc.
 *  are never at risk here. */
async function applyTwilioNumber(accountSid, authToken, numberSid, desiredUrl) {
  const res = await fetch(`${twBase(accountSid)}/IncomingPhoneNumbers/${numberSid}.json`, {
    method: 'POST',
    headers: { authorization: authHeader(accountSid, authToken), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SmsUrl: desiredUrl, SmsMethod: 'POST' }).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio POST ${numberSid} -> ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const API_PUBLIC_URL = process.env.API_PUBLIC_URL;
  if (!DB_URL) die('No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s @cti/api`, or export DATABASE_PUBLIC_URL from the Postgres service).');
  if (!ACCOUNT || !TOKEN) die('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');
  if (!API_PUBLIC_URL || !/^https:\/\//.test(API_PUBLIC_URL)) die('API_PUBLIC_URL must be set to the https prod API base.');

  const desiredUrl = smsWebhookUrl(API_PUBLIC_URL);
  console.log(apply ? '*** --apply — WILL WRITE TO TWILIO ***' : '--- DRY RUN (no writes). Pass --apply to update Twilio. ---');
  console.log(`target SmsUrl: ${desiredUrl}\n`);

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  let numbers;
  try {
    numbers = (await client.query(SELECT_NUMBERS_SQL)).rows;
  } finally {
    await client.end();
  }
  console.log(`${numbers.length} active number(s) (agent + dialer_pool) with a Twilio sid.`);

  const configBySid = new Map();
  for (const n of numbers) {
    try {
      configBySid.set(n.twilio_sid, await fetchTwilioNumber(ACCOUNT, TOKEN, n.twilio_sid));
    } catch (err) {
      console.warn(`  could not read ${n.e164} (${n.twilio_sid}): ${err.message}`);
    }
  }

  const { alreadySet, wouldChange, fetchFailed } = classifyNumbers(numbers, configBySid, desiredUrl);
  console.log(`\n${alreadySet.length} already set correctly.`);
  console.log(`${wouldChange.length} would change.`);
  if (fetchFailed.length > 0) console.log(`${fetchFailed.length} could not be read from Twilio — skipped either way.`);

  if (!apply) {
    if (wouldChange.length > 0) {
      console.log('\nWould update (up to 20 shown):');
      for (const n of wouldChange.slice(0, 20)) console.log(`  ${n.e164} (${n.kind}, ${n.twilio_sid})`);
      if (wouldChange.length > 20) console.log(`  … and ${wouldChange.length - 20} more`);
    }
    console.log('\nDRY RUN — re-run with --apply to write these to Twilio.');
    return;
  }

  let updated = 0;
  let failed = 0;
  for (const n of wouldChange) {
    try {
      await applyTwilioNumber(ACCOUNT, TOKEN, n.twilio_sid, desiredUrl);
      updated++;
      console.log(`  SET ${n.e164} (${n.twilio_sid})`);
    } catch (err) {
      failed++;
      console.error(`  FAILED ${n.e164} (${n.twilio_sid}): ${err.message}`);
    }
  }
  console.log(`\nUpdated ${updated}/${wouldChange.length}` + (failed ? `, ${failed} failed — re-run to retry them` : '') + '.');
}

// Only run against a real database/Twilio when this file is executed directly
// (`node scripts/set-sms-webhooks.mjs`) — never on import, so the pure helpers
// above can be unit-tested without DATABASE_URL, Twilio creds, or a live DB.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

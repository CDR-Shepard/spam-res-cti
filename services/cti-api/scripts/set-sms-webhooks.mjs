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
 * BEFORE WRITING ANYTHING, --apply:
 *   - prints a summary of every number's CURRENT SmsUrl grouped by HOST ONLY
 *     (never the full URL, which can carry a token or path);
 *   - reports (and SKIPS) any number whose Twilio `sms_application_sid` is
 *     set — Twilio ignores SmsUrl when an app or Messaging Service sid owns
 *     the number, so writing SmsUrl there would silently do nothing;
 *   - reports (and SKIPS) any number whose Twilio `phone_number` does not
 *     match our own e164 for that row — a stale twilio_sid pointing at the
 *     wrong resource;
 *   - writes a ROLLBACK FILE (sid -> previous SmsUrl/SmsMethod) before the
 *     first Twilio write, default path
 *     ./sms-webhooks-rollback-<ISO timestamp>.json, overridable with
 *     --rollback-file <path>.
 * Recover from a bad run with --restore <rollback file> (also dry-run by
 * default; add --apply to actually write the restore).
 *
 * Usage — this needs BOTH a reachable Postgres AND Twilio creds, so run it via
 * the API service (which holds both):
 *   railway run -s @cti/api -- env DATABASE_URL=$DATABASE_PUBLIC_URL node scripts/set-sms-webhooks.mjs           # dry run
 *   railway run -s @cti/api -- env DATABASE_URL=$DATABASE_PUBLIC_URL node scripts/set-sms-webhooks.mjs --apply   # writes
 *   railway run -s @cti/api -- env DATABASE_URL=$DATABASE_PUBLIC_URL node scripts/set-sms-webhooks.mjs --restore ./sms-webhooks-rollback-....json --apply
 *
 * Env:
 *   DATABASE_PUBLIC_URL (preferred) or DATABASE_URL — `railway run -s @cti/api`
 *     injects that service's PRIVATE DATABASE_URL, whose host only resolves
 *     inside Railway's network. DATABASE_PUBLIC_URL (from the Postgres
 *     service's own variables) resolves from a laptop; prefer it here.
 *     Not needed at all in --restore mode.
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / API_PUBLIC_URL — the @cti/api
 *     service's own variables; `railway run -s @cti/api` sets these for you.
 *
 * Never prints a secret, a full Twilio response, or a Postgres error's
 * `.detail` — only e164s, Twilio sids, hosts (never full URLs), and counts.
 */
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseArgs(argv) {
  return {
    apply: argv.includes('--apply'),
    rollbackFile: argValue(argv, 'rollback-file') ?? null,
    restoreFile: argValue(argv, 'restore') ?? null,
  };
}

/**
 * EXACT concatenation — no trailing-slash trim, no query string, no path
 * normalization. Must match routes/inbound-sms.ts's own
 * `${cfg.API_PUBLIC_URL}/telephony/twilio/sms` byte-for-byte: Twilio's
 * signature check hashes the exact request URL, so a mismatch here (a
 * trailing slash, a different scheme) would make every inbound text fail
 * signature validation once this script points Twilio at it. `run()` refuses
 * a trailing slash on the input before this is ever called (see below).
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

/** Host only, NEVER the full URL — a URL can carry a token or a path. */
export function urlHost(url) {
  if (!url) return '(none)';
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

/** Twilio ignores a number's SmsUrl once an app (TwiML App) or a Messaging
 *  Service owns its messaging — either shows up in `sms_application_sid`.
 *  Writing SmsUrl there would silently do nothing, so these are reported as
 *  "not covered" and never written (I4). */
export function ignoresSmsUrl(cfg) {
  return Boolean(cfg?.smsApplicationSid);
}

/**
 * Pure classification: given the numbers and each one's CURRENT Twilio config
 * keyed by sid (missing entry = the GET for that number failed), splits them
 * into five groups. Priority when more than one applies: fetch-failed, then
 * mismatched (the more alarming problem — this sid may not even be OUR
 * number), then not-covered, then already-set/would-change.
 */
export function classifyNumbers(numbers, configBySid, desiredUrl) {
  const alreadySet = [];
  const wouldChange = [];
  const fetchFailed = [];
  const notCovered = [];
  const mismatched = [];
  for (const n of numbers) {
    const cfg = configBySid.get(n.twilio_sid);
    if (cfg === undefined) {
      fetchFailed.push(n);
      continue;
    }
    if (cfg.phoneNumber && cfg.phoneNumber !== n.e164) {
      mismatched.push(n);
      continue;
    }
    if (ignoresSmsUrl(cfg)) {
      notCovered.push(n);
      continue;
    }
    const matches = cfg.smsUrl === desiredUrl && (cfg.smsMethod ?? '').toUpperCase() === 'POST';
    (matches ? alreadySet : wouldChange).push(n);
  }
  return { alreadySet, wouldChange, fetchFailed, notCovered, mismatched };
}

/** The pre-write summary (I4): every number's CURRENT SmsUrl host, counted —
 *  never the full URL. A fetch failure counts as its own bucket so the
 *  summary total always matches `numbers.length`. */
export function summarizeHosts(numbers, configBySid) {
  const counts = new Map();
  for (const n of numbers) {
    const cfg = configBySid.get(n.twilio_sid);
    const host = cfg === undefined ? '(fetch failed)' : urlHost(cfg.smsUrl);
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Default rollback file path: filesystem-safe (no colons). */
export function defaultRollbackFilePath(now) {
  return `./sms-webhooks-rollback-${now.toISOString().replace(/:/g, '-')}.json`;
}

/** sid -> the value THIS run is about to overwrite, for every number that
 *  would change — written to disk BEFORE the first Twilio write (I4). */
export function buildRollbackRecords(wouldChangeNumbers, configBySid) {
  return wouldChangeNumbers.map((n) => {
    const cfg = configBySid.get(n.twilio_sid);
    return { sid: n.twilio_sid, e164: n.e164, previousSmsUrl: cfg?.smsUrl ?? null, previousSmsMethod: cfg?.smsMethod ?? null };
  });
}

/** Reduces an error to what is safe to print: never `.detail` (a Postgres
 *  constraint violation can quote a row) or the raw Twilio response, and
 *  never the whole error object. */
export function safeErrorMessage(err) {
  const message = err?.message ?? String(err);
  const code = err?.code;
  return code ? `${message} (code ${code})` : message;
}

const authHeader = (sid, token) => 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
const twBase = (sid) => `https://api.twilio.com/2010-04-01/Accounts/${sid}`;

/** Reads ONLY the fields this script cares about — never logs the rest of
 *  the Twilio response (it can carry other config we must not touch). */
async function fetchTwilioNumber(accountSid, authToken, numberSid) {
  const res = await fetch(`${twBase(accountSid)}/IncomingPhoneNumbers/${numberSid}.json`, {
    headers: { authorization: authHeader(accountSid, authToken) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio GET ${numberSid} -> ${res.status}`);
  return {
    smsUrl: data.sms_url ?? null,
    smsMethod: data.sms_method ?? null,
    smsApplicationSid: data.sms_application_sid ?? null,
    phoneNumber: data.phone_number ?? null,
  };
}

/** Writes ONLY the given fields (SmsUrl/SmsMethod) — Twilio's POST-to-update
 *  leaves every field not included in the body untouched, so VoiceUrl/
 *  VoiceApplicationSid/etc. are never at risk here. Reused by --restore with
 *  the PREVIOUS value as `fields`. */
async function applyTwilioNumber(accountSid, authToken, numberSid, fields) {
  const res = await fetch(`${twBase(accountSid)}/IncomingPhoneNumbers/${numberSid}.json`, {
    method: 'POST',
    headers: { authorization: authHeader(accountSid, authToken), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
  const data = await res.json();
  // Never the full Twilio response — only its own error code/message.
  if (!res.ok) throw new Error(`Twilio POST ${numberSid} -> ${res.status}: ${data.message ?? data.code ?? 'unknown error'}`);
  return data;
}

/** `--restore <file>`: reads a rollback file this script previously wrote and
 *  puts each number's SmsUrl/SmsMethod back. Dry run unless --apply. Never
 *  touches the database — everything it needs is already in the file. */
async function runRestore(args, deps) {
  const { stdout, stderr, readFile, twilio } = deps;
  let raw;
  try {
    raw = await readFile(args.restoreFile, 'utf8');
  } catch (err) {
    stderr(`ERROR: could not read restore file ${args.restoreFile}: ${safeErrorMessage(err)}`);
    return { exitCode: 1 };
  }
  let records;
  try {
    records = JSON.parse(raw);
  } catch {
    stderr(`ERROR: restore file ${args.restoreFile} is not valid JSON.`);
    return { exitCode: 1 };
  }
  if (!Array.isArray(records)) {
    stderr(`ERROR: restore file ${args.restoreFile} must contain a JSON array.`);
    return { exitCode: 1 };
  }

  stdout(args.apply ? '*** --apply --restore — WILL WRITE TO TWILIO ***' : '--- DRY RUN --restore (no writes). Pass --apply to restore. ---');
  stdout(`${records.length} number(s) in the rollback file.`);

  if (!args.apply) {
    for (const r of records.slice(0, 20)) {
      stdout(`  would restore ${r.e164} (${r.sid}) -> ${r.previousSmsUrl ?? '(none)'} / ${r.previousSmsMethod ?? '(none)'}`);
    }
    if (records.length > 20) stdout(`  … and ${records.length - 20} more`);
    stdout('\nDRY RUN — re-run with --apply to restore these on Twilio.');
    return { exitCode: 0 };
  }

  let restored = 0;
  let failed = 0;
  for (const r of records) {
    try {
      await twilio.updateNumber(r.sid, { SmsUrl: r.previousSmsUrl ?? '', SmsMethod: r.previousSmsMethod ?? 'POST' });
      restored++;
      stdout(`  RESTORED ${r.e164} (${r.sid})`);
    } catch (err) {
      failed++;
      stderr(`  FAILED ${r.e164} (${r.sid}): ${safeErrorMessage(err)}`);
    }
  }
  stdout(`\nRestored ${restored}/${records.length}` + (failed ? `, ${failed} failed` : '') + '.');
  return { exitCode: failed > 0 ? 1 : 0 };
}

/**
 * The whole run, deps-injected so it's testable without a real database,
 * Twilio account, or filesystem (I3). `deps.db.query(sql)`; `deps.twilio`
 * = `{ getNumber(sid), updateNumber(sid, fields) }`; `deps.stdout`/
 * `deps.stderr` default to console.log/console.error; `deps.now` defaults to
 * `() => new Date()`; `deps.writeFile`/`deps.readFile` default to node:fs/promises.
 */
export async function run(argv, deps) {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const now = deps.now ?? (() => new Date());
  const writeFile = deps.writeFile ?? fsWriteFile;
  const readFile = deps.readFile ?? fsReadFile;

  const args = parseArgs(argv);

  if (args.restoreFile) {
    return runRestore(args, { stdout, stderr, readFile, twilio: deps.twilio });
  }

  if (!deps.apiPublicUrl || !/^https:\/\//.test(deps.apiPublicUrl)) {
    stderr('ERROR: API_PUBLIC_URL must be set to the https prod API base.');
    return { exitCode: 1 };
  }
  if (deps.apiPublicUrl.endsWith('/')) {
    stderr(
      `ERROR: API_PUBLIC_URL must not end with "/" (got ${deps.apiPublicUrl}) — Twilio's SmsUrl has to match ` +
        "routes/inbound-sms.ts's own URL exactly, and a trailing slash breaks that.",
    );
    return { exitCode: 1 };
  }

  const desiredUrl = smsWebhookUrl(deps.apiPublicUrl);
  stdout(args.apply ? '*** --apply — WILL WRITE TO TWILIO ***' : '--- DRY RUN (no writes). Pass --apply to update Twilio. ---');
  stdout(`target SmsUrl: ${desiredUrl}`);

  let numbers;
  try {
    numbers = (await deps.db.query(SELECT_NUMBERS_SQL)).rows;
  } catch (err) {
    stderr(`ERROR: could not read outbound_numbers: ${safeErrorMessage(err)}`);
    return { exitCode: 1 };
  }
  stdout(`${numbers.length} active number(s) (agent + dialer_pool) with a Twilio sid.`);

  const configBySid = new Map();
  for (const n of numbers) {
    try {
      configBySid.set(n.twilio_sid, await deps.twilio.getNumber(n.twilio_sid));
    } catch (err) {
      stderr(`  could not read ${n.e164} (${n.twilio_sid}): ${safeErrorMessage(err)}`);
    }
  }

  stdout('\nCurrent SmsUrl by host:');
  for (const [host, count] of summarizeHosts(numbers, configBySid)) stdout(`  ${host}: ${count}`);

  const { alreadySet, wouldChange, fetchFailed, notCovered, mismatched } = classifyNumbers(numbers, configBySid, desiredUrl);

  if (notCovered.length > 0) {
    stdout(
      `\n${notCovered.length} number(s) have an sms_application_sid set — Twilio ignores SmsUrl for these. ` +
        'SKIPPED, reported as "not covered":',
    );
    for (const n of notCovered.slice(0, 20)) stdout(`  ${n.e164} (${n.twilio_sid})`);
    if (notCovered.length > 20) stdout(`  … and ${notCovered.length - 20} more`);
  }
  if (mismatched.length > 0) {
    stdout(`\n${mismatched.length} number(s) whose Twilio phone_number does NOT match our e164 — SKIPPED (mismatch):`);
    for (const n of mismatched.slice(0, 20)) stdout(`  ${n.e164} (${n.twilio_sid})`);
    if (mismatched.length > 20) stdout(`  … and ${mismatched.length - 20} more`);
  }

  stdout(`\n${alreadySet.length} already set correctly.`);
  stdout(`${wouldChange.length} would change.`);
  if (fetchFailed.length > 0) stdout(`${fetchFailed.length} could not be read from Twilio — skipped either way.`);

  if (!args.apply) {
    if (wouldChange.length > 0) {
      stdout('\nWould update (up to 20 shown):');
      for (const n of wouldChange.slice(0, 20)) stdout(`  ${n.e164} (${n.kind}, ${n.twilio_sid})`);
      if (wouldChange.length > 20) stdout(`  … and ${wouldChange.length - 20} more`);
    }
    stdout('\nDRY RUN — re-run with --apply to write these to Twilio.');
    return { exitCode: 0 };
  }

  if (wouldChange.length === 0) {
    stdout('\nNothing to update.');
    return { exitCode: 0 };
  }

  // I4: the rollback file is written BEFORE the first Twilio write.
  const rollbackPath = args.rollbackFile ?? defaultRollbackFilePath(now());
  const rollbackRecords = buildRollbackRecords(wouldChange, configBySid);
  await writeFile(rollbackPath, JSON.stringify(rollbackRecords, null, 2));
  stdout(`\nRollback file written: ${rollbackPath} (${rollbackRecords.length} record(s)). Restore with:`);
  stdout(`  node scripts/set-sms-webhooks.mjs --restore ${rollbackPath} --apply`);

  let updated = 0;
  let failed = 0;
  for (const n of wouldChange) {
    try {
      await deps.twilio.updateNumber(n.twilio_sid, { SmsUrl: desiredUrl, SmsMethod: 'POST' });
      updated++;
      stdout(`  SET ${n.e164} (${n.twilio_sid})`);
    } catch (err) {
      failed++;
      stderr(`  FAILED ${n.e164} (${n.twilio_sid}): ${safeErrorMessage(err)}`);
    }
  }
  stdout(`\nUpdated ${updated}/${wouldChange.length}` + (failed ? `, ${failed} failed — re-run to retry them` : '') + '.');
  return { exitCode: failed > 0 ? 1 : 0 };
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!ACCOUNT || !TOKEN) {
    console.error('ERROR: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');
    process.exitCode = 1;
    return;
  }
  const twilio = {
    getNumber: (sid) => fetchTwilioNumber(ACCOUNT, TOKEN, sid),
    updateNumber: (sid, fields) => applyTwilioNumber(ACCOUNT, TOKEN, sid, fields),
  };

  // --restore never touches the database — skip connecting entirely so a
  // rollback can be applied even if Postgres is unreachable.
  if (args.restoreFile) {
    const result = await run(argv, { twilio });
    process.exitCode = result?.exitCode ?? 0;
    return;
  }

  const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const API_PUBLIC_URL = process.env.API_PUBLIC_URL;
  if (!DB_URL) {
    console.error('ERROR: No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s @cti/api`, or export DATABASE_PUBLIC_URL from the Postgres service).');
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const result = await run(argv, {
      db: { query: (sql) => client.query(sql) },
      twilio,
      apiPublicUrl: API_PUBLIC_URL,
    });
    process.exitCode = result?.exitCode ?? 0;
  } finally {
    await client.end();
  }
}

// Only run against a real database/Twilio/filesystem when this file is
// executed directly (`node scripts/set-sms-webhooks.mjs`) — never on import,
// so the pure helpers and run() above can be unit-tested without
// DATABASE_URL, Twilio creds, or a live DB.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    // Top-level catch: only .message/.code ever reach the terminal, never
    // `.detail` or the raw error object.
    console.error(`ERROR: ${safeErrorMessage(err)}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
/**
 * Backfills one rep's inbound texts from Twilio history into inbound_messages
 * (design docs/superpowers/specs/2026-09-25-inbound-texts-design.md, task 6)
 * — for texts that arrived BEFORE the webhook was wired up (see
 * set-sms-webhooks.mjs) and so were never stored. The worker
 * (sms/inbound-text-worker.ts) then creates each row's Salesforce Task on its
 * next tick and, once every row in the batch has reached a terminal status,
 * sends the rep ONE digest email instead of an alert per text.
 *
 * Pulls history ONLY for the rep's own agent DIDs (never the shared dialer
 * pool — a pool number's texts belong to whichever rep the callback rules
 * would route them to at the time, which this script cannot reconstruct).
 * Every row is stamped backfill=true and a batch_id shared by this run, and
 * inserted with bare ON CONFLICT DO NOTHING — safe to re-run; an already-
 * stored MessageSid is a no-op.
 *
 * DRY RUN BY DEFAULT: counts only — how many inbound texts Twilio has for
 * this rep's numbers since the date, how many are already stored, how many
 * are new. NEVER prints a message body, in a dry run or otherwise.
 *
 * Usage (needs BOTH a reachable Postgres AND Twilio creds — run via the API
 * service, which holds both):
 *   railway run -s @cti/api node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01
 *   railway run -s @cti/api node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01 --apply
 *   railway run -s @cti/api node scripts/backfill-texts.mjs --user-id <uuid> --since 2026-09-01 --apply
 *
 * Env: DATABASE_PUBLIC_URL (preferred) or DATABASE_URL — see set-sms-webhooks.mjs's
 * header for why DATABASE_PUBLIC_URL is preferred when run via `railway run`.
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — the @cti/api service's own variables.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import twilio from 'twilio';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Parses and validates argv. Throws (never `process.exit`s) so `main()` alone
 *  owns the exit code — keeps this directly unit-testable. */
export function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const email = argValue(argv, 'email') ?? null;
  const userId = argValue(argv, 'user-id') ?? null;
  const since = argValue(argv, 'since') ?? null;
  if (!email && !userId) throw new Error('--email <rep email> or --user-id <id> is required');
  if (email && userId) throw new Error('pass --email OR --user-id, not both');
  if (!since || !ISO_DATE_RE.test(since)) throw new Error('--since YYYY-MM-DD is required');
  return { apply, email, userId, since };
}

/** Twilio's own outbound-reply/outbound-api directions must never be
 *  backfilled as if a customer sent them. */
export function isInboundMessage(message) {
  return message.direction === 'inbound';
}

/** Pure transform: one Twilio Message resource -> one inbound_messages row's
 *  values, ready for insertBackfillRow. Never touches the network or the DB. */
export function toInsertRow(message, ctx) {
  const numMedia = Number.parseInt(message.numMedia ?? '', 10);
  return {
    orgId: ctx.orgId,
    messageSid: message.sid,
    fromE164: message.from,
    toE164: message.to,
    body: message.body ?? '',
    numMedia: Number.isFinite(numMedia) && numMedia > 0 ? numMedia : 0,
    userId: ctx.userId,
    backfillBatch: ctx.batchId,
    receivedAt: message.dateSent instanceof Date ? message.dateSent : new Date(message.dateSent),
  };
}

export const SELECT_AGENT_DIDS_SQL = `select id, e164, org_id from outbound_numbers
   where kind = 'agent' and assigned_user_id = $1`;

export const INSERT_ROW_SQL = `insert into inbound_messages
    (org_id, message_sid, from_e164, to_e164, body, num_media, user_id, status, backfill, backfill_batch, received_at)
  values ($1, $2, $3, $4, $5, $6, $7, 'pending', true, $8, $9)
  on conflict do nothing`;

export const SELECT_EXISTING_SIDS_SQL = `select message_sid from inbound_messages where message_sid = any($1)`;

/** Resolves the target rep by email or id — never both (parseArgs already
 *  enforces that). Throws a clear, named error on a miss so a typo'd email
 *  never silently backfills nothing. */
export async function resolveRep(client, { email, userId }) {
  const { rows } = email
    ? await client.query('select id, email from users where email = $1', [email])
    : await client.query('select id, email from users where id = $1', [userId]);
  if (!rows[0]) throw new Error(`No user ${email ?? userId}`);
  return rows[0];
}

/** This rep's OWN agent DIDs — never the shared dialer pool (see the module
 *  doc comment for why). */
export async function agentDidsForRep(client, repId) {
  return (await client.query(SELECT_AGENT_DIDS_SQL, [repId])).rows;
}

/** Idempotent insert. Returns true only when THIS call's row actually landed
 *  (rowCount 1) — false means the MessageSid was already stored, a safe no-op
 *  on a re-run. */
export async function insertBackfillRow(client, row) {
  const r = await client.query(INSERT_ROW_SQL, [
    row.orgId, row.messageSid, row.fromE164, row.toE164, row.body, row.numMedia, row.userId, row.backfillBatch, row.receivedAt,
  ]);
  return r.rowCount > 0;
}

/** Which of these message_sids are already stored — for an accurate dry-run
 *  count without writing anything. */
export async function existingSids(client, sids) {
  if (sids.length === 0) return new Set();
  const { rows } = await client.query(SELECT_EXISTING_SIDS_SQL, [sids]);
  return new Set(rows.map((r) => r.message_sid));
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    die(`${err.message}\n\nUsage: node scripts/backfill-texts.mjs --email <rep email> | --user-id <id> --since YYYY-MM-DD [--apply]`);
    return;
  }
  const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!DB_URL) die('No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s @cti/api`, or export DATABASE_PUBLIC_URL from the Postgres service).');
  if (!ACCOUNT || !TOKEN) die('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');

  console.log(args.apply ? '*** --apply — WILL INSERT ROWS ***' : '--- DRY RUN (no writes). Pass --apply to insert. ---');

  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const rep = await resolveRep(client, args);
    const dids = await agentDidsForRep(client, rep.id);
    if (dids.length === 0) {
      console.log(`${rep.email} has no agent numbers — nothing to backfill.`);
      return;
    }
    console.log(`${rep.email}: ${dids.length} agent DID(s), pulling inbound texts since ${args.since}...`);

    const twilioClient = twilio(ACCOUNT, TOKEN);
    const batchId = randomUUID();
    const dateSentAfter = new Date(`${args.since}T00:00:00Z`);
    const rows = [];
    for (const did of dids) {
      const messages = await twilioClient.messages.list({ to: did.e164, dateSentAfter });
      const inbound = messages.filter(isInboundMessage);
      for (const m of inbound) rows.push(toInsertRow(m, { orgId: did.org_id, userId: rep.id, batchId }));
      console.log(`  ${did.e164}: ${inbound.length} inbound text(s)`);
    }

    const sids = rows.map((r) => r.messageSid);
    const already = await existingSids(client, sids);
    const newRows = rows.filter((r) => !already.has(r.messageSid));
    console.log(`\n${rows.length} inbound text(s) found total, ${already.size} already stored, ${newRows.length} new.`);

    if (!args.apply) {
      console.log(`\nDRY RUN — re-run with --apply to insert ${newRows.length} row(s) (batch would be ${batchId}).`);
      return;
    }
    if (newRows.length === 0) {
      console.log('\nNothing new to insert.');
      return;
    }

    let inserted = 0;
    for (const row of newRows) {
      if (await insertBackfillRow(client, row)) inserted++;
    }
    console.log(`\nInserted ${inserted}/${newRows.length} row(s), batch ${batchId}.`);
    console.log('The worker creates each Task on its next tick, then sends ONE digest email once the whole batch is done.');
  } finally {
    await client.end();
  }
}

// Only run against a real database/Twilio when this file is executed directly
// (`node scripts/backfill-texts.mjs`) — never on import, so the pure helpers
// above can be unit-tested without DATABASE_URL, Twilio creds, or a live DB.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

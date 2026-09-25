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
 * Pick --since AFTER the number's last reassignment to a different rep, or
 * this credits texts to whoever holds the number today even if they arrived
 * while someone else owned it.
 *
 * Every row is stamped backfill=true and a batch_id shared by this run, and
 * ALL of a run's rows are inserted in ONE transaction (insertBackfillBatch) —
 * the worker must never see a half-inserted batch: if it did, it could see
 * every row it has so far as terminal and send the digest before the rest of
 * the batch even exists, and a backfilled row never gets an individual
 * alert, so those later texts would get their Task but no notice at all.
 * Idempotent regardless: ON CONFLICT DO NOTHING (bare — the unique index on
 * message_sid is FULL, see migration 0044) means a re-run after a failed
 * attempt only inserts what's still missing.
 *
 * DRY RUN BY DEFAULT: counts only — how many inbound texts Twilio has for
 * this rep's numbers since the date, how many are already stored, how many
 * are new. NEVER prints a message body, in a dry run, on success, or on an
 * error (see `safeErrorMessage` — an unexpected Postgres error's `detail`
 * can quote the failing row, so only `.message`/`.code` are ever surfaced).
 *
 * Usage (needs BOTH a reachable Postgres AND Twilio creds — run via the API
 * service, which holds both). `railway run -s @cti/api` injects that
 * service's own PRIVATE DATABASE_URL, whose host only resolves inside
 * Railway's network, so pull the PUBLIC one from the Postgres service first
 * and pass it explicitly (matches docs/runbooks/inbound-texts.md and the
 * sibling runbooks, e.g. number-fleet.md):
 *   cd services/cti-api
 *   PUB=$(railway variables -s Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)
 *   railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01
 *   railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/backfill-texts.mjs --email garrett@gghomes.org --since 2026-09-01 --apply
 *
 * Env: DATABASE_PUBLIC_URL (preferred) or DATABASE_URL — see above.
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

/** Parses and validates argv. Throws (never `process.exit`s) so `run()` alone
 *  decides how to report it — keeps this directly unit-testable. */
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
 *  values, ready for insertBackfillBatch. Never touches the network or the DB. */
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

/** Only THIS rep's OWN agent DIDs — never the shared dialer pool (see the
 *  module doc comment for why). */
export const SELECT_AGENT_DIDS_SQL = `select id, e164, org_id from outbound_numbers
   where kind = 'agent' and assigned_user_id = $1`;

export const INSERT_ROW_SQL = `insert into inbound_messages
    (org_id, message_sid, from_e164, to_e164, body, num_media, user_id, status, backfill, backfill_batch, received_at)
  values ($1, $2, $3, $4, $5, $6, $7, 'pending', true, $8, $9)
  on conflict do nothing`;

export const SELECT_EXISTING_SIDS_SQL = `select message_sid from inbound_messages where message_sid = any($1)`;

/** Reduces an error to what is safe to print: never `.detail` (a Postgres
 *  constraint violation quotes the failing row — the private message body,
 *  here) and never the whole error object. */
export function safeErrorMessage(err) {
  const message = err?.message ?? String(err);
  const code = err?.code;
  return code ? `${message} (code ${code})` : message;
}

/** Resolves the target rep by email or id — never both (parseArgs already
 *  enforces that). Throws a clear, named error on a miss so a typo'd email
 *  never silently backfills nobody. */
export async function resolveRep(db, { email, userId }) {
  const { rows } = email
    ? await db.query('select id, email from users where email = $1', [email])
    : await db.query('select id, email from users where id = $1', [userId]);
  if (!rows[0]) throw new Error(`No user ${email ?? userId}`);
  return rows[0];
}

/** This rep's OWN agent DIDs. */
export async function agentDidsForRep(db, repId) {
  return (await db.query(SELECT_AGENT_DIDS_SQL, [repId])).rows;
}

/** Which of these message_sids are already stored — for an accurate dry-run
 *  count without writing anything. */
export async function existingSids(db, sids) {
  if (sids.length === 0) return new Set();
  const { rows } = await db.query(SELECT_EXISTING_SIDS_SQL, [sids]);
  return new Set(rows.map((r) => r.message_sid));
}

/**
 * I1: all of a run's new rows, inserted in ONE transaction. Returns the
 * number actually inserted (a row ON CONFLICT DO NOTHING skipped doesn't
 * count). On ANY failure mid-loop, rolls back — the caller must never see or
 * report a partial count, and the worker must never see a half-inserted
 * batch (see the module doc comment for why that matters: an early digest
 * that permanently skips the still-uninserted rows' individual alerts,
 * because backfilled rows never get one).
 */
export async function insertBackfillBatch(db, rows) {
  await db.query('BEGIN');
  try {
    let inserted = 0;
    for (const row of rows) {
      const r = await db.query(INSERT_ROW_SQL, [
        row.orgId, row.messageSid, row.fromE164, row.toE164, row.body,
        row.numMedia, row.userId, row.backfillBatch, row.receivedAt,
      ]);
      if (r.rowCount > 0) inserted++;
    }
    await db.query('COMMIT');
    return inserted;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

/**
 * The whole run, deps-injected so it's testable without a real database or
 * Twilio account (I3). `deps.db` is a connected pg-client-shaped object
 * (`.query(sql, params)`); `deps.twilio` is a Twilio SDK client
 * (`.messages.list(...)`); `deps.stdout`/`deps.stderr` default to
 * console.log/console.error; `deps.newBatchId` defaults to `randomUUID`
 * (overridable so a test can assert on a known batch id).
 */
export async function run(argv, deps) {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const newBatchId = deps.newBatchId ?? randomUUID;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr(`ERROR: ${err.message}`);
    stderr('Usage: node scripts/backfill-texts.mjs --email <rep email> | --user-id <id> --since YYYY-MM-DD [--apply]');
    return { exitCode: 1 };
  }

  stdout(args.apply ? '*** --apply — WILL INSERT ROWS ***' : '--- DRY RUN (no writes). Pass --apply to insert. ---');

  const rep = await resolveRep(deps.db, args);
  const dids = await agentDidsForRep(deps.db, rep.id);
  if (dids.length === 0) {
    stdout(`${rep.email} has no agent numbers — nothing to backfill.`);
    return { exitCode: 0 };
  }
  stdout(`${rep.email}: ${dids.length} agent DID(s), pulling inbound texts since ${args.since}...`);

  const batchId = newBatchId();
  const dateSentAfter = new Date(`${args.since}T00:00:00Z`);
  const rows = [];
  for (const did of dids) {
    const messages = await deps.twilio.messages.list({ to: did.e164, dateSentAfter });
    const inbound = messages.filter(isInboundMessage);
    for (const m of inbound) rows.push(toInsertRow(m, { orgId: did.org_id, userId: rep.id, batchId }));
    stdout(`  ${did.e164}: ${inbound.length} inbound text(s)`);
  }

  const sids = rows.map((r) => r.messageSid);
  const already = await existingSids(deps.db, sids);
  const newRows = rows.filter((r) => !already.has(r.messageSid));
  stdout(`\n${rows.length} inbound text(s) found total, ${already.size} already stored, ${newRows.length} new.`);

  if (!args.apply) {
    stdout(
      newRows.length > 0
        ? `\nDRY RUN — re-run with --apply to insert ${newRows.length} row(s). A new batch id is assigned on --apply.`
        : '\nDRY RUN — nothing new to insert.',
    );
    return { exitCode: 0 };
  }
  if (newRows.length === 0) {
    stdout('\nNothing new to insert.');
    return { exitCode: 0 };
  }

  let inserted;
  try {
    inserted = await insertBackfillBatch(deps.db, newRows);
  } catch (err) {
    stderr(`ERROR: insert failed, rolled back — nothing from this run was stored: ${safeErrorMessage(err)}`);
    return { exitCode: 1 };
  }
  stdout(`\nInserted ${inserted}/${newRows.length} row(s), batch ${batchId}.`);
  stdout('The worker creates each Task on its next tick, then sends ONE digest email once the whole batch is done.');
  return { exitCode: 0 };
}

async function main() {
  const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  if (!DB_URL) {
    console.error('ERROR: No DATABASE_PUBLIC_URL / DATABASE_URL (run via `railway run -s @cti/api`, or export DATABASE_PUBLIC_URL from the Postgres service).');
    process.exitCode = 1;
    return;
  }
  if (!ACCOUNT || !TOKEN) {
    console.error('ERROR: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');
    process.exitCode = 1;
    return;
  }

  const db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const result = await run(process.argv.slice(2), { db, twilio: twilio(ACCOUNT, TOKEN) });
    process.exitCode = result?.exitCode ?? 0;
  } finally {
    await db.end();
  }
}

// Only run against a real database/Twilio when this file is executed directly
// (`node scripts/backfill-texts.mjs`) — never on import, so the pure helpers
// above can be unit-tested without DATABASE_URL, Twilio creds, or a live DB.
const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    // Top-level catch: only .message/.code ever reach the terminal, never
    // `.detail` (which can quote a failing row) or the raw error object.
    console.error(`ERROR: ${safeErrorMessage(err)}`);
    process.exitCode = 1;
  });
}

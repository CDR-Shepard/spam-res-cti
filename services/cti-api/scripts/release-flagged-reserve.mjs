#!/usr/bin/env node
/**
 * Release NV-flagged, never-assigned reserve DIDs (the buy→screen→release loop's
 * final step, ruling 2026-08-26): numbers bought into 'Agent Reserve *', flagged
 * spam_likely by NumberVerifier's first device-check sweep BEFORE any rep ever
 * dialed from them. Releasing on Twilio stops their monthly billing; the DB row
 * is kept (active=false) as the permanent record that the e164 was screened out,
 * so a future buy of the same number is visible as a re-acquisition.
 *
 * Scope guard: ONLY kind='agent' AND assigned_user_id IS NULL AND health='spam_likely'
 * AND label LIKE 'Agent Reserve%'. Assigned numbers, pool numbers, and healthy
 * reserve are untouchable by construction.
 *
 * Usage (needs Twilio creds AND the prod DB):
 *   railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/release-flagged-reserve.mjs           # dry run
 *   railway run -s @cti/api -- env DATABASE_URL="$PUB" node scripts/release-flagged-reserve.mjs --apply   # releases
 */
import pg from 'pg';

const APPLY = process.argv.includes('--apply');
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const SID = process.env.TWILIO_ACCOUNT_SID;
const TOK = process.env.TWILIO_AUTH_TOKEN;
if (!DB_URL) { console.error('no DB url'); process.exit(1); }
if (APPLY && (!SID || !TOK)) { console.error('no Twilio creds (run via railway run -s @cti/api)'); process.exit(1); }

const auth = 'Basic ' + Buffer.from(`${SID}:${TOK}`).toString('base64');
const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  const rows = (
    await client.query(
      `select id, e164, twilio_sid from outbound_numbers
       where kind = 'agent' and assigned_user_id is null and active
         and health = 'spam_likely' and label like 'Agent Reserve%'
       order by e164`,
    )
  ).rows;
  console.log(`${rows.length} flagged reserve number(s) to release.`);
  let released = 0;
  let failed = 0;
  for (const n of rows) {
    if (!APPLY) { console.log(`PLAN  release ${n.e164} (${n.twilio_sid})`); continue; }
    if (!n.twilio_sid) { console.warn(`SKIP ${n.e164}: no twilio_sid on row`); failed++; continue; }
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/${n.twilio_sid}.json`,
      { method: 'DELETE', headers: { authorization: auth } },
    );
    // 404 = already gone on Twilio; still deactivate our row so the fleet view agrees.
    if (res.status === 204 || res.status === 404) {
      await client.query(`update outbound_numbers set active = false where id = $1`, [n.id]);
      console.log(`RELEASED ${n.e164}${res.status === 404 ? ' (was already gone on Twilio)' : ''}`);
      released++;
    } else {
      const body = await res.text();
      console.error(`FAIL ${n.e164}: ${res.status} ${body.slice(0, 150)}`);
      failed++;
    }
  }
  if (APPLY) console.log(`\nreleased ${released}, failed ${failed}, of ${rows.length}`);
  else console.log('\nDRY RUN — re-run with --apply to release.');
  if (failed > 0) process.exit(1);
} finally {
  await client.end();
}

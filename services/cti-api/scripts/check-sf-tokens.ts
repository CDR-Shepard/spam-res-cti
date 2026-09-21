#!/usr/bin/env npx tsx
/**
 * Does each rep's Salesforce connection actually WORK — not merely exist?
 *
 * A `salesforce_connections` row proves only that the rep connected once. The
 * refresh token behind it can be dead (revoked, password policy, session policy)
 * and nothing shows it until their next call fails to log after eight retries —
 * which is how Deivid Lopez sat "connected" for days with an `invalid_grant`.
 *
 * This makes ONE read-only call per rep through the app's own client
 * (`GET /chatter/users/me`), exactly what the softphone does on every dial. A
 * stale access token is refreshed and persisted, as it would be in normal use;
 * nothing else is written. Prints a status per rep and never a secret.
 *
 *   CTI_DB_URL=<public db url> railway run -s @cti/api npx tsx services/cti-api/scripts/check-sf-tokens.ts [email …]
 *
 * `railway run -s @cti/api` supplies TOKEN_ENCRYPTION_KEY and the OAuth client,
 * but also injects that service's internal DATABASE_URL, unreachable from a
 * laptop — so CTI_DB_URL is copied over it BEFORE the db module loads.
 */
if (process.env.CTI_DB_URL) process.env.DATABASE_URL = process.env.CTI_DB_URL;

const { getDb, getPool, schema } = await import('@cti/db');
const { sfFetch } = await import('../src/salesforce/client.js');
const { eq } = await import('drizzle-orm');

const only = process.argv.slice(2).map((e) => e.toLowerCase());
const db = getDb();
const users = (await db.select({ id: schema.users.id, email: schema.users.email, name: schema.users.displayName })
  .from(schema.users).where(eq(schema.users.kind, 'human')))
  .filter((u) => only.length === 0 || only.includes(u.email.toLowerCase()))
  .sort((a, b) => a.email.localeCompare(b.email));

let bad = 0;
for (const u of users) {
  const conn = await db.query.salesforceConnections.findFirst({
    where: eq(schema.salesforceConnections.userId, u.id), columns: { id: true },
  });
  if (!conn) { bad++; console.log(`${(u.name ?? u.email).padEnd(28)} NO CONNECTION — must sign in with Salesforce`); continue; }
  try {
    const res = await sfFetch(u.id, '/chatter/users/me');
    if (res.status < 400) console.log(`${(u.name ?? u.email).padEnd(28)} OK (${res.status})`);
    else { bad++; console.log(`${(u.name ?? u.email).padEnd(28)} FAILED (${res.status}) — must sign in again`); }
  } catch (err) {
    bad++;
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 90);
    console.log(`${(u.name ?? u.email).padEnd(28)} DEAD TOKEN — must sign in again  [${msg}]`);
  }
}
console.log(`\n${users.length - bad} working, ${bad} need attention.`);
await getPool().end();

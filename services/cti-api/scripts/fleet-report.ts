#!/usr/bin/env npx tsx
/**
 * The sub-project-A acceptance gate: every active number fully provisioned, every rep at 6 LA / 6 SD, pool at 50.
 *
 * Reconciles BOTH directions, because a one-way check cannot see money already spent:
 *   DB → Twilio  every active `outbound_numbers` row must exist in Twilio, carry our
 *                inbound webhook, sit on the business profile + SHAKEN/STIR product,
 *                and have `inbound_enabled` — a number whose webhook is right but whose
 *                flag is off answers carrier reverse-probes with the generic decline.
 *   Twilio → DB  every Twilio number carrying our inbound webhook must have an
 *                `outbound_numbers` row. One that doesn't is an ORPHAN: bought,
 *                billing monthly, answering on our webhook, invisible to the app.
 *                (Twilio numbers on some other webhook are foreign/other-use and
 *                print as UNTRACKED — informational, never a failure.)
 *
 * Tallies count USABLE numbers only (`health` not degraded/spam_likely), so the benched
 * +12137742225 never satisfies one of Matt's six LA slots. Exits 1 on any provisioning ✗,
 * any orphan, any rep below 6/6, or a pool under 50. NumberVerifier enrollment is
 * reported but never fatal — it is a human step in their dashboard.
 */
import pg from 'pg';
import { classifyArea, POOL_TARGET } from '../src/fleet/plan.js';

const PROFILE = 'BUfffd7ec178a44a108e81f2a1e03d0b2d', SHAKEN = 'BU9aacbc2ad2856cd5a8167c8d556d3a16';
const REP_TARGET = 6;
/** A runaway `next_page_url` must fail loudly instead of spinning against Twilio forever. */
const MAX_PAGES = 50;

function die(msg: string): never { console.error(`ERROR: ${msg}`); process.exit(1); }

const ACCOUNT = process.env.TWILIO_ACCOUNT_SID ?? die('TWILIO_ACCOUNT_SID not set — run this via `railway run -s @cti/api`.');
const TOKEN = process.env.TWILIO_AUTH_TOKEN ?? die('TWILIO_AUTH_TOKEN not set — run this via `railway run -s @cti/api`.');
const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');

/** Every REST path embeds the account SID, so error strings carry the path with it redacted — status + path, never the body. */
const safePath = (u: string): string => { try { return new URL(u).pathname.replace(ACCOUNT, '<account>'); } catch { return '<url>'; } };

async function all(url: string, key: string): Promise<any[]> {
  let out: any[] = [], next: string | null = url, pages = 0;
  while (next) {
    if (++pages > MAX_PAGES) throw new Error(`Twilio paging exceeded ${MAX_PAGES} pages for ${safePath(url)} — refusing to loop.`);
    const r = await fetch(next, { headers: { Authorization: auth } });
    if (!r.ok) throw new Error(`Twilio GET ${safePath(next)} → ${r.status}`);
    const j: any = await r.json();
    out = out.concat(j[key] ?? []);
    next = j.meta?.next_page_url ?? (j.next_page_uri ? 'https://api.twilio.com' + j.next_page_uri : null);
  }
  return out;
}

/** An explicitly-passed DATABASE_URL always wins over an inherited DATABASE_PUBLIC_URL. */
const c = new pg.Client({ connectionString: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const db = (await c.query(`select n.e164, n.kind, n.twilio_sid, n.health, n.health_source, n.inbound_enabled, u.email from outbound_numbers n left join users u on u.id = n.assigned_user_id where n.active order by n.kind, u.email nulls last, n.e164`)).rows;
/** EVERY row, active or not: a deliberately deactivated DID we still own is not an orphan. */
const known = new Set<string>((await c.query('select e164 from outbound_numbers')).rows.map((r) => r.e164 as string));
/** The rep roster drives the tally, so a rep holding ZERO numbers prints `0/6 ✗ SHORT` instead of vanishing. */
const roster = (await c.query(`select email from users where email != 'dev@example.com' order by created_at`)).rows.map((r) => r.email as string);
const tw = new Map((await all(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=100`, 'incoming_phone_numbers')).map((n: any) => [n.phone_number, n]));
const inProfile = new Set((await all(`https://trusthub.twilio.com/v1/CustomerProfiles/${PROFILE}/ChannelEndpointAssignments?PageSize=100`, 'results')).map((a: any) => a.channel_endpoint_sid));
const inShaken = new Set((await all(`https://trusthub.twilio.com/v1/TrustProducts/${SHAKEN}/ChannelEndpointAssignments?PageSize=100`, 'results')).map((a: any) => a.channel_endpoint_sid));

const isOurWebhook = (t: any): boolean => /\/telephony\/twilio\/inbound$/.test(t?.voice_url ?? '');
const usable = (health: string): boolean => health !== 'degraded' && health !== 'spam_likely';

let provisionFail = 0;
const perRep = new Map<string, { LA: number; SD: number }>(roster.map((email) => [email, { LA: 0, SD: 0 }]));
for (const n of db) {
  const t: any = tw.get(n.e164);
  // `inbound` is a provisioning check like the rest: a number that answers a
  // carrier reverse-probe with the generic decline instead of the greeting/
  // voicemail flow is NOT fully provisioned, and the DB↔Twilio reconciliation
  // above cannot see it (Twilio's VoiceUrl is correct either way).
  const checks = { db: true, twilio: !!t, webhook: isOurWebhook(t), trusthub: !!t && inProfile.has(t.sid), shaken: !!t && inShaken.has(t.sid), inbound: n.inbound_enabled === true };
  if (Object.values(checks).some((v) => !v)) provisionFail++;
  const area = classifyArea(n.e164);
  const counts = usable(n.health);
  if (counts && n.email && n.kind === 'agent' && area !== 'other') { const p = perRep.get(n.email) ?? { LA: 0, SD: 0 }; p[area]++; perRep.set(n.email, p); }
  console.log([n.e164, n.kind, n.email ?? '-', area, ...Object.entries(checks).map(([k, v]) => `${k}${v ? '✓' : '✗'}`), n.health_source === 'numberverifier' ? 'nv:yes' : 'nv:pending', ...(counts ? [] : [`benched:${n.health} (uncounted)`])].join(' | '));
}

// Reverse reconciliation: Twilio → DB. Numbers we pay for that the app cannot see.
let orphanFail = 0;
for (const [e164, t] of tw) {
  if (known.has(e164)) continue;
  if (isOurWebhook(t)) { orphanFail++; console.log(`ORPHAN ${e164} (${t.sid}) — purchased but never registered`); }
  else console.log(`UNTRACKED ${e164} (${t.sid}) — Twilio-owned, not on our inbound webhook`);
}

let shortFail = 0;
for (const [email, p] of perRep) {
  const ok = p.LA >= REP_TARGET && p.SD >= REP_TARGET;
  if (!ok) shortFail++;
  console.log(`REP ${email}: ${p.LA}/${REP_TARGET} LA, ${p.SD}/${REP_TARGET} SD ${ok ? '✓' : '✗ SHORT'}`);
}
const pool = db.filter((n) => n.kind === 'dialer_pool' && usable(n.health)).length;
const poolOk = pool >= POOL_TARGET;
if (!poolOk) shortFail++;
console.log(`POOL: ${pool}/${POOL_TARGET} ${poolOk ? '✓' : '✗ SHORT'}`);

const fail = provisionFail + orphanFail + shortFail;
console.log(fail ? `FAIL: ${provisionFail} number(s) not fully provisioned, ${orphanFail} orphan(s), ${shortFail} target shortfall(s)` : 'ALL PROVISIONED');
await c.end();
process.exit(fail ? 1 : 0);

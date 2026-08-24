#!/usr/bin/env npx tsx
/**
 * Buy + register the inbound-team fleet (spec docs/superpowers/specs/2026-08-24-inbound-launch-design.md).
 * Two-phase like buy-pool-numbers.mjs: `buy-*` needs Twilio creds (railway run -s @cti/api),
 * `register`/`assign` need the DB (DATABASE_PUBLIC_URL). Hand-off persisted after EVERY purchase.
 * DRY RUN unless CONFIRM_BUY=1.
 *
 *   npx tsx scripts/buy-agent-numbers.ts plan                      # live DB → who needs what (always dry)
 *   CONFIRM_BUY=1 ... buy-rep --email evren@gghomessd.com          # top up one rep to 6 LA / 6 SD
 *   CONFIRM_BUY=1 ... buy-reserve --la 60 --sd 60                  # unassigned hire inventory
 *   CONFIRM_BUY=1 ... buy-pool --count 40                          # pool growth (619/951 mix)
 *   ... register                                                   # insert hand-off into outbound_numbers
 *   ... assign --email newhire@gghomessd.com                       # 6 LA + 6 SD from the reserve → rep
 */
import pg from 'pg';
import { readFileSync, writeFileSync } from 'node:fs';
// LA_CODES/SD_CODES come from src/fleet/plan.ts — the same policy buyPlanForRep
// and classifyArea use, so widening one can never silently desync from the other.
import { buyPlanForRep, LA_CODES, poolBuyCount, SD_CODES } from '../src/fleet/plan.js';

const CONFIRM = process.env.CONFIRM_BUY === '1';
const HANDOFF = process.env.FLEET_OUTFILE || './fleet-buy.json';
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const API_BASE = process.env.POOL_API_BASE || process.env.API_PUBLIC_URL;
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const POOL_CODES = ['619', '951'];

function die(msg: string): never { console.error(`ERROR: ${msg}`); process.exit(1); }
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

const authHeader = () => 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
const twBase = () => `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}`;
async function twGet(path: string) { const res = await fetch(`${twBase()}${path}`, { headers: { authorization: authHeader() } }); const data = await res.json(); if (!res.ok) throw new Error(`Twilio GET ${path} → ${res.status} ${JSON.stringify(data)}`); return data as any; }
async function twPost(path: string, form: Record<string, string>) { const res = await fetch(`${twBase()}${path}`, { method: 'POST', headers: { authorization: authHeader(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }); const data = await res.json(); if (!res.ok) throw new Error(`Twilio POST ${path} → ${res.status} ${JSON.stringify(data)}`); return data as any; }
async function searchAvailable(areaCode: string, count: number): Promise<string[]> {
  const data = await twGet(`/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&PageSize=${Math.max(count, 10)}`);
  return (data.available_phone_numbers ?? []).slice(0, count).map((n: any) => n.phone_number);
}

async function dbClient() { if (!DB_URL) die('No DATABASE_PUBLIC_URL / DATABASE_URL.'); const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }
type BoughtRec = { e164: string; sid: string; kind: 'agent' | 'dialer_pool'; label: string; assignEmail: string | null };

/** Numbers already sitting in the hand-off (bought, not yet `register`ed) matching this kind/owner/label — so a re-run of a buy command tops up rather than re-buying. */
const alreadyBought = (bought: BoughtRec[], kind: BoughtRec['kind'], assignEmail: string | null, label: string): number =>
  bought.filter((b) => b.kind === kind && b.assignEmail === assignEmail && b.label === label).length;

/** Buy `count` numbers spreading across `codes` (first code first; falls through when an area code runs dry). */
async function buyBatch(codes: string[], count: number, kind: BoughtRec['kind'], label: string, assignEmail: string | null, bought: BoughtRec[]): Promise<void> {
  if (!ACCOUNT || !TOKEN) die('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');
  if (!API_BASE || !/^https:\/\//.test(API_BASE)) die('Set POOL_API_BASE to the https prod API base.');
  const voiceUrl = `${API_BASE}/telephony/twilio/inbound`;
  const persist = () => { if (CONFIRM) writeFileSync(HANDOFF, JSON.stringify(bought, null, 2)); };
  let remaining = count;
  for (const code of codes) {
    if (remaining <= 0) break;
    const candidates = await searchAvailable(code, remaining);
    for (const cand of candidates) {
      if (!CONFIRM) { console.log(`[dry-run] would buy ${cand} (${code}) → ${label}`); remaining--; continue; }
      const data = await twPost('/IncomingPhoneNumbers.json', { PhoneNumber: cand, VoiceUrl: voiceUrl, VoiceMethod: 'POST', FriendlyName: label });
      bought.push({ e164: data.phone_number, sid: data.sid, kind, label, assignEmail });
      console.log(`BOUGHT ${data.phone_number} (${data.sid}) → ${label}`);
      persist(); remaining--;
    }
  }
  if (remaining > 0) console.warn(`WARN: ${remaining} of ${count} unfilled for "${label}" — area codes exhausted; re-run later or widen codes.`);
}

async function repHoldings(c: pg.Client, email: string) {
  const u = await c.query('select id from users where email = $1', [email]);
  if (u.rowCount === 0) die(`No user ${email}`);
  const rows = await c.query(`select e164, health, active from outbound_numbers where assigned_user_id = $1 and kind = 'agent'`, [u.rows[0].id]);
  return { userId: u.rows[0].id as string, holdings: rows.rows as { e164: string; health: string; active: boolean }[] };
}

async function cmdPlan() {
  const c = await dbClient();
  try {
    let agents = 0;
    for (const email of (await c.query(`select email from users where email != 'dev@example.com' order by created_at`)).rows.map((r) => r.email as string)) {
      const { holdings } = await repHoldings(c, email);
      const p = buyPlanForRep(holdings);
      agents += p.la + p.sd;
      console.log(`${email}: holds ${holdings.filter((h) => h.active && h.health !== 'degraded' && h.health !== 'spam_likely').length} usable → buy ${p.la} LA + ${p.sd} SD`);
    }
    const pool = (await c.query(`select count(*)::int n from outbound_numbers where kind = 'dialer_pool' and active`)).rows[0].n;
    const poolBuy = poolBuyCount(pool);
    console.log(`pool: ${pool} active → buy ${poolBuy}`);
    console.log(`reserve suggestion: 10 hires × (6 LA + 6 SD) = 60 LA + 60 SD`);
    console.log(`TOTAL (with reserve 120): ${agents + poolBuy + 120}`);
  } finally { await c.end(); }
}

async function cmdBuyRep(email: string) {
  const c = await dbClient();
  try {
    const { holdings } = await repHoldings(c, email);
    const p = buyPlanForRep(holdings);
    const bought: BoughtRec[] = existingHandoff();
    const tag = email.split('@')[0];
    const laLabel = `Agent ${tag} LA`;
    const sdLabel = `Agent ${tag} SD`;
    // Subtract numbers this same command already bought into the hand-off but
    // that `register` hasn't consumed yet, so a re-run tops up instead of re-buying.
    const laAlready = alreadyBought(bought, 'agent', email, laLabel);
    const sdAlready = alreadyBought(bought, 'agent', email, sdLabel);
    const la = Math.max(0, p.la - laAlready);
    const sd = Math.max(0, p.sd - sdAlready);
    console.log(`${email}: buying ${la} LA + ${sd} SD` + (laAlready || sdAlready ? ` (hand-off already holds ${laAlready} LA + ${sdAlready} SD unregistered)` : ''));
    await buyBatch(LA_CODES, la, 'agent', laLabel, email, bought);
    await buyBatch(SD_CODES, sd, 'agent', sdLabel, email, bought);
  } finally { await c.end(); }
}

const existingHandoff = (): BoughtRec[] => {
  let raw: string;
  try { raw = readFileSync(HANDOFF, 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { die(`Hand-off ${HANDOFF} is corrupt (invalid JSON) — restore it from backup or the Twilio console before buying or registering again.`); }
  if (!Array.isArray(parsed)) die(`Hand-off ${HANDOFF} is corrupt (not an array) — restore it from backup or the Twilio console before buying or registering again.`);
  return parsed as BoughtRec[];
};

async function cmdBuyReserve(la: number, sd: number) {
  const bought = existingHandoff();
  const laAlready = alreadyBought(bought, 'agent', null, 'Agent Reserve LA');
  const sdAlready = alreadyBought(bought, 'agent', null, 'Agent Reserve SD');
  const laToBuy = Math.max(0, la - laAlready);
  const sdToBuy = Math.max(0, sd - sdAlready);
  if (laAlready || sdAlready) console.log(`hand-off already holds ${laAlready} LA + ${sdAlready} SD unregistered reserve numbers → buying ${laToBuy} LA + ${sdToBuy} SD more`);
  await buyBatch(LA_CODES, laToBuy, 'agent', 'Agent Reserve LA', null, bought);
  await buyBatch(SD_CODES, sdToBuy, 'agent', 'Agent Reserve SD', null, bought);
}

async function cmdBuyPool(count: number) {
  const bought = existingHandoff();
  const already = alreadyBought(bought, 'dialer_pool', null, 'Dialer Pool');
  const toBuy = Math.max(0, count - already);
  if (already) console.log(`hand-off already holds ${already} unregistered pool numbers → buying ${toBuy} more`);
  await buyBatch(POOL_CODES, toBuy, 'dialer_pool', 'Dialer Pool', null, bought);
}

async function cmdRegister() {
  const bought = existingHandoff();
  if (bought.length === 0) die(`Hand-off ${HANDOFF} empty — run a buy with CONFIRM_BUY=1 first.`);
  const c = await dbClient();
  try {
    const org = (await c.query('select id from organizations order by created_at asc limit 1')).rows[0];
    const summary: Array<Record<string, string>> = [];
    for (const rec of bought) {
      let userId: string | null = null;
      if (rec.assignEmail) { const u = await c.query('select id from users where email = $1', [rec.assignEmail]); if (u.rowCount === 0) die(`No user ${rec.assignEmail}`); userId = u.rows[0].id; }
      const dup = await c.query('select id from outbound_numbers where e164 = $1', [rec.e164]);
      if (dup.rowCount) { summary.push({ e164: rec.e164, registered: 'dup' }); continue; }
      await c.query(
        `insert into outbound_numbers (org_id, e164, label, provider, active, twilio_sid, kind, inbound_enabled, assigned_user_id)
         values ($1,$2,$3,'twilio',true,$4,$5,true,$6)`,
        [org.id, rec.e164, rec.label, rec.sid, rec.kind, userId],
      );
      summary.push({ e164: rec.e164, registered: rec.kind + (userId ? `→${rec.assignEmail}` : ' (reserve)') });
    }
    console.table(summary);
  } finally { await c.end(); }
}

async function cmdAssign(email: string) {
  const c = await dbClient();
  try {
    const { userId, holdings } = await repHoldings(c, email);
    const need = buyPlanForRep(holdings);
    for (const [cls, n] of [['LA', need.la], ['SD', need.sd]] as const) {
      if (n === 0) continue;
      const codes = cls === 'LA' ? LA_CODES : SD_CODES;
      const free = await c.query(
        `select id, e164 from outbound_numbers
         where kind = 'agent' and assigned_user_id is null and active and health not in ('degraded','spam_likely')
           and substring(e164 from 3 for 3) = any($1) order by e164 limit $2`,
        [codes, n],
      );
      if (free.rowCount! < n) console.warn(`WARN: reserve has ${free.rowCount}/${n} free ${cls} numbers — buy more reserve.`);
      for (const row of free.rows) {
        await c.query('update outbound_numbers set assigned_user_id = $1, label = $2 where id = $3', [userId, `Agent ${email.split('@')[0]} ${cls}`, row.id]);
        console.log(`ASSIGNED ${row.e164} → ${email}`);
      }
    }
  } finally { await c.end(); }
}

const cmd = process.argv[2];
if (cmd === 'plan') await cmdPlan();
else if (cmd === 'buy-rep') await cmdBuyRep(arg('email') ?? die('--email required'));
else if (cmd === 'buy-reserve') await cmdBuyReserve(Number(arg('la') ?? die('--la required')), Number(arg('sd') ?? die('--sd required')));
else if (cmd === 'buy-pool') await cmdBuyPool(Number(arg('count') ?? die('--count required')));
else if (cmd === 'register') await cmdRegister();
else if (cmd === 'assign') await cmdAssign(arg('email') ?? die('--email required'));
else die('command: plan | buy-rep | buy-reserve | buy-pool | register | assign');

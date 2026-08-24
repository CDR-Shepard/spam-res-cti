#!/usr/bin/env npx tsx
/**
 * Buy + register the inbound-team fleet (spec docs/superpowers/specs/2026-08-24-inbound-launch-design.md).
 * Two-phase like buy-pool-numbers.mjs: `buy-*` needs Twilio creds (railway run -s @cti/api),
 * `register`/`assign` need the DB (DATABASE_URL, else DATABASE_PUBLIC_URL). Hand-off persisted after EVERY purchase.
 * DRY RUN unless CONFIRM_BUY=1.
 *
 * EVERY `buy-*` count is a TARGET, never an increment. Each command reads live DB
 * state first and subtracts both what the DB already holds and what a prior run
 * bought into the hand-off but hasn't `register`ed yet, then buys only the
 * shortfall — so re-running the same command (including after `register` pruned
 * the hand-off) buys nothing further and can never double-spend.
 *
 *   npx tsx scripts/buy-agent-numbers.ts plan                      # live DB → who needs what (always dry)
 *   CONFIRM_BUY=1 ... buy-rep --email evren@gghomessd.com          # top rep up TO 6 LA / 6 SD (buys the shortfall)
 *   CONFIRM_BUY=1 ... buy-reserve --la 60 --sd 60                  # free hire reserve should REACH 60 LA / 60 SD
 *   CONFIRM_BUY=1 ... buy-pool --count 40                          # grow pool toward 50 (619/951 mix), max 40 this run
 *   ... register                                                   # insert hand-off into outbound_numbers
 *   ... assign --email newhire@gghomessd.com                       # 6 LA + 6 SD from the reserve → rep
 */
import pg from 'pg';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
// LA_CODES/SD_CODES come from src/fleet/plan.ts — the same policy buyPlanForRep
// and classifyArea use, so widening one can never silently desync from the other.
import { buyPlanForRep, LA_CODES, POOL_TARGET, poolBuyCount, poolBuyTarget, reserveBuyTarget, SD_CODES, splitEvenly } from '../src/fleet/plan.js';

const CONFIRM = process.env.CONFIRM_BUY === '1';
// Script-relative, NOT cwd-relative: the hand-off is the only local record of
// numbers already charged to the account, so running the script from a different
// directory must find the same file rather than silently start an empty one.
const HANDOFF = process.env.FLEET_OUTFILE || new URL('../fleet-buy.json', import.meta.url).pathname;
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const API_BASE = process.env.POOL_API_BASE || process.env.API_PUBLIC_URL;
// An explicitly-passed DATABASE_URL always wins over an inherited DATABASE_PUBLIC_URL:
// every runbook command overrides DATABASE_URL, and that override must be authoritative.
const DB_URL = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
/** The pool is deliberately a 619/951 mix; buys split evenly between them. */
const POOL_PRIMARY = '619';
const POOL_SECONDARY = '951';
/** Nobody buys more than this many billable numbers in one command. */
const MAX_BATCH = 200;

function die(msg: string): never { console.error(`ERROR: ${msg}`); process.exit(1); }
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
/** `--la`/`--sd`/`--count` are counts of real, billable numbers: whole, non-negative, sane. */
const intArg = (name: string): number => {
  const raw = arg(name);
  if (raw === undefined) die(`--${name} required`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_BATCH) die(`--${name} must be a whole number between 0 and ${MAX_BATCH} (got "${raw}") — it is a count of billable numbers.`);
  return n;
};

const authHeader = () => 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
const twBase = () => `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}`;
async function twGet(path: string) { const res = await fetch(`${twBase()}${path}`, { headers: { authorization: authHeader() } }); const data = await res.json(); if (!res.ok) throw new Error(`Twilio GET ${path} → ${res.status} ${JSON.stringify(data)}`); return data as any; }
async function twPost(path: string, form: Record<string, string>) { const res = await fetch(`${twBase()}${path}`, { method: 'POST', headers: { authorization: authHeader(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() }); const data = await res.json(); if (!res.ok) throw new Error(`Twilio POST ${path} → ${res.status} ${JSON.stringify(data)}`); return data as any; }
async function searchAvailable(areaCode: string, count: number): Promise<string[]> {
  const data = await twGet(`/AvailablePhoneNumbers/US/Local.json?AreaCode=${areaCode}&VoiceEnabled=true&PageSize=${Math.max(count, 10)}`);
  return (data.available_phone_numbers ?? []).slice(0, count).map((n: any) => n.phone_number);
}

async function dbClient() { if (!DB_URL) die('No DATABASE_URL / DATABASE_PUBLIC_URL.'); const c = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } }); await c.connect(); return c; }
type BoughtRec = { e164: string; sid: string; kind: 'agent' | 'dialer_pool'; label: string; assignEmail: string | null };

/** Numbers already sitting in the hand-off (bought, not yet `register`ed) matching this kind/owner/label — so a re-run of a buy command tops up rather than re-buying. */
const alreadyBought = (bought: BoughtRec[], kind: BoughtRec['kind'], assignEmail: string | null, label: string): number =>
  bought.filter((b) => b.kind === kind && b.assignEmail === assignEmail && b.label === label).length;

/**
 * Replace the hand-off atomically (write a sibling .tmp, then rename over it).
 * The hand-off is the ONLY local record of numbers already charged to the Twilio
 * account, so a crash mid-write must never leave it truncated.
 */
const writeHandoff = (recs: readonly BoughtRec[]): void => {
  const tmp = `${HANDOFF}.tmp`;
  writeFileSync(tmp, JSON.stringify(recs, null, 2));
  renameSync(tmp, HANDOFF);
};

/** Print the buy/dry-run banner once per process, before the first Twilio call. */
let bannerShown = false;
const preflightBanner = (): void => {
  if (bannerShown) return;
  bannerShown = true;
  console.log(CONFIRM ? '*** CONFIRM_BUY=1 — WILL PURCHASE ***\n' : '--- DRY RUN (no purchase). Set CONFIRM_BUY=1 to buy. ---\n');
};

/** Buy `count` numbers spreading across `codes` (first code first; falls through when an area code runs dry). */
async function buyBatch(codes: string[], count: number, kind: BoughtRec['kind'], label: string, assignEmail: string | null, bought: BoughtRec[]): Promise<void> {
  // Already at target: no Twilio work to do, so don't demand Twilio creds — a
  // fully-satisfied re-run must succeed outside `railway run` too.
  if (count <= 0) { console.log(`nothing to buy for "${label}" — already at target.`); return; }
  preflightBanner();
  if (!ACCOUNT || !TOKEN) die('TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set (run via `railway run -s @cti/api`).');
  if (!API_BASE || !/^https:\/\//.test(API_BASE)) die('Set POOL_API_BASE to the https prod API base.');
  const voiceUrl = `${API_BASE}/telephony/twilio/inbound`;
  const persist = () => { if (CONFIRM) writeHandoff(bought); };
  let remaining = count;
  let prev: string | null = null;
  for (const code of codes) {
    if (remaining <= 0) break;
    if (prev) console.warn(`WARN: area code ${prev} ran dry for "${label}" — falling through to ${code} for the last ${remaining}.`);
    prev = code;
    const candidates = await searchAvailable(code, remaining);
    for (const cand of candidates) {
      if (!CONFIRM) { console.log(`[dry-run] would buy ${cand} (${code}) → ${label}`); remaining--; continue; }
      const data = await twPost('/IncomingPhoneNumbers.json', { PhoneNumber: cand, VoiceUrl: voiceUrl, VoiceMethod: 'POST', FriendlyName: label });
      bought.push({ e164: data.phone_number, sid: data.sid, kind, label, assignEmail });
      console.log(`BOUGHT ${data.phone_number} (${data.sid}) → ${label}`);
      persist(); remaining--;
    }
  }
  if (remaining > 0) console.warn(`WARN: ${remaining} of ${count} unfilled for "${label}" — area codes exhausted (or widen codes); re-run the same command later — it only buys the shortfall.`);
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
    // Purchases sitting unregistered in the hand-off are invisible to every count
    // above (they are not in the DB yet) — surface them so `plan` stays the honest
    // go/no-go the runbook makes it.
    const pending = existingHandoff().length;
    if (pending > 0) console.log(`hand-off: ${pending} purchased awaiting register (excluded from buy targets above)`);
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

/** Free (unassigned, healthy, active) reserve numbers in one area class — the same predicate `assign` draws from. */
async function freeReserve(c: pg.Client, codes: string[]): Promise<number> {
  const r = await c.query(
    `select count(*)::int n from outbound_numbers
     where kind = 'agent' and assigned_user_id is null and active and health not in ('degraded','spam_likely')
       and substring(e164 from 3 for 3) = any($1)`,
    [codes],
  );
  return r.rows[0].n as number;
}

/** `--la`/`--sd` are the sizes the FREE reserve should reach — what's already free in the DB and unregistered in the hand-off counts toward them. */
async function cmdBuyReserve(la: number, sd: number) {
  const bought = existingHandoff();
  let laToBuy = 0;
  let sdToBuy = 0;
  const c = await dbClient();
  try {
    const freeLA = await freeReserve(c, LA_CODES);
    const freeSD = await freeReserve(c, SD_CODES);
    const laAlready = alreadyBought(bought, 'agent', null, 'Agent Reserve LA');
    const sdAlready = alreadyBought(bought, 'agent', null, 'Agent Reserve SD');
    laToBuy = reserveBuyTarget(la, freeLA, laAlready);
    sdToBuy = reserveBuyTarget(sd, freeSD, sdAlready);
    console.log(`reserve LA: ${freeLA} free, target ${la}, hand-off ${laAlready} → buying ${laToBuy}`);
    console.log(`reserve SD: ${freeSD} free, target ${sd}, hand-off ${sdAlready} → buying ${sdToBuy}`);
  } finally { await c.end(); } // released before the Twilio round-trips below
  await buyBatch(LA_CODES, laToBuy, 'agent', 'Agent Reserve LA', null, bought);
  await buyBatch(SD_CODES, sdToBuy, 'agent', 'Agent Reserve SD', null, bought);
}

/** `--count` caps THIS run; the real ceiling is the shortfall toward POOL_TARGET given the live pool + the hand-off. */
async function cmdBuyPool(count: number) {
  const bought = existingHandoff();
  let toBuy = 0;
  const c = await dbClient();
  try {
    const active = (await c.query(`select count(*)::int n from outbound_numbers where kind = 'dialer_pool' and active`)).rows[0].n as number;
    const already = alreadyBought(bought, 'dialer_pool', null, 'Dialer Pool');
    toBuy = poolBuyTarget(count, active, already);
    console.log(`pool: ${active} active, target ${POOL_TARGET}, hand-off ${already} → buying ${toBuy}`);
  } finally { await c.end(); } // released before the Twilio round-trips below
  // Split evenly instead of exhausting 619 first, so a 40-DID batch lands 20/20 and
  // keeps the pool's 619/951 mix. Each half still falls through to the other area
  // code when its own runs dry (that fall-through prints a WARN).
  const [n619, n951] = splitEvenly(toBuy);
  console.log(`pool split: ${n619} from ${POOL_PRIMARY} + ${n951} from ${POOL_SECONDARY}`);
  await buyBatch([POOL_PRIMARY, POOL_SECONDARY], n619, 'dialer_pool', 'Dialer Pool', null, bought);
  if (n951 > 0) await buyBatch([POOL_SECONDARY, POOL_PRIMARY], n951, 'dialer_pool', 'Dialer Pool', null, bought);
}

async function cmdRegister() {
  const bought = existingHandoff();
  if (bought.length === 0) die(`Hand-off ${HANDOFF} empty. If you HAVE bought numbers and lost the hand-off, do NOT re-buy — run fleet-report to reconcile (orphans are listed) and admin import-twilio to recover them.`);
  const c = await dbClient();
  try {
    const org = (await c.query('select id from organizations order by created_at asc limit 1')).rows[0] ?? die('No organizations row — cannot register.');
    const summary: Array<Record<string, string>> = [];
    // Prune the hand-off as we go (dup-skipped records included) so a re-run's
    // idempotency guard (`alreadyBought`) only ever counts genuinely-unregistered
    // purchases. Persist after EVERY record, same discipline as buyBatch, so an
    // interrupted register doesn't lose track of the remainder.
    let remaining = [...bought];
    const persist = () => writeHandoff(remaining);
    for (const rec of bought) {
      let userId: string | null = null;
      if (rec.assignEmail) { const u = await c.query('select id from users where email = $1', [rec.assignEmail]); if (u.rowCount === 0) die(`No user ${rec.assignEmail}`); userId = u.rows[0].id; }
      // Org-scoped, matching the outbound_numbers_org_e164_unique index. A number
      // already on this org is NOT dropped on the floor (it is charged either way):
      // refresh the Twilio SID and fill in only the columns still null, so a human's
      // existing classification/assignment/label is never clobbered.
      const dup = await c.query('select id from outbound_numbers where org_id = $1 and e164 = $2', [org.id, rec.e164]);
      if (dup.rowCount) {
        await c.query(
          `update outbound_numbers
              set twilio_sid = $1,
                  kind = coalesce(kind, $2),
                  assigned_user_id = coalesce(assigned_user_id, $3),
                  label = coalesce(label, $4)
            where id = $5`,
          // kind is NOT NULL in the schema, so its coalesce always keeps the existing
          // value — deliberate: registering must never re-classify a live number.
          [rec.sid, rec.kind, userId, rec.label, dup.rows[0].id],
        );
        summary.push({ e164: rec.e164, registered: 'updated (existing)' });
      } else {
        await c.query(
          `insert into outbound_numbers (org_id, e164, label, provider, active, twilio_sid, kind, inbound_enabled, assigned_user_id)
           values ($1,$2,$3,'twilio',true,$4,$5,true,$6)`,
          [org.id, rec.e164, rec.label, rec.sid, rec.kind, userId],
        );
        summary.push({ e164: rec.e164, registered: rec.kind + (userId ? `→${rec.assignEmail}` : ' (reserve)') });
      }
      remaining = remaining.filter((r) => r !== rec);
      persist();
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
else if (cmd === 'buy-reserve') await cmdBuyReserve(intArg('la'), intArg('sd'));
else if (cmd === 'buy-pool') await cmdBuyPool(intArg('count'));
else if (cmd === 'register') await cmdRegister();
else if (cmd === 'assign') await cmdAssign(arg('email') ?? die('--email required'));
else die('command: plan | buy-rep | buy-reserve | buy-pool | register | assign');

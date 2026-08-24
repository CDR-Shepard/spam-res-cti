# Number Fleet Implementation Plan (Launch sub-project A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-buy, register, protect, and assign the 192 new numbers that give every rep 12 (6 LA / 6 SD), grow the pool to 50, and leave a repeatable one-command path for future hires — ending with a fleet report proving every number is provisioned.

**Architecture:** A tested pure planner (`src/fleet/plan.ts`) computes what to buy from real holdings; thin `tsx` scripts do the side effects in the repo's established two-phase pattern (Twilio creds via `railway run -s @cti/api`, DB via the Postgres public URL) with a persisted hand-off file after every purchase. Trust Hub assignment is the proven idempotent script promoted from scratchpad. NumberVerifier enrollment emits a manifest + runbook (no API key exists in prod — webhook-only integration today).

**Tech Stack:** Node 22 + tsx, Twilio REST (2010-04-01 + trusthub.twilio.com/v1), pg, vitest (pure logic only).

## Global Constraints

- LA = area codes **213, 323**; SD = **619, 858**; per-rep target **6 LA + 6 SD**; pool target **50 total** (40 new; pool buys keep the existing 619/951 mix).
- Purchase totals (pre-buy, user-approved): rep top-ups Evren 7 (6 LA/1 SD), Matt 7 (4/3), Tyler 6 (3/3), Jona 12 (6/6) = **32**; hire reserve **120** (60 LA/60 SD, `kind='agent'`, unassigned); pool **40** → **192**.
- `+12137742225` (health=degraded) is benched: never counted toward Matt's targets, never reactivated.
- The `+12054303297` test DID and `+18665896850` toll-free are `other` — counted toward nothing.
- Numbers classed `other` (not 213/323/619/858) never satisfy an LA/SD target.
- Every script: idempotent re-runs; secrets only via `railway run` env — never printed, never in files; buys are DRY RUN unless `CONFIRM_BUY=1`; the hand-off file is persisted after **every** purchase.
- Fresh numbers: `first_used_at` null (warmup starts at first dial); **no `warmup_override_cap`**.
- Agent numbers register as `kind='agent'`, `inbound_enabled=true`, voice webhook `${API}/telephony/twilio/inbound`; pool as today (`kind='dialer_pool'`, `inbound_enabled=true`).
- Verify each code task with `npm test` + `npm run typecheck` in `services/cti-api`.
- `.claude/launch.json` is an unrelated pre-existing unstaged deletion — never stage, restore, or commit it.

---

### Task 1: Pure fleet planner

**Files:**
- Create: `services/cti-api/src/fleet/plan.ts`, `services/cti-api/src/fleet/plan.test.ts`

**Interfaces:**
- Produces: `type AreaClass = 'LA' | 'SD' | 'other'`; `classifyArea(e164: string): AreaClass`; `interface Holding { e164: string; health: string; active: boolean }`; `buyPlanForRep(holdings: ReadonlyArray<Holding>, target?: { la: number; sd: number }): { la: number; sd: number }` (usable = active AND health not in spam_likely/degraded; default target 6/6; never negative); `poolBuyCount(existingActivePool: number, target?: number): number` (default 50).

- [ ] **Step 1: Failing test** — `plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buyPlanForRep, classifyArea, poolBuyCount } from './plan.js';

describe('classifyArea', () => {
  it('maps LA (213/323), SD (619/858), everything else other', () => {
    expect(classifyArea('+12137744220')).toBe('LA');
    expect(classifyArea('+13235249247')).toBe('LA');
    expect(classifyArea('+16193507799')).toBe('SD');
    expect(classifyArea('+18584221927')).toBe('SD');
    expect(classifyArea('+12054303297')).toBe('other'); // owned test DID
    expect(classifyArea('+18665896850')).toBe('other'); // toll-free
  });
});

const h = (e164: string, health = 'unknown', active = true) => ({ e164, health, active });

describe('buyPlanForRep — the four real reps', () => {
  it('Evren: 5 SD held → buy 6 LA + 1 SD', () => {
    expect(buyPlanForRep([h('+16193507799'), h('+16193693324'), h('+16198153354'), h('+16198536881'), h('+18587589687')])).toEqual({ la: 6, sd: 1 });
  });
  it('Matt: degraded 213 does NOT count → buy 4 LA + 3 SD', () => {
    expect(buyPlanForRep([h('+12137544220'), h('+12137742225', 'degraded'), h('+13235249247'), h('+16198481782'), h('+16198486573'), h('+18583585449')])).toEqual({ la: 4, sd: 3 });
  });
  it('Tyler: 3/3 held → 3 LA + 3 SD; Jona: nothing → 6 + 6', () => {
    expect(buyPlanForRep([h('+12137147277'), h('+12137151307'), h('+12137290113'), h('+16195378265'), h('+16198641417'), h('+18584221927')])).toEqual({ la: 3, sd: 3 });
    expect(buyPlanForRep([])).toEqual({ la: 6, sd: 6 });
  });
  it('overshoot clamps to zero and inactive/other never count', () => {
    const seven = ['+12131110001', '+12131110002', '+12131110003', '+13231110004', '+12131110005', '+13231110006', '+12131110007'].map((e) => h(e));
    expect(buyPlanForRep([...seven, h('+16191110008'), h('+12054303297')]).la).toBe(0);
    expect(buyPlanForRep([h('+12137544220', 'unknown', false)]).la).toBe(6);
  });
});

describe('poolBuyCount', () => {
  it('50-target minus existing, floored at 0', () => {
    expect(poolBuyCount(10)).toBe(40);
    expect(poolBuyCount(55)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd services/cti-api && npx vitest run src/fleet/plan.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** — `plan.ts`:

```ts
/** Area-code policy for the inbound-team fleet (spec 2026-08-24): LA = 213/323, SD = 619/858. */
export type AreaClass = 'LA' | 'SD' | 'other';

const LA = new Set(['213', '323']);
const SD = new Set(['619', '858']);

export function classifyArea(e164: string): AreaClass {
  const ac = /^\+1(\d{3})\d{7}$/.exec(e164)?.[1];
  if (!ac) return 'other';
  return LA.has(ac) ? 'LA' : SD.has(ac) ? 'SD' : 'other';
}

export interface Holding { e164: string; health: string; active: boolean }

const usable = (x: Holding): boolean => x.active && x.health !== 'degraded' && x.health !== 'spam_likely';

/** How many LA/SD numbers a rep still needs. Degraded/inactive/other-area holdings never count. */
export function buyPlanForRep(holdings: ReadonlyArray<Holding>, target = { la: 6, sd: 6 }): { la: number; sd: number } {
  const held = { LA: 0, SD: 0, other: 0 };
  for (const x of holdings) if (usable(x)) held[classifyArea(x.e164)]++;
  return { la: Math.max(0, target.la - held.LA), sd: Math.max(0, target.sd - held.SD) };
}

export function poolBuyCount(existingActivePool: number, target = 50): number {
  return Math.max(0, target - existingActivePool);
}
```

- [ ] **Step 4: Verify** — the test file PASSES; `npm test && npm run typecheck` clean.
- [ ] **Step 5: Commit**

```bash
git add services/cti-api/src/fleet/plan.ts services/cti-api/src/fleet/plan.test.ts
git commit -m "feat(cti-api): pure fleet planner — LA/SD targets from real holdings"
```

---

### Task 2: `buy-agent-numbers` script (rep top-up, hire reserve, pool, assign)

**Files:**
- Create: `services/cti-api/scripts/buy-agent-numbers.ts`
- Reference (do not modify): `services/cti-api/scripts/buy-pool-numbers.mjs` — copy its `twGet`/`twPost`/`searchAvailable`/two-phase MODE pattern exactly.

**Interfaces:**
- Consumes: `classifyArea`, `buyPlanForRep`, `poolBuyCount` from `../src/fleet/plan.js`.
- Produces (CLI, run via `npx tsx`): commands `plan` (always dry — prints the full 192 breakdown from live DB), `buy-rep --email <email>`, `buy-reserve --la <n> --sd <n>`, `buy-pool --count <n>`, `register` (consumes hand-off), `assign --email <email>` (moves 6 LA + 6 SD from the unassigned agent reserve to the rep). Env contract identical to the pool script: `MODE`-style two-phase via `CONFIRM_BUY`, `FLEET_OUTFILE` hand-off (default `./fleet-buy.json` in CWD, gitignored), `POOL_API_BASE` for the webhook, `DATABASE_PUBLIC_URL`/`DATABASE_URL` for DB.

- [ ] **Step 1: Write the script** — `scripts/buy-agent-numbers.ts` (complete; the Twilio helpers are the pool script's verbatim):

```ts
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
import { buyPlanForRep, classifyArea, poolBuyCount } from '../src/fleet/plan.js';

const CONFIRM = process.env.CONFIRM_BUY === '1';
const HANDOFF = process.env.FLEET_OUTFILE || './fleet-buy.json';
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const API_BASE = process.env.POOL_API_BASE || process.env.API_PUBLIC_URL;
const DB_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const LA_CODES = ['213', '323'];
const SD_CODES = ['619', '858'];
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
    console.log(`${email}: buying ${p.la} LA + ${p.sd} SD`);
    const bought: BoughtRec[] = existingHandoff();
    const tag = email.split('@')[0];
    await buyBatch(LA_CODES, p.la, 'agent', `Agent ${tag} LA`, email, bought);
    await buyBatch(SD_CODES, p.sd, 'agent', `Agent ${tag} SD`, email, bought);
  } finally { await c.end(); }
}

const existingHandoff = (): BoughtRec[] => { try { return JSON.parse(readFileSync(HANDOFF, 'utf8')); } catch { return []; } };

async function cmdBuyReserve(la: number, sd: number) {
  const bought = existingHandoff();
  await buyBatch(LA_CODES, la, 'agent', 'Agent Reserve LA', null, bought);
  await buyBatch(SD_CODES, sd, 'agent', 'Agent Reserve SD', null, bought);
}

async function cmdBuyPool(count: number) {
  const bought = existingHandoff();
  await buyBatch(POOL_CODES, count, 'dialer_pool', 'Dialer Pool', null, bought);
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
```

- [ ] **Step 2: Verify without spending** — `npx tsx scripts/buy-agent-numbers.ts plan` against prod DB (`railway run -s @cti/api -- env DATABASE_URL=<Postgres DATABASE_PUBLIC_URL> npx tsx …`): expect Evren `6 LA + 1 SD`, Matt `4 LA + 3 SD`, Tyler `3 LA + 3 SD`, Jona `6 LA + 6 SD`, `pool: 10 active → buy 40`, TOTAL 192. Then a dry-run `buy-rep --email evren@gghomessd.com` (no `CONFIRM_BUY`): 7 `[dry-run] would buy` lines. `npm run typecheck` clean.
- [ ] **Step 3: Add `fleet-buy.json` to `.gitignore`** (repo root) — the hand-off holds purchased SIDs, not secrets, but is machine-local state.
- [ ] **Step 4: Commit**

```bash
git add services/cti-api/scripts/buy-agent-numbers.ts .gitignore
git commit -m "feat(cti-api): fleet buy script — rep top-up, hire reserve, pool, assign"
```

---

### Task 3: Promote the Trust Hub assignment script

**Files:**
- Create: `services/cti-api/scripts/trusthub-assign.mjs` — the proven scratchpad script, verbatim, with one change: the summary also prints per-number FAIL lines with the Twilio error message (it already does) AND exits non-zero when any assignment failed.

**Interfaces:**
- Produces: `railway run -s @cti/api -- node services/cti-api/scripts/trusthub-assign.mjs` — assigns EVERY IncomingPhoneNumber to the approved business profile (`BUfffd7ec178a44a108e81f2a1e03d0b2d`) and SHAKEN/STIR trust product (`BU9aacbc2ad2856cd5a8167c8d556d3a16`); idempotent (skips already-assigned); prints `<label>: assigned N, already M, failed K → now X/Y`.

- [ ] **Step 1: Copy the script** from `/private/tmp/claude-501/-Users-cdrshepard-spam-res-cti/afd1f56e-293d-4ea6-9400-11116185f1f2/scratchpad/trusthub-assign.mjs` into `services/cti-api/scripts/trusthub-assign.mjs`; add at the end: `if (anyFailed) process.exit(1);` (track a boolean where FAIL lines print). Add a header comment naming the two BU sids and that they were verified `twilio-approved` on 2026-08-23.
- [ ] **Step 2: Verify read-only-safe** — running it now must print `assigned 0, already 29, failed 0 → now 29/29` twice (idempotence proof against the live account).
- [ ] **Step 3: Commit**

```bash
git add services/cti-api/scripts/trusthub-assign.mjs
git commit -m "chore(cti-api): promote the idempotent Trust Hub assignment script into the repo"
```

---

### Task 4: NumberVerifier enrollment manifest + runbook

**Files:**
- Create: `services/cti-api/scripts/nv-enrollment-manifest.ts`, `docs/runbooks/numberverifier-enrollment.md`

**Interfaces:**
- Consumes: `outbound_numbers` (`e164`, `kind`, `health_source`, `active`).
- Produces: a CSV on stdout — `e164,kind,label,enrolled` where `enrolled` = `yes` iff `health_source = 'numberverifier'` — and a runbook the admin follows in the NumberVerifier dashboard.

- [ ] **Step 1: Script** — `scripts/nv-enrollment-manifest.ts`:

```ts
#!/usr/bin/env npx tsx
/** CSV of every active number and whether NumberVerifier has EVER reported on it.
 *  `enrolled=no` rows are the dashboard to-do list — see docs/runbooks/numberverifier-enrollment.md. */
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const rows = (await c.query(`select e164, kind, coalesce(label,'') label, (health_source = 'numberverifier') enrolled from outbound_numbers where active order by kind, e164`)).rows;
console.log('e164,kind,label,enrolled');
for (const r of rows) console.log(`${r.e164},${r.kind},"${r.label}",${r.enrolled ? 'yes' : 'no'}`);
console.error(`# ${rows.length} numbers, ${rows.filter((r) => !r.enrolled).length} not yet reported on by NumberVerifier`);
await c.end();
```

- [ ] **Step 2: Runbook** — `docs/runbooks/numberverifier-enrollment.md` with exactly these sections: **Why** (webhook live since June, zero reports ever — numbers were never enrolled); **Generate the list** (the command above, `enrolled=no` rows); **Enroll** (app.numberverifier.com → the GG Homes campaign → add the numbers; set the campaign webhook to `https://ctiapi-production.up.railway.app/integrations/numberverifier/webhook` with the account's verify key — the server checks `NUMBERVERIFIER_VERIFY_KEY`); **Prove it** (force a check on ONE number in their dashboard, then re-run the manifest — that number must flip to `yes`; that flip is also sub-project B's gate NV-1); **If we get an API key** (set `NUMBERVERIFIER_API_KEY` on @cti/api and file an issue to automate enrollment — do not build it speculatively).
- [ ] **Step 3: Verify** — manifest against prod prints 29 rows, all `enrolled=no` (today's truth). `npm run typecheck` clean.
- [ ] **Step 4: Commit**

```bash
git add services/cti-api/scripts/nv-enrollment-manifest.ts docs/runbooks/numberverifier-enrollment.md
git commit -m "feat(cti-api): NumberVerifier enrollment manifest + runbook (webhook-only integration today)"
```

---

### Task 5: Fleet report

**Files:**
- Create: `services/cti-api/scripts/fleet-report.ts`

**Interfaces:**
- Consumes: DB (`outbound_numbers`, `users`), Twilio (`IncomingPhoneNumbers` list; Trust Hub `ChannelEndpointAssignments` for the two BU sids from Task 3).
- Produces: one row per active number — `e164 | kind | rep | area | db✓ | twilio✓ | webhook✓ | trusthub✓ | shaken✓ | nv` — plus per-rep LA/SD tallies vs the 6/6 target and a pool count vs 50; exits 1 if any ✗ in db/twilio/webhook/trusthub/shaken (NV pending is reported, not fatal — enrollment is a human step).

- [ ] **Step 1: Script** — `scripts/fleet-report.ts`:

```ts
#!/usr/bin/env npx tsx
/** The sub-project-A acceptance gate: every active number fully provisioned, every rep at 6 LA / 6 SD, pool at 50. */
import pg from 'pg';
import { classifyArea } from '../src/fleet/plan.js';
const PROFILE = 'BUfffd7ec178a44a108e81f2a1e03d0b2d', SHAKEN = 'BU9aacbc2ad2856cd5a8167c8d556d3a16';
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID!, TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
async function all(url: string, key: string): Promise<any[]> {
  let out: any[] = [], next: string | null = url;
  while (next) { const r = await fetch(next, { headers: { Authorization: auth } }); const j: any = await r.json(); if (!r.ok) throw new Error(`${r.status} ${next}`); out = out.concat(j[key] ?? []); next = j.meta?.next_page_url ?? (j.next_page_uri ? 'https://api.twilio.com' + j.next_page_uri : null); }
  return out;
}
const c = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const db = (await c.query(`select n.e164, n.kind, n.twilio_sid, n.health_source, u.email from outbound_numbers n left join users u on u.id = n.assigned_user_id where n.active order by n.kind, u.email nulls last, n.e164`)).rows;
const tw = new Map((await all(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=100`, 'incoming_phone_numbers')).map((n: any) => [n.phone_number, n]));
const inProfile = new Set((await all(`https://trusthub.twilio.com/v1/CustomerProfiles/${PROFILE}/ChannelEndpointAssignments?PageSize=100`, 'results')).map((a: any) => a.channel_endpoint_sid));
const inShaken = new Set((await all(`https://trusthub.twilio.com/v1/TrustProducts/${SHAKEN}/ChannelEndpointAssignments?PageSize=100`, 'results')).map((a: any) => a.channel_endpoint_sid));
let fail = 0;
const perRep = new Map<string, { LA: number; SD: number }>();
for (const n of db) {
  const t: any = tw.get(n.e164);
  const webhookOk = !!t && /\/telephony\/twilio\/inbound$/.test(t.voice_url ?? '');
  const checks = { db: true, twilio: !!t, webhook: webhookOk, trusthub: !!t && inProfile.has(t.sid), shaken: !!t && inShaken.has(t.sid) };
  if (Object.values(checks).some((v) => !v)) fail++;
  const area = classifyArea(n.e164);
  if (n.email && n.kind === 'agent' && area !== 'other') { const p = perRep.get(n.email) ?? { LA: 0, SD: 0 }; p[area]++; perRep.set(n.email, p); }
  console.log([n.e164, n.kind, n.email ?? '-', area, ...Object.entries(checks).map(([k, v]) => `${k}${v ? '✓' : '✗'}`), n.health_source === 'numberverifier' ? 'nv:yes' : 'nv:pending'].join(' | '));
}
for (const [email, p] of perRep) console.log(`REP ${email}: ${p.LA}/6 LA, ${p.SD}/6 SD ${p.LA >= 6 && p.SD >= 6 ? '✓' : '✗ SHORT'}`);
const pool = db.filter((n) => n.kind === 'dialer_pool').length;
console.log(`POOL: ${pool}/50 ${pool >= 50 ? '✓' : '✗ SHORT'}`);
console.log(fail ? `FAIL: ${fail} number(s) not fully provisioned` : 'ALL PROVISIONED');
await c.end();
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Verify against today's fleet** — run it now: 29 rows, all `db✓ twilio✓ webhook✓ trusthub✓ shaken✓ nv:pending` (webhook may be ✗ on numbers never registered for inbound — that is a real finding, list them), reps show SHORT (expected pre-buy), exit reflects only provisioning ✗s. `npm run typecheck` clean.
- [ ] **Step 3: Commit**

```bash
git add services/cti-api/scripts/fleet-report.ts
git commit -m "feat(cti-api): fleet report — the sub-project-A acceptance gate"
```

---

### Task 6: Execute the purchase (192 numbers) + runbook

**⚠️ This task spends real money (~$220 one-time, ~$250/mo ongoing) and is CONTROLLER-EXECUTED — the implementer subagent writes the runbook only; the controller runs the buys after a dry-run review.**

**Files:**
- Create: `docs/runbooks/number-fleet.md` — the exact command sequence below with the two-phase env pattern (`railway run -s @cti/api` for buys, `DATABASE_URL=<Postgres public>` for register/assign), one `CONFIRM_BUY=1` batch at a time, `register` after each batch, and per-batch expected counts.

- [ ] **Step 1: Runbook committed** (implementer):

```bash
git add docs/runbooks/number-fleet.md
git commit -m "docs(cti-api): number-fleet purchase runbook (192 numbers, batch-by-batch)"
```

- [ ] **Step 2 (controller): dry-run everything** — `plan`, then each `buy-*` without `CONFIRM_BUY`; totals must read 7/7/6/12 + 120 reserve + 40 pool = 192.
- [ ] **Step 3 (controller): buy + register batch-by-batch** — order: 4 × `buy-rep` → `register` → `buy-reserve --la 60 --sd 60` → `register` → `buy-pool --count 40` → `register`. After each register: spot-check counts in the DB.
- [ ] **Step 4 (controller): protect** — `trusthub-assign.mjs` (expect `assigned ~192, already 29 → now ~221/221`), then the NV manifest (expect ~221 rows `enrolled=no`) handed to the user with the runbook.
- [ ] **Step 5 (controller): acceptance** — `fleet-report.ts` exits 0 with every rep `6/6 LA, 6/6 SD ✓` (reserve rows rep `-`), `POOL: 50/50 ✓`.

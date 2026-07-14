# Power Dialer — Plan 3: Telephony Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the engine dial for real — the Twilio `DialerTelephony` implementation (server-originated call + **async AMD** + conference bridge), the AMD/status webhooks that feed `handleDialOutcome`, a **per-session concurrency lock**, dialer-pool **DID selection** (sticky + warmup/health/velocity + calling hours), **sticky-on-connect**, and **inbound caller→agent routing** for pool numbers.

**Architecture:** The engine (Plan 2) stays telephony-agnostic behind `DialerTelephony`. Plan 3 supplies `TwilioDialerTelephony` and two signature-validated webhooks. AMD runs async: the answered call is held, the AMD callback classifies human vs machine, and the engine bridges humans into the rep's `pd_<userId>` conference. Pure seams (AMD→outcome mapping, TwiML strings, DID pick) are unit-tested; the Twilio REST round-trips are thin and verified live (not by CI).

**Tech Stack:** Node 20 + TS ESM, Fastify, Drizzle/Postgres, `twilio` SDK, vitest.

## Global Constraints

- TS ESM `.js` specifiers; strict `noUncheckedIndexedAccess`; `npx tsc --noEmit` clean.
- **Progressive:** the read-then-dial in `advanceSession` MUST be serialized per session (advisory lock) AND claim the item atomically (`UPDATE … WHERE status='pending' RETURNING`), so overlapping webhook deliveries can never originate two calls.
- Twilio webhooks are signature-validated with the FULL request URL incl. query string — reuse `signedCallbackUrl(cfg.API_PUBLIC_URL, req)` from `telephony/webhooks.js` (never a stripped path).
- AMD bias: `AnsweredBy` of `unknown` counts as **human** (bridge — never skip a real person); only `machine_*`/`fax` → no_connect.
- Recording stays on (dual-channel); NO automated recipient disclosure (per prior decision — reps disclose verbally).
- Backend under `services/cti-api/src/`; tests colocated; `npx vitest run` from `services/cti-api`. Commit per task on `feat/power-dialer-foundations`; do NOT push.

**Setup:** on `feat/power-dialer-foundations`. Twilio env already configured (`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_API_KEY_SID`/`TWILIO_TWIML_APP_SID`).

---

### Task 1: Migration — queue `from_number` + `call_id` index

**Files:**
- Modify: `services/cti-api/src/db/schema.ts` (add `fromNumber` to `dialerQueueItems`; add an index on `callId`)
- Create: `services/cti-api/migrations/0018_dialer_queue_from_call_idx.sql` (verify next number)
- Test: none (schema/migration).

- [ ] **Step 1: schema** — in `dialerQueueItems` add after `toNumber`: `fromNumber: text('from_number'),`. Add a table index (in the table's second-arg callback, following the repo's `uniqueIndex`/`index` pattern used by other tables): `callIdIdx: index('dialer_queue_items_call_id_idx').on(t.callId)`. Import `index` from `drizzle-orm/pg-core` if not already imported.
- [ ] **Step 2: migration `0018_…sql`** (mirror an existing migration): `ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "from_number" text;` + `CREATE INDEX IF NOT EXISTS "dialer_queue_items_call_id_idx" ON "dialer_queue_items" ("call_id");`
- [ ] **Step 3: verify** — `npx tsc --noEmit`; `npm run migrate` if a DB is reachable else confirm SQL well-formed.
- [ ] **Step 4: commit** — `git add -A && git commit -m "feat(dialer): queue from_number + call_id index"`

---

### Task 2: Concurrency-safe advance + AMD outcome mapping

**Files:**
- Create: `services/cti-api/src/dialer/amd.ts`
- Modify: `services/cti-api/src/dialer/engine.ts` (atomic claim + advisory lock in `advanceSession`; store `fromNumber` on the item)
- Test: `services/cti-api/src/dialer/amd.test.ts`; extend `engine.test.ts`

**Interfaces:**
- Produces:
  - `mapAnsweredBy(answeredBy: string | undefined): 'connected' | 'no_connect'` — pure. `human` → connected; `unknown`/undefined/empty → connected (bias to human); anything starting `machine`, or `fax` → no_connect.
  - `advanceSession` unchanged signature, now: wraps the read→claim→dial in a Postgres transaction holding `pg_advisory_xact_lock(hashtext($sessionId))`, and claims the next item via `UPDATE dialer_queue_items SET status='dialing' WHERE id=$next AND status='pending' RETURNING id` (0 rows → someone else claimed it → return `waiting`). Stores `fromNumber` on the item alongside `callId`.

- [ ] **Step 1: Write the failing test (amd)**

```ts
// services/cti-api/src/dialer/amd.test.ts
import { describe, expect, it } from 'vitest';
import { mapAnsweredBy } from './amd.js';
describe('mapAnsweredBy', () => {
  it('humans + unknown bridge; machines/fax skip', () => {
    for (const h of ['human', 'unknown', undefined, '']) expect(mapAnsweredBy(h)).toBe('connected');
    for (const m of ['machine_start', 'machine_end_beep', 'machine_end_silence', 'fax']) expect(mapAnsweredBy(m)).toBe('no_connect');
  });
});
```

- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3a: `amd.ts`**

```ts
// services/cti-api/src/dialer/amd.ts
/** Map Twilio AMD AnsweredBy → dialer outcome. Bias to human: only an explicit
 *  machine/fax is a no-connect; unknown/undefined counts as a live human. */
export function mapAnsweredBy(answeredBy: string | undefined): 'connected' | 'no_connect' {
  const a = (answeredBy ?? '').toLowerCase();
  if (a.startsWith('machine') || a === 'fax') return 'no_connect';
  return 'connected';
}
```

- [ ] **Step 3b: engine `advanceSession` concurrency** — replace the item-claim section so that, once a `next` pending item is chosen and a DID picked, the claim + dial run inside a transaction:

```ts
// inside advanceSession, replacing "set item dialing; originate; store callId":
const claimed = await deps.db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionId}))`);
  const rows = await tx
    .update(schema.dialerQueueItems)
    .set({ status: 'dialing', updatedAt: new Date() })
    .where(and(eq(schema.dialerQueueItems.id, next.id), eq(schema.dialerQueueItems.status, 'pending')))
    .returning({ id: schema.dialerQueueItems.id });
  return rows.length > 0;
});
if (!claimed) return { action: 'waiting' };
let callId: string;
try {
  ({ callId } = await deps.telephony.originate({ sessionId, itemId: next.id, fromE164: did.e164, toE164: next.toNumber, userId: session.userId }));
} catch (err) {
  // Roll the item back so a transient originate failure doesn't strand it 'dialing'.
  await setItem(deps, next.id, { status: 'pending' });
  throw err;
}
await setItem(deps, next.id, { callId, fromNumber: did.e164 });
return { action: 'dialing', itemId: next.id };
```

Add `sql` to the `drizzle-orm` import in engine.ts. (The fake DB in `engine.test.ts` must gain a `transaction(fn)` that runs `fn` with a tx exposing `.execute()` (no-op) and the same `.update().set().where().returning()` used elsewhere — adjust the FAKE, not the engine. Keep existing assertions passing; add one asserting a second concurrent-ish advance returns `waiting` when the claim `UPDATE` affects 0 rows.)

- [ ] **Step 4: verify** — `npx vitest run src/dialer/amd.test.ts src/dialer/engine.test.ts && npx tsc --noEmit && npx vitest run`.
- [ ] **Step 5: commit** — `git commit -am "feat(dialer): AMD outcome mapping + per-session concurrency-safe advance"`.

---

### Task 3: Sticky-on-connect + inbound caller→agent routing

**Files:**
- Modify: `services/cti-api/src/dialer/engine.ts` (`handleDialOutcome` connected branch records a sticky binding)
- Create: `services/cti-api/src/dialer/sticky.ts`
- Modify: `services/cti-api/src/routes/inbound.ts` (pool-DID inbound routes by caller)
- Test: `services/cti-api/src/dialer/sticky.test.ts`

**Interfaces:**
- Produces:
  - `recordConnectSticky(db, { orgId, userId, leadE164, poolDid }): Promise<void>` — upsert `sticky_numbers` (org, assignedUserId=userId, recipientE164=leadE164) → e164=poolDid. (Reuse the existing `stickyNumbers` upsert shape from `routes/calls.ts`.)
  - `stickyAgentForCaller(db, orgId, callerE164, dialedPoolDid): Promise<string | null>` — the agent bound to that caller on that pool DID (reverse lookup), else null.

- [ ] **Step 1: Write the failing test** — for a pure helper that builds the sticky upsert values:

```ts
// services/cti-api/src/dialer/sticky.test.ts
import { describe, expect, it } from 'vitest';
import { stickyUpsertValues } from './sticky.js';
describe('stickyUpsertValues', () => {
  it('binds (org, agent, lead) → pool DID', () => {
    expect(stickyUpsertValues({ orgId: 'O', userId: 'U', leadE164: '+1619', poolDid: '+1213' })).toEqual({
      orgId: 'O', assignedUserId: 'U', recipientE164: '+1619', e164: '+1213',
    });
  });
});
```

- [ ] **Step 2: run** → FAIL.
- [ ] **Step 3a: `sticky.ts`** — export `stickyUpsertValues` (pure) + `recordConnectSticky` (does the `onConflictDoUpdate` upsert on `stickyNumbers` targeting `(orgId, assignedUserId, recipientE164)`, mirroring `routes/calls.ts`) + `stickyAgentForCaller` (select `assignedUserId` from `stickyNumbers` where `orgId` + `recipientE164=caller` + `e164=dialedPoolDid`, newest first).
- [ ] **Step 3b: engine** — in `handleDialOutcome`'s `connected` branch, after `bridgeToRep` + `onScreenPop`, call `recordConnectSticky(deps.db, { orgId: session.orgId, userId: session.userId, leadE164: item.toNumber!, poolDid: item.fromNumber! })` (best-effort try/catch + log). Add `recordConnectSticky` to `EngineDeps`? No — import it directly (it's a pure-ish DB helper). Guard against null `toNumber`/`fromNumber`.
- [ ] **Step 3c: inbound.ts** — where inbound routing chooses the target: if the dialed DID's `kind === 'dialer_pool'`, resolve the agent via `stickyAgentForCaller(db, owned.orgId, normFrom, owned.e164)`; if found, `<Dial><Client>rep_<agentId>` (voicemail fallback); else voicemail. Agent DIDs keep the existing `assignedUserId` routing. (Read the current inbound routing block first; make the pool branch additive.)
- [ ] **Step 4: verify** — `npx vitest run src/dialer/sticky.test.ts && npx tsc --noEmit && npx vitest run`.
- [ ] **Step 5: commit** — `git commit -am "feat(dialer): sticky-on-connect + inbound caller→agent routing for pool DIDs"`.

---

### Task 4: Dialer-pool DID selection

**Files:**
- Create: `services/cti-api/src/dialer/pick-did.ts`
- Test: `services/cti-api/src/dialer/pick-did.test.ts`

**Interfaces:**
- Consumes: `dialerPoolNumbers` (`./pool.js`), warmup helpers (`../firewall/warmup.js`), tz helpers (`../firewall/tz.js`), `stickyNumbers`.
- Produces:
  - `withinCallingHours(toE164, nowUtc, opts?): boolean` — pure; uses `timezoneForNumber` + a default 8:00–20:59 local window (reuse the firewall's window constants if exported; otherwise 8–21). Returns true when unknown-TZ (fail-open here — the firewall already gates click-to-dial; for the dialer, default allow US business hours by area code).
  - `pickPoolDid(db, { orgId, userId, toE164 }): Promise<{ e164: string } | null>` — sticky-for-(user,lead) if it is an active pool DID and eligible; else the first active pool DID that is healthy AND under its warmup cap AND under the 10/min velocity (atomic increment mirroring `routes/calls.ts`); null when none eligible.

- [ ] **Step 1: Write the failing test** — cover `withinCallingHours` (a known Pacific number at 10:00 local true, 23:00 local false) and the sticky-preference ordering of `pickPoolDid` via injected fakes.

(Implementer: model the pure `withinCallingHours` first with a couple of deterministic UTC instants; then `pickPoolDid` with an injected `db`/query fake asserting sticky is preferred and a capped DID is skipped. Keep the atomic-increment SQL identical in shape to `routes/calls.ts`'s warmup increment.)

- [ ] **Step 2–5:** implement, verify (`tsc` + tests + full suite), commit `feat(dialer): dialer-pool DID selection (sticky + warmup/health/velocity + hours)`.

---

### Task 5: TwilioDialerTelephony + conference-join TwiML

**Files:**
- Create: `services/cti-api/src/dialer/twilio-telephony.ts`
- Modify: `services/cti-api/src/routes/telephony.ts` (add a dialer-conference-join branch to `/telephony/twilio/voice`)
- Test: `services/cti-api/src/dialer/twilio-telephony.test.ts`

**Interfaces:**
- Produces:
  - `conferenceName(userId: string): string` = `pd_${userId.replace(/-/g,'')}` — pure.
  - `bridgeTwiml(userId: string): string` — `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="true">…</Conference></Dial></Response>` — pure.
  - `class TwilioDialerTelephony implements DialerTelephony` — `originate` calls `twilio(ACCOUNT_SID, AUTH_TOKEN).calls.create({ to, from, machineDetection: 'Enable', asyncAmd: 'true', asyncAmdStatusCallback: `${API}/telephony/twilio/dialer-amd?itemId=${itemId}`, asyncAmdStatusCallbackMethod: 'POST', url: `${API}/telephony/twilio/dialer-answer`, statusCallback: `${API}/telephony/twilio/dialer-status?itemId=${itemId}`, statusCallbackEvent: ['completed'], record: true })` → `{ callId: sid }`; `bridgeToRep(callId, userId)` → `calls(callId).update({ twiml: bridgeTwiml(userId) })`; `hangup(callId)` → `calls(callId).update({ status: 'completed' })`.
- The `/telephony/twilio/voice` addition: when the SDK connect passes a `DialerConference` param, return `<Response><Dial><Conference …>pd_<callerUserId></Conference></Dial></Response>` so the rep's softphone joins their dialer conference (used by Plan 4's "Start" button). The rep's user id comes from the authorized call row / token identity — reuse the existing identity plumbing.

- [ ] **Step 1:** Test the pure `conferenceName` + `bridgeTwiml` (assert the exact strings). The Twilio REST calls are integration — assert the `originate` builds the right `calls.create` args by injecting a fake twilio client (constructor takes an optional client factory for testability), NOT a live call.
- [ ] **Step 2–5:** implement, verify (`tsc` + tests), commit `feat(dialer): TwilioDialerTelephony (async AMD + conference bridge) + conference-join TwiML`.

Note: live-call verification of AMD + bridging is a deploy-time step (place real screening calls), NOT covered by CI.

---

### Task 6: Webhooks + wire real telephony into the routes

**Files:**
- Modify: `services/cti-api/src/routes/dialer.ts` (add the two webhooks; swap `noopTelephony` → `TwilioDialerTelephony`; org-tz `todayIso`)
- Test: `services/cti-api/src/routes/dialer-webhook.test.ts`

**Interfaces:**
- Produces (Fastify, signature-validated via `signedCallbackUrl`; NOT auth'd — Twilio calls them):
  - `POST /telephony/twilio/dialer-amd?itemId=` — reads `CallSid` + `AnsweredBy`; `outcome = mapAnsweredBy(AnsweredBy)`; if `no_connect` → `telephony.hangup(CallSid)`; then `handleDialOutcome(CallSid, outcome, deps)`.
  - `POST /telephony/twilio/dialer-status?itemId=` — on terminal `CallStatus`/`DialCallStatus` of `no-answer|busy|failed|canceled` → `handleDialOutcome(CallSid, 'no_connect', deps)` (idempotent — the engine ignores non-`dialing` items, so a call already classified by AMD is a no-op).
  - `POST /telephony/twilio/dialer-answer` — returns `<Response><Pause length="30"/></Response>` (holds the callee while async AMD classifies).
- Swap the route deps: `telephony: new TwilioDialerTelephony()`, `dialerPoolNumbers` replaced by `pickPoolDid` at the engine's DID step (pass a `pickDid` dep into `EngineDeps` instead of `dialerPoolNumbers`, OR keep `dialerPoolNumbers` and have Plan 3 add a `pickDid` seam — implementer: extend `EngineDeps` with `pickDid(orgId,userId,toE164) → {e164}|null` and use it in `advanceSession` instead of `dialerPoolNumbers[0]`; update the Plan 2 fake accordingly). `todayIso` computed in the org's timezone (America/Los_Angeles for GG Homes; use `Intl.DateTimeFormat('en-CA',{timeZone,…})` → YYYY-MM-DD).

- [ ] **Step 1:** Test the webhook body→action mapping with an injected fake engine/telephony (assert: `AnsweredBy=machine_start` → hangup + `handleDialOutcome(sid,'no_connect')`; `human` → no hangup + `handleDialOutcome(sid,'connected')`; `dialer-status` `no-answer` → `handleDialOutcome(sid,'no_connect')`). Signature validation can be bypassed in the test via the existing `TWILIO_SKIP_SIGNATURE_CHECK` pattern OR by testing the extracted handler function directly.
- [ ] **Step 2–5:** implement, verify (`tsc` + tests + full suite), commit `feat(dialer): AMD/status webhooks + real Twilio telephony wired into the dialer`.

---

### Task 7: Full-suite green

- [ ] `cd services/cti-api && npx tsc --noEmit && npx vitest run` → all green. `git status -sb` clean, unpushed.

---

## Self-Review

**Spec coverage:** server-originated call + async AMD (§3/§4) → T5/T6. conference bridge (§3) → T5. AMD bias to human (§4) → T2. progressive concurrency (§7) → T2. rollover-only-on-no-connect (§6) → engine (Plan 2) driven by T6 webhooks. dialer-pool DID + hours + warmup (§4/§5/§7) → T4. sticky-on-connect + inbound caller→agent (§5) → T3. Recording on, no auto-disclosure (§7) → T5 `record:true`, no disclosure url.

**Deferred to Plan 4:** the SF list-view "Power Dial" LWC, the CTI dialer panel (start joins the conference via the `DialerConference` param), and Open CTI screen-pop (Plan 3's `onScreenPop` dep stays a no-op until Plan 4 wires it).

**Cannot be CI-verified (live-only):** AMD classification accuracy + timing, the actual conference bridge, real warmup/velocity under load. Flag for a live test-call pass after deploy.

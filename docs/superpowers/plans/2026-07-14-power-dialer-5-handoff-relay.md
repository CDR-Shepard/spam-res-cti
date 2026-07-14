# Power Dialer — Plan 5: Salesforce→CTI Handoff Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the Salesforce "Power Dial" list-view button actually start a run in the rep's CTI softphone, via a server relay — avoiding the unreliable cross-iframe postMessage.

**Architecture:** SF Apex POSTs the rep's selected record ids to the CTI API (`POST /dialer/handoffs`, authed by a shared secret). The CTI softphone polls `GET /dialer/handoffs/pending` (authed by the rep's Bearer session), which atomically claims the pending handoff for that rep's Salesforce user id and returns it; the web app then calls the existing `startPowerDial(objectType, recordIds)`. Same-org, single-tenant (GG Homes).

**Tech Stack:** Fastify + Drizzle/Postgres (services/cti-api), React (apps/cti-web), Salesforce Apex + LWC.

## Global Constraints

- TS strict everywhere; `services/cti-api` and `apps/cti-web` both `npx tsc --noEmit` clean + tests green before each commit. cti-web uses **extensionless** local imports (Bundler resolution); cti-api uses **`.js`** specifiers (NodeNext).
- The relay must NEVER trust a client-supplied Salesforce user id on the READ path. The rep's SF id is resolved server-side from `salesforce_connections.sf_user_id` for the authed `userId`. No IDOR.
- `POST /dialer/handoffs` auth = a shared secret in header `x-handoff-secret`, compared in **constant time**. If `HANDOFF_SHARED_SECRET` is unset, the endpoint returns **503** (feature disabled) — it must NEVER accept an unauthenticated write.
- The claim on the READ path must be **atomic** (single `UPDATE ... WHERE status='pending' ... RETURNING`) so two concurrent polls can't both start a run.
- No secrets logged. Validate all external input (objectType ∈ {Lead,Opportunity}; recordIds a non-empty array ≤ 500 of 15/18-char alphanumeric SF ids).
- Commit per task on `feat/power-dialer-foundations`; do NOT push.

**Existing patterns to match (READ these):**
- Auth: `resolveSession(req.headers.authorization)` → `{ userId, orgId }` (see `routes/dialer.ts:167-169`). `getDb()`, `loadConfig()`.
- Schema style: `pgTable('name', { id: uuid('id').primaryKey().defaultRandom(), … text()/jsonb()/timestamp('x',{withTimezone:true}).defaultNow().notNull() })` (see `db/schema.ts`).
- Rep SF id: `salesforce_connections` (`sfUserId`/`sf_user_id`, `userId`, `sfOrgId`).
- Migration SQL: idempotent `create table if not exists` in `services/cti-api/migrations/NNNN_*.sql` (match `0017`'s uuid-pk default convention — read it).

---

### Task 1: Backend — table, store, endpoints, config, tests

**Files:**
- Create: `services/cti-api/migrations/0019_dialer_handoffs.sql`
- Modify: `services/cti-api/src/db/schema.ts` (add `dialerHandoffs`)
- Create: `services/cti-api/src/dialer/handoff-store.ts`
- Modify: `services/cti-api/src/config.ts` (add `HANDOFF_SHARED_SECRET`)
- Modify: `services/cti-api/src/routes/dialer.ts` (add the two routes)
- Test: `services/cti-api/src/dialer/handoff-store.test.ts` + `services/cti-api/src/routes/dialer-handoffs.test.ts`

**Interfaces (Produces):**
- `isValidSfId(s: string): boolean` — `/^[a-zA-Z0-9]{15,18}$/`.
- `parseHandoffInput(body: unknown): { salesforceUserId: string; objectType: 'Lead'|'Opportunity'; recordIds: string[] } | { error: string }` — zod; recordIds 1..500, each `isValidSfId`, deduped; objectType enum; salesforceUserId `isValidSfId`.
- `upsertPendingHandoff(db, args): Promise<{ handoffId: string }>` — supersede (delete) any existing `pending` rows for that `salesforceUserId`, then insert one `pending`.
- `claimPendingHandoff(db, salesforceUserId: string): Promise<{ objectType: 'Lead'|'Opportunity'; recordIds: string[] } | null>` — atomic claim of the latest pending for that sf id.
- `constantTimeEqual(a: string, b: string): boolean` — `crypto.timingSafeEqual` on equal-length buffers (length-guard first).

**Migration (0019):**
```sql
create table if not exists dialer_handoffs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid,
  salesforce_user_id text not null,
  object_type text not null,
  record_ids jsonb not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  claimed_at timestamptz
);
create index if not exists dialer_handoffs_sfuser_status_idx
  on dialer_handoffs (salesforce_user_id, status);
```
(If `0017` uses a different uuid-default idiom, match it. Add a `check (object_type in ('Lead','Opportunity'))` and `check (status in ('pending','claimed'))` if the other tables use checks.)

**Claim query (atomic — the safety-critical part):**
```ts
// one statement; two concurrent polls → only one claims
const rows = await db.execute(sql`
  update dialer_handoffs set status='claimed', claimed_at=now()
  where id = (
    select id from dialer_handoffs
    where salesforce_user_id = ${salesforceUserId} and status='pending'
    order by created_at desc limit 1
    for update skip locked
  )
  returning object_type, record_ids
`);
```
Map the returned row → `{ objectType, recordIds }` (parse jsonb). Return null if no row.

**Routes (in `registerDialerRoutes`):**
```ts
// POST /dialer/handoffs — from Salesforce Apex; shared-secret auth
app.post('/dialer/handoffs', async (req, reply) => {
  const secret = cfg.HANDOFF_SHARED_SECRET;
  if (!secret) return reply.code(503).send({ error: 'handoff relay not configured' });
  const provided = (req.headers['x-handoff-secret'] as string | undefined) ?? '';
  if (!constantTimeEqual(provided, secret)) return reply.code(401).send({ error: 'Unauthorized' });
  const parsed = parseHandoffInput(req.body);
  if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
  const db = getDb();
  // best-effort org derivation from the SF user id (nullable)
  const conn = await db.query.salesforceConnections.findFirst({
    where: eq(schema.salesforceConnections.sfUserId, parsed.salesforceUserId),
  });
  const { handoffId } = await upsertPendingHandoff(db, {
    orgId: conn?.orgId ?? null,
    salesforceUserId: parsed.salesforceUserId,
    objectType: parsed.objectType,
    recordIds: parsed.recordIds,
  });
  return { handoffId };
});

// GET /dialer/handoffs/pending — from the rep's softphone; Bearer auth; atomic claim
app.get('/dialer/handoffs/pending', async (req, reply) => {
  const authed = await resolveSession(req.headers.authorization);
  if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
  const db = getDb();
  const conn = await db.query.salesforceConnections.findFirst({
    where: eq(schema.salesforceConnections.userId, authed.userId),
  });
  if (!conn?.sfUserId) return { handoff: null };
  const handoff = await claimPendingHandoff(db, conn.sfUserId);
  return { handoff };
});
```

**Config:** `HANDOFF_SHARED_SECRET: z.string().min(16).optional()`.

- [ ] **Step 1 (RED):** unit tests — `isValidSfId` (accept 15 & 18 alnum, reject symbols/short/long); `parseHandoffInput` (reject bad objectType, empty/>500 recordIds, bad ids; accept + dedupe good); `constantTimeEqual` (true equal, false unequal incl different lengths). Run → FAIL.
- [ ] **Step 2 (GREEN):** implement `handoff-store.ts` (helpers + `upsertPendingHandoff` + `claimPendingHandoff`), config, schema, migration, routes. `import crypto from 'node:crypto'`.
- [ ] **Step 3:** route/integration tests in `dialer-handoffs.test.ts` — mirror the existing dialer route test harness (find and reuse it): POST with no secret → 503 when unconfigured / 401 when secret set but wrong; POST valid → row created + supersedes a prior pending; GET pending with a linked conn → claims & returns once, second GET → `{handoff:null}` (claim is one-shot); GET without linked SF conn → `{handoff:null}`; GET unauth → 401. **Include a concurrency-style test**: two `claimPendingHandoff` calls resolve with exactly one non-null.
- [ ] **Step 4:** `cd services/cti-api && npx tsc --noEmit && npx vitest run` → all green (existing 159 + new).
- [ ] **Step 5:** commit `feat(dialer): SF→CTI handoff relay endpoints (shared-secret POST + atomic-claim GET)`.

---

### Task 2: Web — poll for a pending handoff and auto-start

**Files:**
- Modify: `apps/cti-web/src/dialer-api.ts` (add `getPendingHandoff`)
- Modify: `apps/cti-web/src/App.tsx` (poll + auto-start)
- Test: extend `apps/cti-web/src/dialer-api.test.ts` (path/shape for the new call)

**Interfaces:**
- `getPendingHandoff(): Promise<{ handoff: { objectType: 'Lead'|'Opportunity'; recordIds: string[] } | null }>` → `GET /dialer/handoffs/pending`.

**Behavior (App.tsx):** a `useEffect` that, while signed in AND `dialerSessionId === null`, polls `getPendingHandoff()` every ~5s. On a non-null handoff, call the existing `startPowerDial(handoff.objectType, handoff.recordIds)` (which sets session + switches to the Power Dial tab + joins the conference). Clear the interval on unmount / when a session becomes active (avoid starting a second run). Swallow poll errors (don't crash; keep polling). Keep the existing `POWER_DIAL` postMessage listener as-is (harmless secondary path / test seam).

- [ ] TDD the `dialer-api` addition (a path/shape assertion consistent with Task 1's other client tests), implement the poll, then `cd apps/cti-web && npx tsc --noEmit && npx vitest run && npm run build`. Commit `feat(cti-web): auto-start Power Dial from a pending SF handoff (poll)`.

---

### Task 3: Salesforce — Apex relay + LWC + README (deploy user-gated)

**Files:**
- Create: `salesforce/force-app/main/default/classes/PowerDialRelay.cls` + `.cls-meta.xml`
- Modify: `salesforce/force-app/main/default/lwc/powerDial/powerDial.js` (call Apex instead of postMessage)
- Modify: `salesforce/force-app/main/default/lwc/powerDial/README.md` (relay setup)

**Apex (`PowerDialRelay.cls`):** an `@AuraEnabled` method `sendToCti(String objectApiName, List<Id> recordIds)` that issues an `HttpRequest` POST to `callout:CTI_PowerDial/dialer/handoffs` (a Named Credential), setting header `x-handoff-secret` from a **protected Custom Metadata / Custom Setting** (documented; do NOT hardcode a secret), `Content-Type: application/json`, body `JSON.serialize(new Map<String,Object>{ 'salesforceUserId' => UserInfo.getUserId(), 'objectType' => objectApiName, 'recordIds' => recordIds })`. Return the HTTP status; throw an `AuraHandledException` on non-2xx. Keep it small; include a minimal Apex test class `PowerDialRelayTest.cls` with an `HttpCalloutMock` (SF requires ≥1 test for deploy).

**LWC:** replace the postMessage attempt with `import sendToCti from '@salesforce/apex/PowerDialRelay.sendToCti'` and call it with the selected ids + object api name; toast success/failure.

**README:** the full setup — deploy (`sf project deploy start`), create Named Credential `CTI_PowerDial` (URL = the CTI API base), store the shared secret (Custom Metadata / Named Principal header), set `HANDOFF_SHARED_SECRET` in Railway to the same value, wire the List Button + Flow (`GETRECORDIDS()`) on Lead & Opportunity list views. State clearly this is the user-gated deploy step.

- [ ] Write the Apex + test + LWC change + README. Verify XML well-formed. (No repo CI covers Apex.) Commit `feat(sf): Power Dial Apex relay + LWC wiring + setup README`.

---

### Task 4: Full green

- [ ] `cd services/cti-api && npx tsc --noEmit && npx vitest run` AND `cd apps/cti-web && npx tsc --noEmit && npx vitest run && npm run build`. `git status` clean, unpushed.

## Self-Review

**Coverage:** POST relay (Task 1) ← Apex (Task 3); atomic-claim GET (Task 1) ← web poll (Task 2). Auth: shared-secret+503 (Task 1 constraints); no-IDOR read (Task 1 GET resolves sf id server-side).

**User-gated:** deploy the Apex+LWC, create the Named Credential + secret, set `HANDOFF_SHARED_SECRET` in Railway, wire the list-view button. Live end-to-end test.

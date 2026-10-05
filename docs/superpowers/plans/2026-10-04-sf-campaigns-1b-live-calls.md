# Salesforce Campaigns, Phase 1B (Live Calls and Write-Back) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Campaign call touches reach reps through the CTI power dialer's "Campaign calls" button, their outcomes flow back into the campaign, consent is captured into Salesforce through new consent fields, Salesforce writes go through a retrying outbox, and kill switches and automatic pauses guard everything; then it deploys.

**Architecture:** Builds on plan 1A (`2026-10-04-sf-campaigns-1a-dry-run.md`), which must be merged first. Salesforce metadata ships the consent fields and an `AI_Outreach` permission set. outreach-api adds the `sf.write` and `calls.reconcile` ticks, consent capture and backfill, and a global kill switch. cti-api gains two dialer routes that claim queued campaign touches and build a normal power-dial run; cti-web gains a Campaign calls picker. Every dialer gate is unchanged.

**Tech Stack:** as plan 1A, plus Salesforce DX metadata (`sf project deploy start`), the existing cti-api/cti-web stacks, and Railway Infrastructure as Code.

**Spec:** `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md` (phase 1 of §3: §10.1, §11, §11.1, §12).

## Global Constraints

Every task implicitly includes these. Controllers: paste this section into every implementer brief, because a task brief carries only its own task text.

- TypeScript 5.6 strict, ESM with `.js` import suffixes, npm workspaces. Node ≥ 22.12 (global `fetch`).
- Drizzle `0.36.4` pinned exactly; zod 3; Fastify 4; vitest 2 in Node workspaces (`services/*`, `packages/*`), vitest 4 + jsdom in `apps/outreach-web`; pg-boss 12.30 (`import { PgBoss } from 'pg-boss'`); React 18 + TanStack Router file routes + TanStack Query 5 + Tailwind 4 + shadcn in `apps/outreach-web`.
- Packages build to `dist/` and are consumed through `exports` (`types` → `dist/index.d.ts`, `default` → `dist/index.js`). A new package must be added to root `build:packages` (order: phone, db, auth, firewall, contracts, salesforce).
- Tests: Fastify `app.inject`; outreach-api's fake-DB harness `services/outreach-api/src/test/harness.ts` (`fakeDb`, `testConfig`, `buildTestApp`); any whole-module `vi.mock('@cti/...')` MUST spread `...(await importOriginal())`. Pure logic gets table-driven unit tests. Concurrency and uniqueness get the real-Postgres lane (A3), skipped when `TEST_DATABASE_URL` is unset.
- Migrations: plain SQL in `packages/db/migrations/NNNN_name.sql`, `IF NOT EXISTS` everywhere, plus a pinned migration test like `packages/db/src/migration-0049.test.ts`. **Number = next free number at implementation time** (origin/main is at 0049; another session also adds migrations — `git fetch origin && ls packages/db/migrations` right before numbering, and never reuse a number). Below, "0050" means "the number A3 actually takes"; B-plan migrations take the next free number after that.
- Outreach tables live in a new Drizzle file `packages/db/src/schema-outreach.ts`, re-exported at the END of `schema.ts` with `export * from './schema-outreach.js';`. `schema-outreach.ts` imports nothing from `schema.ts` (no Drizzle `.references()` across files, to avoid an ESM import cycle); foreign keys are declared in the SQL migration only.
- Models: triage uses `claude-haiku-4-5-20251001` via `@anthropic-ai/sdk`. (Sonnet 5 drafting is phase 2; not used here.)
- Numbers copied from the spec: refresh every **240** minutes by default; campaign cap **50,000** records; Salesforce batches of **200**; triage input cap **8,000** characters with the last **10** Tasks; sequence days **{0,1,3,6,10,14}**; daily AI budget default **$25** per tenant; recipient-local windows: calls **08:00–21:00** (the dialer's rule, unchanged), texts **09:00–20:00**, email scheduled **08:00–18:00**; one touch per person per day across channels; a CTI dial in the last **24 hours** defers a touch by one day; one active campaign per person keyed by every E.164 and lowercased email.
- The AI proposes, rules decide. Notes, Tasks, and replies are passed to the model as quoted data, never instructions; every model output is zod-validated before use.
- v1 never changes Lead status or Opportunity stage and never creates or converts records. Salesforce reads go through the integration user's connection; the query path never writes.
- `CTI_Origin__c` value for anything this system writes: `AI Outreach`.
- Consent fields (B1): `AI_Call_Consent__c` (checkbox), `AI_Call_Consent_Date__c` (date/time), `AI_Call_Consent_Source__c` (picklist: `Text Reply`, `Email Reply`, `Web Form`, `Inbound Call`, `Rep`) on Lead and Opportunity.
- Repo hygiene: commit messages `<type>(<scope>): <description>`, no trailers; stage explicit paths only (never `git add -A`/`-u`); never stage `.claude/launch.json`, `apps/cti-ios/App/CTICallerID.entitlements`, or anything under `.superpowers/`. Root verification: `npm run typecheck && npm test`.
- cti-api and cti-web are live and actively edited by another session. Touch them only where a task says so, keep diffs minimal, and keep every existing cti-api/cti-web test green.

## Plan-level refinements of the spec (shared with plan 1A)

1. **`packages/salesforce` is new; the CTI keeps its own client in phase 1.** The CTI's client has 35 importers in a live service under active development by another session; moving it would put the live dialer at risk. Outreach uses the new package; converging the CTI onto it is a follow-up. Pagination arrives as `queryAll` in the package (the CTI's `soqlQuery` is untouched).
2. **Jobs are scheduled ticks over database-claimed rows.** Each spec queue name is a pg-boss queue with `policy: 'singleton'` and a cron schedule; durable state lives in our tables (`touches`, `campaign_enrollments`, `sf_writes`, …). `record.sync` folds into `campaign.refresh`; `calls.reconcile` is added in 1B.
3. **Touch statuses** are `planned`, `held`, `queued`, `dialing`, `sent`, `failed`, `skipped`. `held` = planned on a channel that is not live yet when no live channel is allowed (phase 1: texts and email); the enrollment waits on it. In a `dry_run` campaign touches stay `planned`; when the campaign is `active`, `rep_call` touches move to `queued`.
4. **`consent_records` already has `org_id`** — no column added.
5. **Dialer link** is `dialer_sessions.campaign_id` plus `touches.dialer_session_id`, not `dialer_queue_items.touch_id`: the engine's attempt-2 retry inserts a new row without the link, so reconciliation keys on (session, record).
6. **`withinCallingHours` and `blockedTargets` move into `@cti/firewall`**; cti-api's `dialer/pick-did.ts` and `dialer/consent-check.ts` re-export them so their importers do not change. One definition of each rule.
7. **Campaign rep calls write no Salesforce Tasks of their own**: the dialer already logs connected calls (call Task) and no-answers (Chatter). Writing more would double-log.
8. **`campaigns.paused_from`** (`dry_run` | `active`) records what an automatic pause interrupted, so the next-day resume of an `ai_budget` pause (plan 1B) can never turn a dry-run campaign into live calls. A manual pause sets it too; leaving `paused` clears it.
9. **Tick queues use pg-boss `policy: 'stately'`** (exported as `TICK_QUEUE_OPTIONS`), not `singleton`: in pg-boss 12.30 `singleton` allows unlimited queued jobs, so a tick slower than its cron would build a backlog. A queue's policy cannot change after creation, so it has to be right on the first deploy.
10. **The planner waits for triage** when the AI is configured: a record still marked `triage_needed` is not planned until triage runs, or 24 hours after enrollment at most, so the first touch uses the notes rather than the default channel order.
11. **A Salesforce outage is not a broken connection.** Only an auth failure (the token endpoint rejects the refresh token) marks the connection broken and pauses the tenant's campaigns; a 5xx is retried on the next tick.
12. **Connect with a full-license Salesforce user for now.** The Connections page signs in through the browser (OAuth web-server flow with PKCE, bound to the starting browser by an httpOnly cookie). Salesforce's free Integration license is API-only and may be refused that sign-in; a client-credentials connection for Integration users is a follow-up.
13. **Task order puts the planner (Task 9) before triage (Task 10)**, because triage imports the settings module the planner task creates. Neither depends on the other's code otherwise.
14. **The preview's skip breakdown covers the first 2,000 members.** `total` counts every member; `eligible` and the skip counts are computed over the first 2,000 (`examined`), so a preview stays one request of at most 11 Salesforce calls. The builder words it as "of the first N checked".
15. **Not in phase 1:** showing the org's remaining daily Salesforce API calls on the Connections page (spec §16). It is a follow-up recorded by plan 1B.

## Spec coverage (phase 1B)

| Spec section | Task |
|---|---|
| §11.1 consent fields and permission set | 1 |
| §11 Salesforce write-back outbox, §12 outage handling | 2 |
| §11.1 consent capture and backfill | 3 |
| §10.1 campaign calls through the dialer (claim, session link) | 4, 5 |
| §10.1 outcomes back into the campaign | 6 |
| §12 kill switches, automatic pauses, alerts | 7 |
| §15 deploy prerequisites, runbook, go-live | 8 |

## Task map

Task text refers to tasks by their drafting ids. This table maps them to the numbered tasks below.

| Task | Id | Title |
|---|---|---|
| 1 | B1 | Salesforce consent fields, the `AI_Outreach` permission set, and the setup runbook |
| 2 | B2 | The Salesforce write outbox (`sf_writes`) and the `sf.write` tick |
| 3 | B3 | Consent capture, backfill, settings routes, and the Consent card |
| 4 | B4 | Campaign calls in the CTI dialer (claim, build, release) |
| 5 | B5 | cti-web — Campaign calls picker |
| 6 | B6 | outreach-api — `calls.reconcile` settles campaign call touches |
| 7 | B7 | Kill switch, automatic pause alerts, AI-budget resume, `GET /status`, banner |
| 8 | B8 | Deploy — IaC variables, `.env.example`, runbook, README, follow-ups |

## Decisions made while writing the tasks

These refine the spec and the outline this plan was drafted from. The task code below already reflects them; they are collected here so a reviewer can see every deliberate deviation in one place.

### Decisions from drafting (tasks B1, B2, B3, B4)

**B1**
1. **Permission set grants differ from "create/edit on Task; read on Lead/Opportunity/Contact/OpportunityContactRole".**
   - **Task:** Task is not granted through `objectPermissions`. The permset uses the `EditTask` user permission plus edit on `Activity.CTI_Origin__c`, which phase 2's Task marker needs.
   - **OpportunityContactRole:** OCR is not a permissionable object. Its access follows the parent Opportunity, so the primary-contact query works with Opportunity read and View All.
   - **Lead, Opportunity and Contact:** read **and edit**, because the outbox updates them. View All, so the Integration user sees every record regardless of sharing. No create, delete or Modify All.
   - **Field-level security:** the permset adds FLS that the plan didn't list. Read on Phone, MobilePhone, Email and Description, and on `Skip_on_Dialer__c`. Edit on `DoNotCall` and `HasOptedOutOfEmail` for Lead and Contact.
   - **Tenant-only custom fields** (notes, extra phone fields, `Lead_Form_Source__c`, `LeadManager__c`) are granted in the org (runbook §0.4). Referencing a field the org lacks fails the whole deploy.
2. **New file `services/outreach-api/src/crm/consent-fields.ts`.** It holds `CONSENT_FIELDS`, `CONSENT_SOURCES`, `ConsentSource`, `CONSENT_OBJECTS`, `CTI_ORIGIN_FIELD` and `CTI_ORIGIN_AI_OUTREACH`. The metadata test pins the XML to these, and B2 and B3 write with them, so a field or picklist rename cannot drift.
3. **Test location.** The metadata test is `services/outreach-api/src/crm/salesforce-metadata.test.ts`, not a `packages/db` file. outreach-api is the code that depends on the field names.
4. **Runbook risk (A5 follow-up).** A `Salesforce Integration`-license user is API-only. A5's Connections flow signs in through the browser (OAuth web-server flow with PKCE), which that user may be refused. Runbook §0.1 gives the fallback, a dedicated full-license `AI Outreach` user with the same permission sets. A client-credentials connection should be a follow-up to A5.

**B2**

5. **`drainOutbox` alert signature.** It is `alert: (orgId: string, text: string) => Promise<void>`, not `(text)`, because the alert must name the tenant.
   - `src/alerts.ts` gains the `'sf_write_failing'` kind and `sfWriteAlert(logger)`.
   - B7 should reuse this kind and function rather than add another.
6. **Code layout.** The outbox is split into `outbox-store.ts` (database), `outbox-writes.ts` (Salesforce) and `outbox.ts` (policy), each under 250 lines. `DrainDeps` gains `store?: OutboxStore` as a test seam.
   - Extra exports: `nextDelayMinutes`, `BACKOFF_MINUTES`, `ALERT_AFTER_MS`, `DEFAULT_DRAIN_BATCH`, `outboxJob`, `doNotContactEnqueuer`, `DbExecutor`, `SfWriteInput`, `DrainDeps`, `DrainResult`, `OutboxRow`, `RetryStamp`, `OutboxStore`, `dbOutboxStore`, `RowOutcome`, `writeRows`, `primaryContacts`, `SF_BATCH`, `DO_NOT_CONTACT_FIELDS`, `errorText`.
   - The row type is `OutboxRow`, a projection of A3's `SfWriteRow`.
7. **Terminal `failed` status.** The plan only described backoff. A per-record error that no retry can fix marks the row `failed` at once: `ENTITY_IS_DELETED`, `INVALID_CROSS_REFERENCE_KEY`, `MALFORMED_ID`, `INVALID_ID_FIELD`, `NOT_FOUND`, `CANNOT_UPDATE_CONVERTED_LEAD`, `NO_PRIMARY_CONTACT`, or a payload that fails its zod schema.
8. **Failure semantics, decided.**
   - `CrmNotConnectedError` and `SalesforceAuthError` are the connection's failure. They leave the tenant's rows `pending`, with no attempt counted and no 24-hour clock started. A8's `crm_broken` pause covers the outage, and B7's alerting applies.
   - `SalesforceApiError`, `RangeError` and transient per-record errors count an attempt with backoff.
9. **Enqueue inside the caller's transaction.** `enqueueSfWrite(db: DbExecutor, …)` accepts a transaction. `doNotContactEnqueuer(db)` is A11's `onConfirmed` and enqueues with A11's `tx`. The `do_not_contact` payload is `{ reason: 'do_not_contact_confirmed' }`, because the kind fixes the fields. The `consent` payload is `{ consent: true, source, at }`, zod-checked at drain.
10. **Queue registration.**
    - `sf.write` reuses A8's `TICK_QUEUE_OPTIONS` (`stately`).
    - Its worker registers only when `cfg.salesforceEnabled`, following A8's pattern.
    - A8's `schedules.test.ts` exact-list assertions are extended to include it.
11. **A13 copy.** B2 updates A13's confirm-do-not-contact dialog copy and its test, as A13's corrections asked.

**B3**

12. **No `BackfillRequest` contract.** The backfill takes no body; the plan's 1B contracts comment listed one. `BackfillResult` counts are `z.number().int().nonnegative()`.
13. **Narrower rule signatures.**
    - `consentFromRecord` takes `Pick<SfRecordSnapshot, 'webFormSource' | 'consentAiCall'>` and `Pick<OutreachSettings, 'consentFromWebForms'>`.
    - `inboundCallerMatches` takes records whose phones are `{ e164 }[]` (the `SfRecordSnapshot` shape) and calls typed `InboundCallRow`. It matches who/what ids on their 15-character form.
    - Added: `planConsent`, `applyConsentPlan`, `loadInboundCalls`, `captureConsentOnRefresh`, `AI_CALL_CONSENT_TYPE`, `INBOUND_CALLS_CAP` (200,000 most recent inbound calls).
14. **Audit keys on PUT.** `PUT /settings/consent` merges with a jsonb `||`, so a concurrent write to another settings key is never lost. When web forms is switched on, it also stores `consentFromWebFormsConfirmedBy` and `consentFromWebFormsConfirmedAt`, which record the admin's confirmation of the consent language. A10's `outreachSettings` ignores unknown keys.
15. **The refresh hook's exact shape.** It is `captureConsentOnRefresh(db, { orgId, snapshots, upserted, now })` inside A8's `if (fetchIds.length > 0)` block. It runs on exactly the records the refresh fetched, before enrollment.

**B4**

16. **The claim lives in `@cti/db`** (`packages/db/src/campaign-calls.ts`), not in cti-api, which re-exports `claimCampaignTouches`, `attachSession` and `releaseTouches`. That gives one definition for both services, and it can be proven in outreach-api's real-PG lane, since cti-api has none.
17. **Claim SQL shape.** It is still one statement, but a locking CTE (`… limit n for update of t skip locked`) followed by `UPDATE touches … FROM picked, campaign_enrollments, crm_records … RETURNING`, rather than `WHERE id IN (SELECT …)`.
    - `OF t` locks only the touch rows. A bare `FOR UPDATE` would also lock the campaign row, and with `SKIP LOCKED` a second rep's claim would then skip every touch of that campaign.
    - A CTE is materialized once, so the limit holds.
    - The claim and due queries also require `campaign_enrollments.status = 'active'`.
18. **Claim return and limit types.** The claim returns `sfObject` as well as `{ touchId, sfRecordId }`, so the run's `objectType` comes from the claimed rows. `limit` is a `number`; cti-api passes `CAMPAIGN_CALL_BATCH = MAX_RUN_RECORDS` (500).
19. **Extra contract and exports.** Added the `StartCampaignCallsResponse` contract for `{ sessionId, total }`. Also added `startCampaignCalls`, `StartCampaignCallsResult`, `StartCampaignCallsDeps` and `CAMPAIGN_CALL_BATCH` in cti-api, and `dueCampaignCallRows`, the `*Sql` builders, `SqlExecutor`, `DueCampaignCallRow` and `ClaimedCampaignTouch` in `@cti/db`.
20. **No transaction across the build.** The claim commits before the Salesforce build, so no lock is held across HTTP. Attach and release are separate statements that touch only rows still `dialing`. Release clears `dialer_session_id` and `claimed_at`. Both routes answer in cti-api's `{ error }` shape, not outreach-api's error envelope.

### Decisions from drafting (tasks B5, B6, B7, B8)

1. **B5: `onStartFromCampaign` is optional** (`onStartFromCampaign?: …`), not required. App passes it. Other `DialerPanel` renderers, and their tests, compile unchanged and show no picker.
2. **B5: `getCampaignCalls()` parses the body** with B4's `CampaignCallsResponse`; a malformed body hides the picker. `dialer-api.ts` also gains `campaignStartErrorText(e)`, which turns B4's 404 into "No campaign calls are due right now. Another rep may have just started them." The picker lists only campaigns with `due > 0`.
3. **B6: queue-item status `done` counts as connected.** An item becomes `done` only from `connected`, when the rep presses Next, End call or Redial. The plan listed `done` among the settled no-connect statuses, which would have recorded most real connects as misses.
4. **B6: outcome and skip reason.** A sent touch's outcome is the **last `no_connect`** item's outcome, ordered by attempt then ordinal. It is not "the last item's outcome", which can be a retry row's dial-time skip. A skipped touch's reason is the first item's `outcome ?? status`, because `unreachable` items have a null outcome.
5. **B6: ended runs.** When a run is `stopped` or `done`, the settled items still decide: a miss whose retry never dialed is `sent`. Only a record the run never reached is released to `queued`. A `dialing` item in a run that ended less than 10 minutes ago waits for Twilio's status callback.
6. **B6: additions the plan did not list:**
   - a run left `ready` (never started) for 2 hours is stopped by compare-and-swap on `ready`, and its touches are released;
   - a touch whose run row is gone is released;
   - releasing a touch whose enrollment is no longer `active` (it exited while the call was claimed, and `exitEnrollment` cancels only `planned|held|queued`) makes it `skipped` with the enrollment's exit reason, counted in `touches_done`;
   - a connected touch also counts in `touches_done` and clears `next_touch_at`, guarded by `touches_done < seq`, although `advanceAfterTouch` is not called;
   - non-connected touches of a non-`active` enrollment are counted without moving the sequence;
   - `reconcileCampaignCalls` takes an optional `batch` (default 1000).
7. **Raw `db.execute` returns `timestamptz` columns as strings** under drizzle's node-postgres driver. Pool `query` returns `Date`s. `reconcile.ts` converts with `toDate`, and any other raw-execute reader of timestamps must do the same.
8. **B4: `attachSession` and `releaseTouches` should match the touch's own claim.** They should also require `dialer_session_id is null`, and ideally `claimed_at` equal to that claim's time, not only `status = 'dialing'`. Otherwise a build that outlives reconcile's 10-minute stale-claim release can stamp or release a touch another rep has re-claimed. B6 itself is safe, because every write compares on its own session id. This is recorded in the follow-ups.
9. **B7 relies on A8's `campaigns.paused_from`** (A8 plan outline correction 1) and on A8's `pauseOrgCampaigns`. B7 adds no migration. The resume returns each campaign to `coalesce(paused_from, 'dry_run')`, so a dry-run campaign is never made live, and it clears `paused_from` and `pause_reason`. `crm_broken` pauses never auto-resume.
10. **B7: the AI-budget resume.** "Auto-resume at the next UTC day" is implemented as "resume while today's (UTC) spend is under the budget", checked at the start of every `touch.plan` tick. No `paused_at` column is needed, and a budget an admin raises takes effect the same day. It runs on `touch.plan`, which always has a worker, not on `record.triage`, which runs only with Salesforce and AI configured.
11. **B7: `OUTREACH_KILL_SWITCH` is read by both services.** Each has its own config key, and every gate is an additive optional parameter.
    - outreach-api:
      - `promoteQueuedCalls(db, now, { killSwitch })` is the gate; A10's `planTick` passes `PlanDeps.killSwitch` through, so planning continues;
      - `drainOutbox` gets `DrainDeps.killSwitch`.
    - cti-api gates `dueCampaignCalls(…, { killSwitch })` and `startCampaignCalls` (`deps.killSwitch`), not `claimCampaignTouches`, which B4 moved into `@cti/db` as the shared claim protocol. The effect is the same: nothing is claimed, and the start answers B4's 404.
    - B7 never writes `pause_reason = 'kill_switch'`. The switch changes no campaign status, and that value stays reserved in A7's vocabulary.
12. **B7: the status route.** `GET /status` is served at `GET /api/status`, under the `/api` scope like every route. It requires a session (`requireContext`). Its body is a new contract, `OutreachStatus = z.object({ killSwitch: z.boolean() })`, in `packages/contracts/src/status.ts`.
13. **B7: alerts reuse B2's plumbing.** The shape is `(orgId: string, message: string) => Promise<void>`, the same as `DrainDeps.alert` and `sfWriteAlert`; it is named `OrgAlert`.
    - `alerts.ts` gains the kind `'campaigns_paused'` and `campaignsPausedAlert(logger)`, a warning. A `crm_broken` message starts "Action needed:".
    - `pauseOrgCampaigns` gains an optional fourth `alert`. It alerts only when its UPDATE paused something, which makes it once per pause.
    - `RefreshDeps.alert?` and `TriageDeps.alert?` thread the alert through.
    - The outbox's 24-hour alert is B2's (`sfWriteAlert`, kind `sf_write_failing`), not B7's.
14. **B7: web.** The paused-campaign banner with the reason in words already ships in A12/A13: `pauseReasonWords` on the list, and `CampaignBanners` on the campaign page. B7 adds only the kill-switch banner. It lives in `AppShell`, so it shows on every signed-in page, not just the campaign pages, and its words are in `outreach-words.ts` (`KILL_SWITCH_WORDS`). B7 also corrects A12's `ai_budget` words from "resumes tomorrow" to "resumes at 00:00 UTC", which is the same afternoon in Pacific time, and updates the two test rows.
15. **B8: deploy details.**
    - B8 also `preserve()`s `ALERT_WEBHOOK_URL` on outreachApi; undeclared variables are deleted by apply, so without it the B7 alerts never leave the log.
    - B8 declares `OUTREACH_KILL_SWITCH` on `_ctiapi` as well as on outreachApi.
    - B8 appends to the runbook that B1 creates.
    - The real-PG suites run through root `npm run test:pg`.
    - The follow-ups go into the existing `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md` as a new section. They include five beyond the plan's three: paused runs, transient skips, the two-service switch, the claim race, and the spec §9 vocabulary.
16. **Queue options.** `calls.reconcile` reuses A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`), not the plan's `'singleton'` (A8 plan outline correction 2).
17. **B8 fixes an existing bug in `.env.example`.** It shipped `WORKOS_REDIRECT_URI` filled in with an empty key and client id, which fails `parseConfig` ("set all three or none"). The redirect URI is now empty, with the local value in a comment, and a config test boots the file as written.

---

### Task 1: Salesforce consent fields, the `AI_Outreach` permission set, and the setup runbook [B1]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> **Packages are consumed through `dist/`.** `@cti/db` and `@cti/contracts` resolve to their built `dist/` files. After any task step that edits `packages/*`, run `npm run build:packages` before running a service's tests.
>
> **Cross-draft decisions applied here:**
> - A11's `onConfirmed(args, tx)` runs inside the confirm transaction, and B2 enqueues with that `tx`.
> - `@cti/salesforce` throws `SalesforceAuthError` when the token refresh fails and `SalesforceApiError` for 5xx or an unreadable response. `createRecords` and `updateRecords` throw `RangeError` above 200 records and return `[]` for empty input.
> - Tests reuse A5's extended `fakeDb` harness.
> - `opt_outs` has `source` and `note`.
> - Tick queues reuse A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`).
> - No B1–B4 code pauses a campaign. A broken connection leaves outbox rows pending, and A8's `pauseOrgCampaigns(…, 'crm_broken')` does the pausing.
>

This task ships the three AI-call consent fields on Lead and Opportunity (spec §11.1) and the permission set for the company-wide Integration user (spec §5). It also adds the runbook section an operator follows to deploy them. A read-from-disk test pins the XML to the constants that B2 and B3 write with, so a renamed field or picklist value fails in CI instead of in Salesforce.

The permission set grants only what phase 1 needs:
- **Edit** on the consent fields, and on `DoNotCall` and `HasOptedOutOfEmail` for Lead and Contact.
- **Read** on the standard phone, email and description fields that the campaign engine reads.
- **Read, edit and View All** on Lead, Opportunity and Contact. No create, no delete, no Modify All.
- **Edit Tasks** and `Activity.CTI_Origin__c`, for the phase 2 Task marker.

Tenant-only custom fields (notes, extra phone fields, web-form source) cannot appear in a repo permission set, because a reference to a field the org lacks fails the whole deploy. The runbook grants them in the org instead.

**Files:**
- Create: `salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml`, `AI_Call_Consent_Date__c.field-meta.xml`, `AI_Call_Consent_Source__c.field-meta.xml`
- Create: `salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml`, `AI_Call_Consent_Date__c.field-meta.xml`, `AI_Call_Consent_Source__c.field-meta.xml`. These are byte-identical to the Lead files.
- Create: `salesforce/force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml`
- Create: `services/outreach-api/src/crm/consent-fields.ts`
- Test: `services/outreach-api/src/crm/salesforce-metadata.test.ts`
- Create: `docs/runbooks/outreach-sf-campaigns.md` (§0, Salesforce setup. B8 appends the deploy and go-live sections.)

**Interfaces:**
- Consumes: the existing `Activity.CTI_Origin__c` and the `Skip_on_Dialer__c` fields on Lead and Opportunity, plus the deploy rules in `salesforce/README.md`. Nothing from earlier tasks.
- Produces:
  ```ts
  // services/outreach-api/src/crm/consent-fields.ts
  export const CONSENT_FIELDS: { readonly checkbox: 'AI_Call_Consent__c'; readonly date: 'AI_Call_Consent_Date__c'; readonly source: 'AI_Call_Consent_Source__c' };
  export const CONSENT_SOURCES: readonly ['Text Reply', 'Email Reply', 'Web Form', 'Inbound Call', 'Rep'];
  export type ConsentSource = (typeof CONSENT_SOURCES)[number];
  export const CONSENT_OBJECTS: readonly ['Lead', 'Opportunity'];
  export const CTI_ORIGIN_FIELD = 'CTI_Origin__c';
  export const CTI_ORIGIN_AI_OUTREACH = 'AI Outreach';
  ```
  Salesforce metadata:
  - On Lead and Opportunity: `AI_Call_Consent__c` (Checkbox, default false), `AI_Call_Consent_Date__c` (DateTime), and `AI_Call_Consent_Source__c` (restricted Picklist with the five values in `CONSENT_SOURCES` order).
  - Permission set `AI_Outreach`.
  - Runbook `docs/runbooks/outreach-sf-campaigns.md` §0.

- [ ] **Step 1: Write the failing test**

`services/outreach-api/src/crm/salesforce-metadata.test.ts`:
```ts
/**
 * The Salesforce metadata that 1B deploys (B1) — pinned. Read from disk (no org
 * in the unit suite), so the files' text IS the contract, the same way
 * packages/db's migration-NNNN tests pin SQL. The field names and picklist
 * values are pinned against `consent-fields.ts`, the constants the outbox
 * writes with: rename one side and this fails before a deploy can.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONSENT_FIELDS, CONSENT_OBJECTS, CONSENT_SOURCES } from './consent-fields.js';

const here = dirname(fileURLToPath(import.meta.url));
/** services/outreach-api/src/crm → repo root. */
const FORCE_APP = resolve(here, '../../../../salesforce/force-app/main/default');
const read = (rel: string): string => readFileSync(resolve(FORCE_APP, rel), 'utf8');

/** Inner text of every `<tag>…</tag>` in document order (none of these tags nest in themselves). */
function tagValues(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!.trim());
}
function only(xml: string, tag: string): string {
  const values = tagValues(xml, tag);
  expect(values, `<${tag}> count`).toHaveLength(1);
  return values[0]!;
}
const fieldFile = (object: string, field: string): string => `objects/${object}/fields/${field}.field-meta.xml`;

describe.each(CONSENT_OBJECTS)('%s consent fields', (object) => {
  it('every field file exists and names itself', () => {
    for (const field of Object.values(CONSENT_FIELDS)) {
      expect(existsSync(resolve(FORCE_APP, fieldFile(object, field))), field).toBe(true);
      const xml = read(fieldFile(object, field));
      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">')).toBe(true);
      expect(tagValues(xml, 'fullName')[0]).toBe(field);
    }
  });

  it('AI_Call_Consent__c is a checkbox that defaults to unticked', () => {
    const xml = read(fieldFile(object, CONSENT_FIELDS.checkbox));
    expect(only(xml, 'type')).toBe('Checkbox');
    expect(only(xml, 'defaultValue')).toBe('false');
    expect(only(xml, 'label')).toBe('AI Call Consent');
  });

  it('AI_Call_Consent_Date__c is a date/time', () => {
    const xml = read(fieldFile(object, CONSENT_FIELDS.date));
    expect(only(xml, 'type')).toBe('DateTime');
    expect(only(xml, 'label')).toBe('AI Call Consent Date');
    expect(only(xml, 'required')).toBe('false');
  });

  it('AI_Call_Consent_Source__c is a RESTRICTED picklist whose values are exactly CONSENT_SOURCES, in order, none default', () => {
    const xml = read(fieldFile(object, CONSENT_FIELDS.source));
    expect(only(xml, 'type')).toBe('Picklist');
    expect(only(xml, 'restricted')).toBe('true');
    expect(only(xml, 'sorted')).toBe('false');
    const values = tagValues(xml, 'value');
    expect(values.map((v) => tagValues(v, 'fullName')[0])).toEqual([...CONSENT_SOURCES]);
    expect(values.map((v) => tagValues(v, 'label')[0])).toEqual([...CONSENT_SOURCES]);
    expect(values.map((v) => tagValues(v, 'default')[0])).toEqual(CONSENT_SOURCES.map(() => 'false'));
  });
});

describe('AI_Outreach permission set', () => {
  const xml = read('permissionsets/AI_Outreach.permissionset-meta.xml');
  const fieldPerms = new Map(
    tagValues(xml, 'fieldPermissions').map((b) => [only(b, 'field'), { readable: only(b, 'readable'), editable: only(b, 'editable') }]),
  );
  const objectPerms = new Map(tagValues(xml, 'objectPermissions').map((b) => [only(b, 'object'), b]));

  it('is labelled AI Outreach and bound to no license (assignable to an Integration user)', () => {
    expect(only(xml, 'label')).toBe('AI Outreach');
    expect(xml).not.toContain('<license>');
    expect(only(xml, 'hasActivationRequired')).toBe('false');
  });

  it('grants read + edit on all six consent fields', () => {
    for (const object of CONSENT_OBJECTS) {
      for (const field of Object.values(CONSENT_FIELDS)) {
        expect(fieldPerms.get(`${object}.${field}`), `${object}.${field}`).toEqual({ readable: 'true', editable: 'true' });
      }
    }
  });

  it('grants edit on the do-not-contact flags of Lead and Contact, and on the Task marker', () => {
    for (const f of ['Lead.DoNotCall', 'Lead.HasOptedOutOfEmail', 'Contact.DoNotCall', 'Contact.HasOptedOutOfEmail', 'Activity.CTI_Origin__c']) {
      expect(fieldPerms.get(f), f).toEqual({ readable: 'true', editable: 'true' });
    }
  });

  it('grants every other field read-only', () => {
    const editable = new Set([
      ...CONSENT_OBJECTS.flatMap((o) => Object.values(CONSENT_FIELDS).map((f) => `${o}.${f}`)),
      'Lead.DoNotCall', 'Lead.HasOptedOutOfEmail', 'Contact.DoNotCall', 'Contact.HasOptedOutOfEmail', 'Activity.CTI_Origin__c',
    ]);
    for (const [field, perm] of fieldPerms) {
      expect(perm.readable, field).toBe('true');
      if (!editable.has(field)) expect(perm.editable, field).toBe('false');
    }
    for (const f of ['Lead.Phone', 'Lead.MobilePhone', 'Lead.Email', 'Contact.Phone', 'Contact.MobilePhone', 'Contact.Email', 'Lead.Skip_on_Dialer__c', 'Opportunity.Skip_on_Dialer__c']) {
      expect(fieldPerms.has(f), f).toBe(true);
    }
  });

  it('Lead, Opportunity and Contact: read, edit and View All — never create, delete or Modify All', () => {
    expect([...objectPerms.keys()].sort()).toEqual(['Contact', 'Lead', 'Opportunity']);
    for (const [object, block] of objectPerms) {
      expect({
        allowCreate: only(block, 'allowCreate'), allowDelete: only(block, 'allowDelete'), allowEdit: only(block, 'allowEdit'),
        allowRead: only(block, 'allowRead'), modifyAllRecords: only(block, 'modifyAllRecords'), viewAllRecords: only(block, 'viewAllRecords'),
      }, object).toEqual({
        allowCreate: 'false', allowDelete: 'false', allowEdit: 'true', allowRead: 'true', modifyAllRecords: 'false', viewAllRecords: 'true',
      });
    }
  });

  it('the only system permission is Edit Tasks', () => {
    const perms = tagValues(xml, 'userPermissions').map((b) => ({ name: only(b, 'name'), enabled: only(b, 'enabled') }));
    expect(perms).toEqual([{ name: 'EditTask', enabled: 'true' }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts
```

Expected: `FAIL src/crm/salesforce-metadata.test.ts`, with `Error: Failed to load url ./consent-fields.js (resolved id: ./consent-fields.js) in …/salesforce-metadata.test.ts. Does the file exist?` and `Tests  no tests`.

- [ ] **Step 3: Write the constants**

`services/outreach-api/src/crm/consent-fields.ts`:
```ts
/**
 * The Salesforce field contract for AI-call consent (spec §11.1), in one place.
 *
 * The metadata that creates these fields lives in
 * `salesforce/force-app/main/default/objects/{Lead,Opportunity}/fields/` and is
 * pinned against THESE constants by `salesforce-metadata.test.ts` — rename one
 * side and that test fails, so the outbox can never write a field or a picklist
 * value the org does not have.
 */
export const CONSENT_FIELDS = {
  checkbox: 'AI_Call_Consent__c',
  date: 'AI_Call_Consent_Date__c',
  source: 'AI_Call_Consent_Source__c',
} as const;

/** Picklist values of `AI_Call_Consent_Source__c`, in picklist order. */
export const CONSENT_SOURCES = ['Text Reply', 'Email Reply', 'Web Form', 'Inbound Call', 'Rep'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** The objects that carry the consent fields. */
export const CONSENT_OBJECTS = ['Lead', 'Opportunity'] as const;

/** The CTI's Task marker field (salesforce/.../Activity/fields/CTI_Origin__c) and this system's value for it. */
export const CTI_ORIGIN_FIELD = 'CTI_Origin__c';
export const CTI_ORIGIN_AI_OUTREACH = 'AI Outreach';
```

- [ ] **Step 4: Write the six field files**

Write each of the three files below twice: once under `salesforce/force-app/main/default/objects/Lead/fields/`, and once with identical contents under `salesforce/force-app/main/default/objects/Opportunity/fields/`. A field file carries no object name.

`AI_Call_Consent__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AI_Call_Consent__c</fullName>
    <defaultValue>false</defaultValue>
    <description>Checked = this person agreed to calls from the AI assistant. Set by AI Outreach when it captures consent (a text or email reply, a web form, an inbound call) or by a rep. AI Outreach never places an AI call to a record without this box. Where and when consent came from are in AI Call Consent Source and AI Call Consent Date. (Outreach spec 2026-10-04, section 11.1.)</description>
    <externalId>false</externalId>
    <inlineHelpText>Tick only when this person has agreed to calls from our AI assistant. If you tick it yourself, set AI Call Consent Source to Rep.</inlineHelpText>
    <label>AI Call Consent</label>
    <trackTrending>false</trackTrending>
    <type>Checkbox</type>
</CustomField>
```

`AI_Call_Consent_Date__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AI_Call_Consent_Date__c</fullName>
    <description>When AI-call consent was captured. Set by AI Outreach together with AI Call Consent. (Outreach spec 2026-10-04, section 11.1.)</description>
    <externalId>false</externalId>
    <inlineHelpText>When this person agreed to calls from our AI assistant.</inlineHelpText>
    <label>AI Call Consent Date</label>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>DateTime</type>
</CustomField>
```

`AI_Call_Consent_Source__c.field-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>AI_Call_Consent_Source__c</fullName>
    <description>Where AI-call consent came from: Text Reply, Email Reply, Web Form, Inbound Call, or Rep (a person ticked AI Call Consent). Set by AI Outreach together with AI Call Consent. The values are written by code - do not rename them. (Outreach spec 2026-10-04, section 11.1.)</description>
    <externalId>false</externalId>
    <inlineHelpText>Where this person agreed to calls from our AI assistant. Choose Rep when you tick AI Call Consent yourself.</inlineHelpText>
    <label>AI Call Consent Source</label>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value>
                <fullName>Text Reply</fullName>
                <default>false</default>
                <label>Text Reply</label>
            </value>
            <value>
                <fullName>Email Reply</fullName>
                <default>false</default>
                <label>Email Reply</label>
            </value>
            <value>
                <fullName>Web Form</fullName>
                <default>false</default>
                <label>Web Form</label>
            </value>
            <value>
                <fullName>Inbound Call</fullName>
                <default>false</default>
                <label>Inbound Call</label>
            </value>
            <value>
                <fullName>Rep</fullName>
                <default>false</default>
                <label>Rep</label>
            </value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

- [ ] **Step 5: Write the permission set**

`salesforce/force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!--
  The AI Outreach integration user's permission set (outreach spec 2026-10-04,
  section 5). Assign it to the Salesforce Integration user that
  services/outreach-api connects as - never to reps.

  What it grants, and why each part is needed:
  - read + edit on the three AI Call Consent fields on Lead and Opportunity:
    the outbox (services/outreach-api/src/crm/outbox.ts) writes captured consent;
  - read + edit on DoNotCall / HasOptedOutOfEmail on Lead and Contact: a
    confirmed do-not-contact sets them (Opportunity has no such fields, so the
    primary contact role's Contact is updated instead);
  - read on the standard phone, email and description fields the campaign
    engine reads, and on Skip_on_Dialer__c;
  - read + edit + View All on Lead, Opportunity and Contact - no create, no
    delete, no Modify All: v1 never creates, converts or deletes records;
  - Edit Tasks, and edit on Activity.CTI_Origin__c, for the AI Outreach Task
    marker (phase 2 writes Tasks; phase 1 writes none).

  Tenant-specific custom fields (notes, extra phone fields, web form source,
  lead manager) are NOT here: they exist only in that tenant's org, and a
  reference to a missing field fails the whole deploy. The runbook
  (docs/runbooks/outreach-sf-campaigns.md, Salesforce setup) grants them
  in-org instead.

  The API name is load-bearing: the runbook and salesforce-metadata.test.ts
  refer to it by AI_Outreach.
-->
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>For the AI Outreach integration user only. Reads campaign records and writes AI-call consent and do-not-contact flags. Grants no create, delete or Modify All. See the comment in this file.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Activity.CTI_Origin__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Contact.DoNotCall</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.Email</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Contact.HasOptedOutOfEmail</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.MobilePhone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Contact.Phone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.AI_Call_Consent_Date__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.AI_Call_Consent_Source__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.AI_Call_Consent__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Description</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.DoNotCall</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Email</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Lead.HasOptedOutOfEmail</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.MobilePhone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Phone</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Lead.Skip_on_Dialer__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Opportunity.AI_Call_Consent_Date__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Opportunity.AI_Call_Consent_Source__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Opportunity.AI_Call_Consent__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Opportunity.Description</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Opportunity.Skip_on_Dialer__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>AI Outreach</label>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Contact</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Lead</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Opportunity</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
    <userPermissions>
        <enabled>true</enabled>
        <name>EditTask</name>
    </userPermissions>
</PermissionSet>
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts && npm -w services/outreach-api run typecheck
```

Expected: `✓ src/crm/salesforce-metadata.test.ts (14 tests)`, then `Tests  14 passed (14)`. The typecheck exits 0 with no output.

- [ ] **Step 7: Write the runbook's Salesforce setup section**

`docs/runbooks/outreach-sf-campaigns.md`:
````markdown
# Outreach Salesforce campaigns — operator runbook

Everything here is a human step. The code ships with plan 1B (`docs/superpowers/plans/2026-10-04-sf-campaigns-1b-live-calls.md`); the design is `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md`.

The target org is alias `_t2` (`gghsd.my.salesforce.com`). **It is PRODUCTION.** Read `salesforce/README.md` first: never deploy with `-d force-app` or `-d force-app/main/default`, because that pushes the stale `layouts/` snapshots over the org's live layouts.

## 0. Salesforce setup (one time, ~30 minutes)

outreach-api connects to Salesforce as one company-wide **Integration user**, never as a rep. That user gets exactly the access in the `AI_Outreach` permission set, plus an in-org permission set for the tenant's own custom fields.

1. **Create the Integration user.** Setup → Users → New User:
   - **User License:** `Salesforce Integration`. **Profile:** `Minimum Access - API Only Integrations`.
   - Name it so it reads well on records it touches, for example `AI Outreach`. Use a real mailbox you control for the email.
   - Save, then on the user's page → **Permission Set License Assignments** → **Edit Assignments** → tick `Salesforce API Integration` → Save.

   > **Risk to check before step 5:** an API-only user cannot sign in to the Salesforce web UI, and the Connections page (§0.5) signs in through the browser (OAuth web-server flow with PKCE). If the browser sign-in is refused for this user, use a dedicated full-license user named `AI Outreach` with the same permission sets instead, and raise it with the outreach-api owners. A client-credentials connection for the Integration user is a planned follow-up, not built yet.

2. **Validate, then deploy the consent fields and the `AI_Outreach` permission set.** From the repo root on `main`, in `salesforce/`. Name the seven files explicitly:

   ```bash
   cd salesforce
   SRC=(
     force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml
     force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml
     force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
   )
   sf project deploy validate -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded`. If it is refused:
   - `Field … is not permissionable` (or a similar FLS error) on a standard field: delete that one `<fieldPermissions>` block from `AI_Outreach.permissionset-meta.xml`, then run `npm -w services/outreach-api run test -- src/crm/salesforce-metadata.test.ts`. Update the test's expected list to match, commit both, and validate again.
   - Anything about `layouts`: you passed a directory. Pass only the seven files above.

   Then deploy the same seven files:

   ```bash
   sf project deploy start -o _t2 $(printf -- '--source-dir %s ' "${SRC[@]}")
   ```

   Expect `Status: Succeeded` and seven `Created` rows. Reruns show `Unchanged`.

3. **Assign `AI_Outreach` to the Integration user.**

   ```bash
   sf org assign permset -n AI_Outreach -o _t2 -b <integration username>
   ```

   If the assignment is refused because **Edit Tasks** is not allowed by the user's license, remove the `<userPermissions>` block (`EditTask`) and the `Activity.CTI_Origin__c` `<fieldPermissions>` block, and update the metadata test to match. Then redeploy (step 2) and retry the assignment. Phase 1 writes no Tasks; restore both blocks before phase 2 starts writing them.

4. **Grant the tenant's own fields in the org.** These fields exist only in this org, so they cannot live in the repo permission set: a reference to a missing field fails the whole deploy. Setup → Permission Sets → New: Label `AI Outreach Fields`, API name `AI_Outreach_Fields`, no license. Under **Object Settings**, grant **Read** on:
   - **Lead:** Address (State), `Notes__c`, `Agent_Notes__c`, `Motivation__c`, `SecondaryMotivation__c`, `Appointment_Notes__c`, `Analyst_Notes__c`, `Lead_Form_Source__c`, `LeadManager__c`.
   - **Opportunity:** `Mobile_Phone__c`, `Phone__c`, `Other_Phone__c`, `Lead_Form_Source__c`, `LeadManager__c`, and whichever notes fields the tenant's Opportunity field map reads.
   - **Task:** Description.

   Grant only the fields this tenant's field map uses (Settings → Connections → field map). Assign the set to the Integration user. Skip any field the org doesn't have.

5. **Connected app** (Setup → App Manager → New Connected App, or New External Client App):
   - Callback URL: `${API_PUBLIC_URL}/api/connections/salesforce/callback`, using outreach-api's public URL from `outreach-api-deploy.md` §2.
   - OAuth scopes: `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`.
   - Require **PKCE**. Refresh token policy: **valid until revoked**. Under **Manage → Edit Policies**, set Permitted Users to "Admin approved users are pre-authorized" and add the `AI Outreach` permission set, so only the Integration user can use the app.
   - Set the outreach-api Railway variables `SALESFORCE_CLIENT_ID` (consumer key), `SALESFORCE_CLIENT_SECRET` (consumer secret; outreach-api sends it when it is set), and `SALESFORCE_REDIRECT_URI` (the callback URL above). Then redeploy outreach-api.
   - In outreach-web, open **Settings → Connections** as an admin, choose **Connect Salesforce**, and sign in **as the Integration user**. The page should show it as connected with the Integration user's username.

6. **Optional, in Setup only:** to let reps see the consent fields, add them to the Lead and Opportunity page layouts through the Setup UI. **Do not** deploy layouts from the repo (`salesforce/README.md`). If reps should record consent themselves (source `Rep`), give their profile or permission set **edit** on the three fields.

**Check:** on any Lead, Setup → Object Manager → Lead → Fields shows `AI Call Consent`, `AI Call Consent Date`, and `AI Call Consent Source` with five values in order: Text Reply, Email Reply, Web Form, Inbound Call, Rep.
````

- [ ] **Step 8: (Operator, optional now) Validate against the org**

This is a check-only deploy, so it changes nothing in the org. Run it only if alias `_t2` is already authenticated on this machine. Otherwise B8's go-live runs runbook §0 in full.

```bash
cd "$(git rev-parse --show-toplevel)/salesforce" && sf project deploy validate -o _t2 \
  --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml \
  --source-dir force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml \
  --source-dir force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml
```

Expected: `Status: Succeeded`. If a `<fieldPermissions>` block is refused as not permissionable, follow runbook §0.2: remove the block, update the test's expected list, rerun Step 6, then validate again.

- [ ] **Step 9: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent_Date__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Lead/fields/AI_Call_Consent_Source__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Date__c.field-meta.xml \
  salesforce/force-app/main/default/objects/Opportunity/fields/AI_Call_Consent_Source__c.field-meta.xml \
  salesforce/force-app/main/default/permissionsets/AI_Outreach.permissionset-meta.xml \
  services/outreach-api/src/crm/consent-fields.ts \
  services/outreach-api/src/crm/salesforce-metadata.test.ts \
  docs/runbooks/outreach-sf-campaigns.md
git commit -m "feat(salesforce): add AI call consent fields and the AI_Outreach permission set"
```

---

### Task 2: The Salesforce write outbox (`sf_writes`) and the `sf.write` tick [B2]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> **Packages are consumed through `dist/`.** `@cti/db` and `@cti/contracts` resolve to their built `dist/` files. After any task step that edits `packages/*`, run `npm run build:packages` before running a service's tests.
>
> **Cross-draft decisions applied here:**
> - A11's `onConfirmed(args, tx)` runs inside the confirm transaction, and B2 enqueues with that `tx`.
> - `@cti/salesforce` throws `SalesforceAuthError` when the token refresh fails and `SalesforceApiError` for 5xx or an unreadable response. `createRecords` and `updateRecords` throw `RangeError` above 200 records and return `[]` for empty input.
> - Tests reuse A5's extended `fakeDb` harness.
> - `opt_outs` has `source` and `note`.
> - Tick queues reuse A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`).
> - No B1–B4 code pauses a campaign. A broken connection leaves outbox rows pending, and A8's `pauseOrgCampaigns(…, 'crm_broken')` does the pausing.
>

All Salesforce writes go through the `sf_writes` table (spec §12). A caller queues a row inside its own transaction. The `sf.write` tick runs every minute and drains due rows per tenant in sObject Collections batches of up to 200:
- `consent` → updates the three consent fields.
- `do_not_contact` → sets `DoNotCall` and `HasOptedOutOfEmail` on a Lead. For an Opportunity it sets them on the opportunity's primary contact role's Contact, looked up when the row drains.
- `task` → creates a Task with `CTI_Origin__c = 'AI Outreach'`. On `INVALID_FIELD` it retries once without the marker. Nothing in 1B queues `task` rows; phase 2 does.

How each failure is handled:
- **A transient failure** (5xx, `SalesforceApiError`, `RangeError`, an unknown per-record code): counts one attempt and waits 1, 5, 30, 120, then 360 minutes, and 360 from then on. The first such failure stamps `first_failed_at`.
- **A row failing for 24 hours:** alerts once (`alerted_at`).
- **A per-record error no retry can fix** (deleted or malformed id, converted Lead, no primary contact, bad payload): the row becomes terminal `failed` at once.
- **A broken connection** (`CrmNotConnectedError`, or a `SalesforceAuthError` from a failed token refresh): the tenant's rows stay `pending` with nothing counted. A8's refresh already pauses the tenant's running campaigns (`crm_broken`), and the rows drain in order on the first tick after an admin reconnects.

A11's confirm-do-not-contact hook queues the `do_not_contact` row in A11's own transaction. The review dialog then says so.

**Files:**
- Create: `services/outreach-api/src/crm/outbox-store.ts` (database side), `services/outreach-api/src/crm/outbox-writes.ts` (Salesforce side), `services/outreach-api/src/crm/outbox.ts` (policy: enqueue, backoff, drain, alert)
- Test: `services/outreach-api/src/crm/outbox.test.ts`, `services/outreach-api/src/crm/outbox.pg.test.ts`, `services/outreach-api/src/crm/outbox-wiring.test.ts`
- Modify: `services/outreach-api/src/alerts.ts`: the `kind` union (lines 15–18), plus a new export appended at the end
- Modify: `services/outreach-api/src/jobs/queues.ts` and `services/outreach-api/src/jobs/schedules.ts` (A8's files): the `QUEUES` and `SCHEDULES` arrays
- Modify: `services/outreach-api/src/jobs/schedules.test.ts` (A8's test): its two exact-list assertions
- Modify: `services/outreach-api/src/server.ts`: the import list, A8's `handlers` object (`grep -n "handlers" services/outreach-api/src/server.ts`), and A11's `registerReviewRoutes` entry in `apiRoutes` (`grep -n "registerReviewRoutes" services/outreach-api/src/server.ts`)
- Modify: `apps/outreach-web/src/components/review-page.tsx` (A13): the `description` of the confirm `ConfirmAction`. Find it with `grep -n "out of everything:" apps/outreach-web/src/components/review-page.tsx`.
- Modify: `apps/outreach-web/src/components/review-page.test.tsx` (A13): one assertion in `it('confirms do-not-contact only after a dialog that explains it opts the person out of everything'`

**Interfaces:**
- Consumes:
  - **A3:** `schema.sfWrites` and the `SfWriteRow` type from `@cti/db`. `createTestDb()` and `pgLane` from `src/test/pg.ts`, and `npm run test:pg`.
  - **A5:**
    - From `src/crm/client-factory.ts`: `CrmNotConnectedError`, and `type SalesforceClientFactory = (orgId: string) => Promise<SalesforceClient>`.
    - From `@cti/salesforce`: `SalesforceClient` (`query`, `createRecords`, `updateRecords`), `SalesforceAuthError`, `SalesforceApiError`, `type CompositeResult`, `soqlEscape`.
    - From `src/test/harness.ts`: `fakeDb` (`tables`, `selectResults`, `insertDefaults`, `captured`).
    - The server wiring `const clients = liveClientFactory(db, cfg);`.
  - **A8:**
    - From `src/jobs/boss.ts`: `type RunnerLogger`, `type JobHandler`, and `JobRunner`'s `handlers`/`schedules`.
    - `TICK_QUEUE_OPTIONS` and `QUEUES` from `src/jobs/queues.ts`, and `SCHEDULES` from `src/jobs/schedules.ts`.
  - **A11:** `ReviewRouteDeps.onConfirmed?: (args: ConfirmedDoNotContact, tx: Db) => Promise<void>`, called inside the confirm transaction.
  - **B1:** `CONSENT_FIELDS`, `CONSENT_SOURCES`, `CTI_ORIGIN_FIELD`, `CTI_ORIGIN_AI_OUTREACH`.
  - **Existing:** `dispatchAlert` and `type AlertLogger` in `src/alerts.ts`.
- Produces:
  ```ts
  // src/crm/outbox.ts
  export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];   // a Db or a transaction on it
  export const BACKOFF_MINUTES: readonly [1, 5, 30, 120, 360];
  export const ALERT_AFTER_MS: number;          // 24 h
  export const DEFAULT_DRAIN_BATCH = 200;
  export function nextDelayMinutes(attempts: number): number;   // attempts after this failure → minutes
  export interface SfWriteInput { orgId: string; kind: SfWriteKind; sfObject: string; sfRecordId: string; payload: Record<string, unknown> }
  export function enqueueSfWrite(db: DbExecutor, w: SfWriteInput): Promise<void>;
  export interface DrainDeps { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger; alert: (orgId: string, text: string) => Promise<void>; batch?: number /* 200 */; store?: OutboxStore }
  export interface DrainResult { done: number; failed: number }
  export function drainOutbox(deps: DrainDeps): Promise<DrainResult>;
  export function outboxJob(deps: Omit<DrainDeps, 'now'>): () => Promise<void>;   // the sf.write JobHandler
  export function doNotContactEnqueuer(db: Db): (args: { orgId: string; sfObject: string; sfRecordId: string }, tx?: DbExecutor) => Promise<void>;   // A11's onConfirmed
  // src/crm/outbox-store.ts
  export type SfWriteKind = SfWriteRow['kind'];   // 'task' | 'consent' | 'do_not_contact'
  export interface OutboxRow { id; orgId; kind: SfWriteKind; sfObject; sfRecordId; payload: Record<string, unknown>; attempts: number; firstFailedAt: Date | null; alertedAt: Date | null }
  export interface RetryStamp { attempts: number; nextAttemptAt: Date; lastError: string; firstFailedAt: Date; now: Date }
  export interface OutboxStore { due(now, limit): Promise<OutboxRow[]>; markDone(id, now); markRetry(id, stamp: RetryStamp); markFailed(id, lastError, now); markAlerted(ids, now) }
  export function dbOutboxStore(db: Db): OutboxStore;
  // src/crm/outbox-writes.ts
  export type RowOutcome = { id: string; ok: true } | { id: string; ok: false; error: string; permanent: boolean };
  export const SF_BATCH = 200;
  export const DO_NOT_CONTACT_FIELDS: Readonly<Record<string, unknown>>;   // { DoNotCall: true, HasOptedOutOfEmail: true }
  export function errorText(err: unknown): string;
  export function primaryContacts(client: SalesforceClient, opportunityIds: readonly string[]): Promise<Map<string /* 15-char opp id */, string /* ContactId */>>;
  export function writeRows(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<{ outcomes: RowOutcome[]; authFailed: boolean }>;
  // src/alerts.ts
  // AlertEvent['kind'] gains 'sf_write_failing'
  export function sfWriteAlert(logger: AlertLogger): (orgId: string, message: string) => Promise<void>;
  ```
  Row payloads:
  - `consent`: `{ consent: true, source: ConsentSource, at: ISO string }`, zod-checked at drain.
  - `do_not_contact`: `{ reason: 'do_not_contact_confirmed' }`. The fields come from the kind.
  - `task`: the Task fields.

  Queue: `sf.write` (`TICK_QUEUE_OPTIONS`), scheduled `* * * * *`, with a worker only when `cfg.salesforceEnabled`.

#### Part 1: the outbox

- [ ] **Step 1: Write the failing test**

`services/outreach-api/src/crm/outbox.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { SalesforceApiError, SalesforceAuthError, type CompositeResult, type SalesforceClient } from '@cti/salesforce';
import { fakeDb } from '../test/harness.js';
import { CrmNotConnectedError } from './client-factory.js';
import {
  ALERT_AFTER_MS, BACKOFF_MINUTES, doNotContactEnqueuer, drainOutbox, enqueueSfWrite, nextDelayMinutes, type DrainDeps,
} from './outbox.js';
import type { OutboxRow, OutboxStore, RetryStamp } from './outbox-store.js';

const NOW = new Date('2026-10-05T15:00:00.000Z');
const MIN = 60_000;
const ok = (id = '001000000000001AAA'): CompositeResult => ({ id, success: true, errors: [] });
const err = (statusCode: string, message = statusCode): CompositeResult => ({ success: false, errors: [{ statusCode, message }] });

function row(over: Partial<OutboxRow> & Pick<OutboxRow, 'id'>): OutboxRow {
  return {
    orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA',
    payload: { consent: true, source: 'Web Form', at: '2026-10-05T14:00:00.000Z' },
    attempts: 0, firstFailedAt: null, alertedAt: null, ...over,
  };
}

/** In-memory OutboxStore: `due` hands back the rows given; every stamp is recorded. */
function memoryStore(rows: OutboxRow[]) {
  const calls = {
    done: [] as string[],
    retry: [] as Array<{ id: string } & RetryStamp>,
    failed: [] as Array<{ id: string; error: string }>,
    alerted: [] as string[][],
  };
  const store: OutboxStore = {
    due: async () => rows,
    markDone: async (id) => { calls.done.push(id); },
    markRetry: async (id, s) => { calls.retry.push({ id, ...s }); },
    markFailed: async (id, error) => { calls.failed.push({ id, error }); },
    markAlerted: async (ids) => { calls.alerted.push([...ids]); },
  };
  return { store, calls };
}

type Fn = (...args: never[]) => Promise<unknown>;
function fakeClient(over: { createRecords?: Fn; updateRecords?: Fn; query?: Fn } = {}) {
  const c = {
    createRecords: vi.fn(over.createRecords ?? (async (recs: unknown[]) => recs.map(() => ok('00T000000000001AAA')))),
    updateRecords: vi.fn(over.updateRecords ?? (async (recs: unknown[]) => recs.map(() => ok()))),
    query: vi.fn(over.query ?? (async () => [])),
  };
  return c as typeof c & SalesforceClient;
}

function deps(store: OutboxStore, client: SalesforceClient | Error, over: Partial<DrainDeps> = {}) {
  const alert = vi.fn(async () => {});
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const d: DrainDeps = {
    db: fakeDb().db, now: NOW, log, alert, store,
    clients: async () => { if (client instanceof Error) throw client; return client; },
    ...over,
  };
  return { d, alert, log };
}

describe('nextDelayMinutes — the retry schedule', () => {
  it.each([[1, 1], [2, 5], [3, 30], [4, 120], [5, 360], [6, 360], [40, 360], [0, 1]])('after failure #%i wait %i minutes', (attempts, minutes) => {
    expect(nextDelayMinutes(attempts)).toBe(minutes);
  });
  it('is exactly [1, 5, 30, 120, 360] then 360', () => {
    expect(BACKOFF_MINUTES).toEqual([1, 5, 30, 120, 360]);
  });
});

describe('enqueueSfWrite', () => {
  it('inserts one pending row with the given kind, target and payload', async () => {
    const { db, writes } = fakeDb();
    await enqueueSfWrite(db, { orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q1', payload: { consent: true } });
    expect(writes).toEqual([{ op: 'insert', table: schema.sfWrites, values: { orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q1', payload: { consent: true } } }]);
  });
  it("doNotContactEnqueuer is A11's onConfirmed: it queues the do_not_contact write in the confirm's own transaction", async () => {
    const outer = fakeDb();
    const tx = fakeDb();
    await doNotContactEnqueuer(outer.db)({ orgId: 'O1', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA' }, tx.db);
    expect(outer.writes).toEqual([]);
    expect(tx.writes).toEqual([{ op: 'insert', table: schema.sfWrites, values: {
      orgId: 'O1', kind: 'do_not_contact', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA', payload: { reason: 'do_not_contact_confirmed' },
    } }]);
  });
});

describe('drainOutbox — what gets sent', () => {
  it('consent: updates the three consent fields on the record itself', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA' })]);
    const client = fakeClient();
    const { d } = deps(store, client);
    expect(await drainOutbox(d)).toEqual({ done: 1, failed: 0 });
    expect(client.updateRecords).toHaveBeenCalledWith([{
      sobject: 'Opportunity', id: '006000000000001AAA',
      fields: { AI_Call_Consent__c: true, AI_Call_Consent_Date__c: '2026-10-05T14:00:00.000Z', AI_Call_Consent_Source__c: 'Web Form' },
    }]);
    expect(calls.done).toEqual(['w1']);
  });

  it('a malformed consent payload is a terminal failure, never sent', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', payload: { consent: true, source: 'Carrier Pigeon', at: 'x' } })]);
    const client = fakeClient();
    await drainOutbox(deps(store, client).d);
    expect(client.updateRecords).not.toHaveBeenCalled();
    expect(calls.failed).toEqual([{ id: 'w1', error: expect.stringMatching(/^BAD_PAYLOAD/) }]);
  });

  it('do_not_contact on a Lead: DoNotCall + HasOptedOutOfEmail on the Lead', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'do_not_contact', payload: {} })]);
    const client = fakeClient();
    await drainOutbox(deps(store, client).d);
    expect(client.updateRecords).toHaveBeenCalledWith([{ sobject: 'Lead', id: '00Q000000000001AAA', fields: { DoNotCall: true, HasOptedOutOfEmail: true } }]);
    expect(client.query).not.toHaveBeenCalled();
    expect(calls.done).toEqual(['w1']);
  });

  it('do_not_contact on an Opportunity: resolves the PRIMARY contact role and flags that Contact', async () => {
    const { store, calls } = memoryStore([
      row({ id: 'w1', kind: 'do_not_contact', sfObject: 'Opportunity', sfRecordId: '006000000000001AAA', payload: {} }),
      row({ id: 'w2', kind: 'do_not_contact', sfObject: 'Opportunity', sfRecordId: '006000000000002AAA', payload: {} }),
    ]);
    const client = fakeClient({ query: async () => [{ OpportunityId: '006000000000001AAA', ContactId: '003000000000009AAA' }] });
    await drainOutbox(deps(store, client).d);
    expect(client.query).toHaveBeenCalledWith(
      "SELECT OpportunityId, ContactId FROM OpportunityContactRole WHERE IsPrimary = true AND OpportunityId IN ('006000000000001AAA', '006000000000002AAA')",
    );
    expect(client.updateRecords).toHaveBeenCalledWith([{ sobject: 'Contact', id: '003000000000009AAA', fields: { DoNotCall: true, HasOptedOutOfEmail: true } }]);
    expect(calls.done).toEqual(['w1']);
    // No primary contact: nothing in Salesforce can carry the flag — terminal, not retried forever.
    expect(calls.failed).toEqual([{ id: 'w2', error: expect.stringMatching(/^NO_PRIMARY_CONTACT/) }]);
  });

  it('task: stamps CTI_Origin__c = AI Outreach on the created Task', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'task', payload: { Subject: 'AI text sent', WhoId: '00Q000000000001AAA', Status: 'Completed' } })]);
    const client = fakeClient();
    await drainOutbox(deps(store, client).d);
    expect(client.createRecords).toHaveBeenCalledWith([{ sobject: 'Task', fields: { Subject: 'AI text sent', WhoId: '00Q000000000001AAA', Status: 'Completed', CTI_Origin__c: 'AI Outreach' } }]);
    expect(calls.done).toEqual(['w1']);
  });

  it('task: a per-record INVALID_FIELD retries once WITHOUT CTI_Origin__c, and the Task is still created', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'task', payload: { Subject: 'AI text sent' } })]);
    const client = fakeClient({
      createRecords: vi.fn()
        .mockResolvedValueOnce([err('INVALID_FIELD', "No such column 'CTI_Origin__c' on sobject of type Task")])
        .mockResolvedValueOnce([ok('00T000000000002AAA')]) as Fn,
    });
    await drainOutbox(deps(store, client).d);
    expect(client.createRecords).toHaveBeenCalledTimes(2);
    expect(client.createRecords.mock.calls[1]![0]).toEqual([{ sobject: 'Task', fields: { Subject: 'AI text sent' } }]);
    expect(calls.done).toEqual(['w1']);
  });

  it('task: a whole-request 400 INVALID_FIELD retries once without CTI_Origin__c too', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', kind: 'task', payload: { Subject: 'AI text sent' } })]);
    const client = fakeClient({
      createRecords: vi.fn()
        .mockRejectedValueOnce(new SalesforceApiError('bad field', 400, [{ errorCode: 'INVALID_FIELD', message: "No such column 'CTI_Origin__c'" }]))
        .mockResolvedValueOnce([ok('00T000000000002AAA')]) as Fn,
    });
    await drainOutbox(deps(store, client).d);
    expect(client.createRecords.mock.calls[1]![0]).toEqual([{ sobject: 'Task', fields: { Subject: 'AI text sent' } }]);
    expect(calls.done).toEqual(['w1']);
  });
});

describe('drainOutbox — failures', () => {
  it.each([0, 1, 2, 3, 4, 5, 9])('a transient failure after %i earlier attempts retries on the exact schedule', async (attempts) => {
    const { store, calls } = memoryStore([row({ id: 'w1', attempts, firstFailedAt: attempts ? new Date(NOW.getTime() - MIN) : null })]);
    const client = fakeClient({ updateRecords: async () => { throw new SalesforceApiError('Service Unavailable', 503, null); } });
    expect(await drainOutbox(deps(store, client).d)).toEqual({ done: 0, failed: 1 });
    const expectedMinutes = [1, 5, 30, 120, 360, 360, 360][Math.min(attempts, 6)]!;
    expect(calls.retry).toEqual([{
      id: 'w1', attempts: attempts + 1, nextAttemptAt: new Date(NOW.getTime() + expectedMinutes * MIN),
      lastError: '503: Service Unavailable', firstFailedAt: attempts ? new Date(NOW.getTime() - MIN) : NOW, now: NOW,
    }]);
  });

  it('a per-record ENTITY_IS_DELETED is terminal (failed), not retried', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1' })]);
    const client = fakeClient({ updateRecords: async () => [err('ENTITY_IS_DELETED', 'entity is deleted')] });
    await drainOutbox(deps(store, client).d);
    expect(calls.failed).toEqual([{ id: 'w1', error: 'ENTITY_IS_DELETED: entity is deleted' }]);
    expect(calls.retry).toEqual([]);
  });

  it('alerts ONCE when a row has been failing for 24 hours, and stamps it so the next tick does not re-alert', async () => {
    const stale = row({ id: 'w1', attempts: 9, firstFailedAt: new Date(NOW.getTime() - ALERT_AFTER_MS - MIN) });
    const young = row({ id: 'w2', sfRecordId: '00Q000000000002AAA', attempts: 3, firstFailedAt: new Date(NOW.getTime() - ALERT_AFTER_MS + 60 * MIN) });
    const failing = { updateRecords: async (recs: unknown[]) => recs.map(() => err('UNABLE_TO_LOCK_ROW', 'locked')) };
    const first = memoryStore([stale, young]);
    const run1 = deps(first.store, fakeClient(failing));
    await drainOutbox(run1.d);
    expect(run1.alert).toHaveBeenCalledTimes(1);
    expect(run1.alert).toHaveBeenCalledWith('O1', expect.stringContaining('failing for over 24 hours'));
    expect(first.calls.alerted).toEqual([['w1']]);

    // Next tick: the stale row now carries alerted_at — no second alert.
    const second = memoryStore([{ ...stale, alertedAt: NOW }, young]);
    const run2 = deps(second.store, fakeClient(failing));
    await drainOutbox(run2.d);
    expect(run2.alert).not.toHaveBeenCalled();
    expect(second.calls.alerted).toEqual([]);
  });

  it('CrmNotConnectedError leaves that tenant\'s rows pending (no attempt spent) and still drains other tenants', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1', orgId: 'O-BROKEN' }), row({ id: 'w2', orgId: 'O2' })]);
    const client = fakeClient();
    const { d } = deps(store, client, {
      clients: async (orgId) => { if (orgId === 'O-BROKEN') throw new CrmNotConnectedError('not connected'); return client; },
    });
    expect(await drainOutbox(d)).toEqual({ done: 1, failed: 0 });
    expect(calls.done).toEqual(['w2']);
    expect(calls.retry).toEqual([]);
    expect(calls.failed).toEqual([]);
  });

  it('a SalesforceAuthError mid-drain leaves the unattempted rows pending', async () => {
    const { store, calls } = memoryStore([row({ id: 'w1' }), row({ id: 'w2', kind: 'do_not_contact', payload: {} })]);
    const client = fakeClient({ updateRecords: async () => { throw new SalesforceAuthError('refresh failed'); } });
    const { d, log } = deps(store, client);
    expect(await drainOutbox(d)).toEqual({ done: 0, failed: 0 });
    expect(calls.retry).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox.test.ts
```

Expected: `FAIL src/crm/outbox.test.ts`, with `Error: Failed to load url ./outbox.js (resolved id: ./outbox.js) in …/outbox.test.ts. Does the file exist?`.

- [ ] **Step 3: Write the database side**

`services/outreach-api/src/crm/outbox-store.ts`:
```ts
/**
 * Where the Salesforce write outbox (`sf_writes`) is read and stamped. Behind an
 * interface so `drainOutbox`'s retry/alert rules are unit tested against an
 * in-memory store; `dbOutboxStore` is the production one, exercised against
 * real Postgres in outbox.pg.test.ts.
 */
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { schema, type Db, type SfWriteRow } from '@cti/db';

export type SfWriteKind = SfWriteRow['kind'];

/** The columns a drain needs (a projection of @cti/db's `SfWriteRow`). */
export interface OutboxRow {
  id: string;
  orgId: string;
  kind: SfWriteKind;
  sfObject: string;
  sfRecordId: string;
  payload: Record<string, unknown>;
  attempts: number;
  firstFailedAt: Date | null;
  alertedAt: Date | null;
}

export interface RetryStamp {
  attempts: number;
  nextAttemptAt: Date;
  lastError: string;
  firstFailedAt: Date;
  now: Date;
}

export interface OutboxStore {
  /** Pending rows whose `next_attempt_at` has come, oldest first. */
  due(now: Date, limit: number): Promise<OutboxRow[]>;
  markDone(id: string, now: Date): Promise<void>;
  markRetry(id: string, stamp: RetryStamp): Promise<void>;
  /** Terminal: Salesforce rejected the write for a reason a retry cannot fix. */
  markFailed(id: string, lastError: string, now: Date): Promise<void>;
  markAlerted(ids: readonly string[], now: Date): Promise<void>;
}

export function dbOutboxStore(db: Db): OutboxStore {
  const t = schema.sfWrites;
  return {
    async due(now, limit) {
      const rows = await db
        .select({
          id: t.id, orgId: t.orgId, kind: t.kind, sfObject: t.sfObject, sfRecordId: t.sfRecordId,
          payload: t.payload, attempts: t.attempts, firstFailedAt: t.firstFailedAt, alertedAt: t.alertedAt,
        })
        .from(t)
        .where(and(eq(t.status, 'pending'), lte(t.nextAttemptAt, now)))
        .orderBy(asc(t.nextAttemptAt), asc(t.createdAt))
        .limit(limit);
      return rows;
    },
    async markDone(id, now) {
      await db.update(t).set({ status: 'done', doneAt: now, lastError: null, updatedAt: now }).where(eq(t.id, id));
    },
    async markRetry(id, s) {
      await db
        .update(t)
        .set({ attempts: s.attempts, nextAttemptAt: s.nextAttemptAt, lastError: s.lastError, firstFailedAt: s.firstFailedAt, updatedAt: s.now })
        .where(eq(t.id, id));
    },
    async markFailed(id, lastError, now) {
      await db.update(t).set({ status: 'failed', lastError, updatedAt: now }).where(eq(t.id, id));
    },
    async markAlerted(ids, now) {
      if (ids.length === 0) return;
      await db.update(t).set({ alertedAt: now, updatedAt: now }).where(inArray(t.id, [...ids]));
    },
  };
}
```

- [ ] **Step 4: Write the Salesforce side**

`services/outreach-api/src/crm/outbox-writes.ts`:
```ts
/**
 * The Salesforce half of the outbox: turns due `sf_writes` rows into composite
 * create/update calls and reports one outcome per row. Pure of the database —
 * `drainOutbox` (outbox.ts) decides what each outcome does to the row.
 */
import { z } from 'zod';
import {
  SalesforceApiError,
  SalesforceAuthError,
  soqlEscape,
  type CompositeResult,
  type SalesforceClient,
} from '@cti/salesforce';
import { CONSENT_FIELDS, CONSENT_SOURCES, CTI_ORIGIN_AI_OUTREACH, CTI_ORIGIN_FIELD } from './consent-fields.js';
import type { OutboxRow } from './outbox-store.js';

export type RowOutcome =
  | { id: string; ok: true }
  | { id: string; ok: false; error: string; permanent: boolean };

/** Salesforce's sObject Collections limit per request. */
export const SF_BATCH = 200;

/** Per-record status codes no retry can fix: the record is gone or the id is bad. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'ENTITY_IS_DELETED',
  'INVALID_CROSS_REFERENCE_KEY',
  'MALFORMED_ID',
  'INVALID_ID_FIELD',
  'NOT_FOUND',
  'CANNOT_UPDATE_CONVERTED_LEAD',
]);

export const DO_NOT_CONTACT_FIELDS: Readonly<Record<string, unknown>> = { DoNotCall: true, HasOptedOutOfEmail: true };

const ConsentPayload = z.object({ consent: z.literal(true), source: z.enum(CONSENT_SOURCES), at: z.string().datetime() });
const TaskPayload = z.record(z.unknown());

interface UpdateItem { rowId: string; sobject: string; id: string; fields: Record<string, unknown> }
interface UpdateTarget { sobject: string; id: string; fields: Record<string, unknown>; rowIds: string[] }

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function errorText(err: unknown): string {
  const text = err instanceof SalesforceApiError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return text.slice(0, 1000);
}

const fail = (id: string, error: string, permanent: boolean): RowOutcome => ({ id, ok: false, error, permanent });

function outcomeFor(id: string, r: CompositeResult | undefined): RowOutcome {
  if (!r) return fail(id, 'NO_RESULT: Salesforce returned fewer results than records sent', false);
  if (r.success) return { id, ok: true };
  const code = r.errors[0]?.statusCode ?? 'UNKNOWN';
  return fail(id, `${code}: ${r.errors[0]?.message ?? 'no message'}`, PERMANENT_CODES.has(code));
}

/** A whole-request 400 whose body names an unknown/invisible field (same test as cti-api's isInvalidFieldError). */
function isInvalidFieldBody(body: unknown): boolean {
  return (Array.isArray(body) ? body : [body]).some((e) => {
    const code = (e as { errorCode?: unknown } | null)?.errorCode;
    return typeof code === 'string' && code.startsWith('INVALID_FIELD');
  });
}
const isInvalidFieldResult = (r: CompositeResult | undefined): boolean =>
  !!r && !r.success && r.errors.some((e) => e.statusCode.startsWith('INVALID_FIELD'));

function withoutOrigin(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([k]) => k !== CTI_ORIGIN_FIELD));
}

/** Runs `fn`; any failure other than an auth failure becomes a retryable outcome for every row in the chunk. */
async function guarded(rowIds: readonly string[], fn: () => Promise<RowOutcome[]>): Promise<RowOutcome[]> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SalesforceAuthError) throw err;
    const message = errorText(err);
    return rowIds.map((id) => fail(id, message, false));
  }
}

async function createTaskChunk(client: SalesforceClient, chunk: Array<{ id: string; fields: Record<string, unknown> }>): Promise<RowOutcome[]> {
  const plain = () => client.createRecords(chunk.map((t) => ({ sobject: 'Task', fields: withoutOrigin(t.fields) })));
  let results: CompositeResult[];
  try {
    results = await client.createRecords(chunk.map((t) => ({ sobject: 'Task', fields: { ...t.fields, [CTI_ORIGIN_FIELD]: CTI_ORIGIN_AI_OUTREACH } })));
  } catch (err) {
    // The org (or the integration user's field access) has no CTI_Origin__c:
    // retry once without the marker rather than lose the Task.
    if (err instanceof SalesforceApiError && err.status === 400 && isInvalidFieldBody(err.body)) {
      const retried = await plain();
      return chunk.map((t, i) => outcomeFor(t.id, retried[i]));
    }
    throw err;
  }
  const retry = chunk.filter((_, i) => isInvalidFieldResult(results[i]));
  if (retry.length === 0) return chunk.map((t, i) => outcomeFor(t.id, results[i]));
  const retried = await client.createRecords(retry.map((t) => ({ sobject: 'Task', fields: withoutOrigin(t.fields) })));
  const second = new Map(retry.map((t, i) => [t.id, retried[i]]));
  return chunk.map((t, i) => outcomeFor(t.id, second.has(t.id) ? second.get(t.id) : results[i]));
}

async function writeTasks(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  const valid: Array<{ id: string; fields: Record<string, unknown> }> = [];
  for (const r of rows) {
    const p = TaskPayload.safeParse(r.payload);
    if (p.success) valid.push({ id: r.id, fields: p.data });
    else out.push(fail(r.id, 'BAD_PAYLOAD: task payload is not an object', true));
  }
  for (const chunk of chunks(valid, SF_BATCH)) {
    out.push(...(await guarded(chunk.map((c) => c.id), () => createTaskChunk(client, chunk))));
  }
  return out;
}

/** One update per Salesforce record, even when several rows target it; the latest row's fields win. */
function mergeTargets(items: readonly UpdateItem[]): UpdateTarget[] {
  const byKey = new Map<string, UpdateTarget>();
  for (const it of items) {
    const key = `${it.sobject}:${it.id}`;
    const prev = byKey.get(key);
    byKey.set(key, prev
      ? { ...prev, fields: { ...prev.fields, ...it.fields }, rowIds: [...prev.rowIds, it.rowId] }
      : { sobject: it.sobject, id: it.id, fields: it.fields, rowIds: [it.rowId] });
  }
  return [...byKey.values()];
}

async function writeUpdates(client: SalesforceClient, targets: readonly UpdateTarget[]): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  for (const chunk of chunks(targets, SF_BATCH)) {
    out.push(...(await guarded(chunk.flatMap((t) => t.rowIds), async () => {
      const results = await client.updateRecords(chunk.map(({ sobject, id, fields }) => ({ sobject, id, fields })));
      return chunk.flatMap((t, i) => t.rowIds.map((rowId) => outcomeFor(rowId, results[i])));
    })));
  }
  return out;
}

async function writeConsent(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<RowOutcome[]> {
  const out: RowOutcome[] = [];
  const items: UpdateItem[] = [];
  for (const r of rows) {
    const p = ConsentPayload.safeParse(r.payload);
    if (!p.success) {
      out.push(fail(r.id, 'BAD_PAYLOAD: consent payload must be { consent: true, source, at }', true));
      continue;
    }
    items.push({
      rowId: r.id, sobject: r.sfObject, id: r.sfRecordId,
      fields: { [CONSENT_FIELDS.checkbox]: true, [CONSENT_FIELDS.date]: p.data.at, [CONSENT_FIELDS.source]: p.data.source },
    });
  }
  return [...out, ...(await writeUpdates(client, mergeTargets(items)))];
}

/** 15-character form of a Salesforce id, so 15- and 18-character ids compare equal. */
const id15 = (id: string): string => id.slice(0, 15);

/** Opportunity id (15-char) → its primary contact role's ContactId. */
export async function primaryContacts(client: SalesforceClient, opportunityIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const chunk of chunks([...new Set(opportunityIds)], SF_BATCH)) {
    const ids = chunk.map((id) => `'${soqlEscape(id)}'`).join(', ');
    const rows = await client.query<{ OpportunityId?: string; ContactId?: string }>(
      `SELECT OpportunityId, ContactId FROM OpportunityContactRole WHERE IsPrimary = true AND OpportunityId IN (${ids})`,
    );
    for (const r of rows) if (r.OpportunityId && r.ContactId) out.set(id15(r.OpportunityId), r.ContactId);
  }
  return out;
}

/** Opportunity rows → update items on their primary contact role's Contact (looked up now: it may have changed since the row was queued). */
async function contactTargets(client: SalesforceClient, opps: readonly OutboxRow[]): Promise<{ items: UpdateItem[]; failures: RowOutcome[] }> {
  let contacts: Map<string, string>;
  try {
    contacts = await primaryContacts(client, opps.map((r) => r.sfRecordId));
  } catch (err) {
    if (err instanceof SalesforceAuthError) throw err;
    const message = errorText(err);
    return { items: [], failures: opps.map((r) => fail(r.id, message, false)) };
  }
  const items: UpdateItem[] = [];
  const failures: RowOutcome[] = [];
  for (const r of opps) {
    const contactId = contacts.get(id15(r.sfRecordId));
    if (contactId) items.push({ rowId: r.id, sobject: 'Contact', id: contactId, fields: { ...DO_NOT_CONTACT_FIELDS } });
    else failures.push(fail(r.id, 'NO_PRIMARY_CONTACT: the Opportunity has no primary contact role to flag', true));
  }
  return { items, failures };
}

/** Lead → DoNotCall + HasOptedOutOfEmail on the Lead; Opportunity (which has neither field) → on its primary contact role's Contact. */
async function writeDoNotContact(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<RowOutcome[]> {
  const leads: UpdateItem[] = [];
  const opps: OutboxRow[] = [];
  const unsupported: RowOutcome[] = [];
  for (const r of rows) {
    if (r.sfObject === 'Lead') leads.push({ rowId: r.id, sobject: 'Lead', id: r.sfRecordId, fields: { ...DO_NOT_CONTACT_FIELDS } });
    else if (r.sfObject === 'Opportunity') opps.push(r);
    else unsupported.push(fail(r.id, `UNSUPPORTED_OBJECT: ${r.sfObject}`, true));
  }
  const viaContacts = opps.length > 0 ? await contactTargets(client, opps) : { items: [], failures: [] };
  const written = await writeUpdates(client, mergeTargets([...leads, ...viaContacts.items]));
  return [...unsupported, ...viaContacts.failures, ...written];
}

/**
 * Write every row, kind by kind. A `SalesforceAuthError` stops the tenant:
 * rows not yet attempted get no outcome (they stay pending, no attempt spent)
 * and `authFailed` is true. Any other Salesforce failure is an outcome.
 */
export async function writeRows(client: SalesforceClient, rows: readonly OutboxRow[]): Promise<{ outcomes: RowOutcome[]; authFailed: boolean }> {
  const steps: Array<() => Promise<RowOutcome[]>> = [
    () => writeTasks(client, rows.filter((r) => r.kind === 'task')),
    () => writeConsent(client, rows.filter((r) => r.kind === 'consent')),
    () => writeDoNotContact(client, rows.filter((r) => r.kind === 'do_not_contact')),
  ];
  const outcomes: RowOutcome[] = [];
  for (const step of steps) {
    try {
      outcomes.push(...(await step()));
    } catch (err) {
      if (err instanceof SalesforceAuthError) return { outcomes, authFailed: true };
      throw err;
    }
  }
  return { outcomes, authFailed: false };
}
```

- [ ] **Step 5: Write the policy**

`services/outreach-api/src/crm/outbox.ts`:
```ts
/**
 * The Salesforce write outbox (spec §11, §12). Everything this system writes to
 * Salesforce goes through `sf_writes`: a caller enqueues inside its own
 * transaction, and the `sf.write` job drains it every minute through the
 * tenant's integration-user connection. A Salesforce outage only delays writes:
 * a failed row retries on BACKOFF_MINUTES and alerts once after 24 hours.
 *
 * What counts as a failed attempt:
 * - A `SalesforceApiError` (or any other error from the request, or a per-record
 *   error) on a row → one attempt, backoff, `first_failed_at` on the first one.
 * - Per-record codes no retry can fix (deleted record, bad id, converted Lead,
 *   no primary contact role, a malformed payload) → `failed`, terminal.
 * - `CrmNotConnectedError` (no connection, or it is marked broken) and
 *   `SalesforceAuthError` (the token refresh failed) are the CONNECTION's
 *   failure, not the row's: the tenant's rows stay pending untouched — no
 *   attempt counted, no backoff, no 24-hour clock started. A broken connection
 *   already pauses the tenant's campaigns and alerts (A8/B7), and the rows go out
 *   in order on the first tick after an admin reconnects.
 */
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import type { RunnerLogger } from '../jobs/boss.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from './client-factory.js';
import { dbOutboxStore, type OutboxRow, type OutboxStore, type SfWriteKind } from './outbox-store.js';
import { errorText, writeRows, type RowOutcome } from './outbox-writes.js';

/** A Drizzle handle or a transaction on it — enqueue joins the caller's transaction. */
export type DbExecutor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Minutes to wait after the Nth consecutive failure (N = 1..5), then 360 forever. */
export const BACKOFF_MINUTES = [1, 5, 30, 120, 360] as const;
export const ALERT_AFTER_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DRAIN_BATCH = 200;

export function nextDelayMinutes(attempts: number): number {
  const n = Math.min(Math.max(Math.trunc(attempts), 1), BACKOFF_MINUTES.length);
  return BACKOFF_MINUTES[n - 1]!;
}

export interface SfWriteInput {
  orgId: string;
  kind: SfWriteKind;
  sfObject: string;
  sfRecordId: string;
  payload: Record<string, unknown>;
}

export async function enqueueSfWrite(db: DbExecutor, w: SfWriteInput): Promise<void> {
  await db.insert(schema.sfWrites).values({
    orgId: w.orgId, kind: w.kind, sfObject: w.sfObject, sfRecordId: w.sfRecordId, payload: w.payload,
  });
}

export interface DrainDeps {
  db: Db;
  clients: SalesforceClientFactory;
  now: Date;
  log: RunnerLogger;
  /** Fires at most once per row, when the row has been failing for 24 hours. Must not throw. */
  alert: (orgId: string, text: string) => Promise<void>;
  batch?: number;
  /** Test seam; production uses `dbOutboxStore(db)`. */
  store?: OutboxStore;
}

export interface DrainResult { done: number; failed: number }
const NONE: DrainResult = { done: 0, failed: 0 };

function byOrg(rows: readonly OutboxRow[]): Map<string, OutboxRow[]> {
  const out = new Map<string, OutboxRow[]>();
  for (const r of rows) out.set(r.orgId, [...(out.get(r.orgId) ?? []), r]);
  return out;
}

async function applyOutcomes(store: OutboxStore, now: Date, rows: readonly OutboxRow[], outcomes: readonly RowOutcome[]): Promise<DrainResult> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let done = 0;
  let failed = 0;
  for (const o of outcomes) {
    const row = byId.get(o.id);
    if (!row) continue;
    if (o.ok) {
      await store.markDone(o.id, now);
      done += 1;
      continue;
    }
    failed += 1;
    if (o.permanent) {
      await store.markFailed(o.id, o.error, now);
      continue;
    }
    const attempts = row.attempts + 1;
    await store.markRetry(o.id, {
      attempts,
      nextAttemptAt: new Date(now.getTime() + nextDelayMinutes(attempts) * 60_000),
      lastError: o.error,
      firstFailedAt: row.firstFailedAt ?? now,
      now,
    });
  }
  return { done, failed };
}

/** One alert per tenant per tick, covering every retrying row that crossed 24 h and was never alerted on. */
async function alertIfStale(deps: DrainDeps, store: OutboxStore, orgId: string, rows: readonly OutboxRow[], outcomes: readonly RowOutcome[]): Promise<void> {
  const cutoff = deps.now.getTime() - ALERT_AFTER_MS;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const stale = outcomes
    .filter((o): o is Extract<RowOutcome, { ok: false }> => !o.ok && !o.permanent)
    .map((o) => ({ row: byId.get(o.id), error: o.error }))
    .filter((x): x is { row: OutboxRow; error: string } => !!x.row && !x.row.alertedAt && !!x.row.firstFailedAt && x.row.firstFailedAt.getTime() <= cutoff);
  if (stale.length === 0) return;
  const text = `Salesforce write-back has been failing for over 24 hours for tenant ${orgId}: ${stale.length} write(s) still retrying. Last error: ${stale[0]!.error}`;
  try {
    await deps.alert(orgId, text);
  } catch (err) {
    deps.log.error({ orgId, err: errorText(err) }, 'sf.write: alert failed; will retry next tick');
    return;
  }
  await store.markAlerted(stale.map((s) => s.row.id), deps.now);
}

async function drainTenant(deps: DrainDeps, store: OutboxStore, orgId: string, rows: OutboxRow[]): Promise<DrainResult> {
  let client: SalesforceClient;
  try {
    client = await deps.clients(orgId);
  } catch (err) {
    if (err instanceof CrmNotConnectedError) {
      deps.log.info({ orgId, pending: rows.length }, 'sf.write: Salesforce not connected; writes stay pending');
    } else {
      deps.log.error({ orgId, err: errorText(err) }, 'sf.write: could not build the Salesforce client; writes stay pending');
    }
    return NONE;
  }
  let written: Awaited<ReturnType<typeof writeRows>>;
  try {
    written = await writeRows(client, rows);
  } catch (err) {
    deps.log.error({ orgId, err: errorText(err) }, 'sf.write: unexpected failure; writes stay pending');
    return NONE;
  }
  if (written.authFailed) {
    deps.log.warn({ orgId }, 'sf.write: Salesforce auth failed mid-drain; unattempted writes stay pending');
  }
  const result = await applyOutcomes(store, deps.now, rows, written.outcomes);
  await alertIfStale(deps, store, orgId, rows, written.outcomes);
  return result;
}

export async function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const store = deps.store ?? dbOutboxStore(deps.db);
  const rows = await store.due(deps.now, deps.batch ?? DEFAULT_DRAIN_BATCH);
  let done = 0;
  let failed = 0;
  for (const [orgId, orgRows] of byOrg(rows)) {
    const r = await drainTenant(deps, store, orgId, orgRows);
    done += r.done;
    failed += r.failed;
  }
  return { done, failed };
}

/** The `sf.write` job handler: one drain per tick, stamped with the tick's time. */
export function outboxJob(deps: Omit<DrainDeps, 'now'>): () => Promise<void> {
  return async () => {
    const r = await drainOutbox({ ...deps, now: new Date() });
    if (r.done > 0 || r.failed > 0) deps.log.info(r, 'sf.write drained');
  };
}

/**
 * A11's `onConfirmed` hook: a confirmed do-not-contact sets DoNotCall and
 * HasOptedOutOfEmail in Salesforce through the outbox. A11 passes its
 * transaction as `tx`, so the write commits or rolls back with the confirm.
 */
export function doNotContactEnqueuer(db: Db): (args: { orgId: string; sfObject: string; sfRecordId: string }, tx?: DbExecutor) => Promise<void> {
  return (args, tx) => enqueueSfWrite(tx ?? db, {
    orgId: args.orgId, kind: 'do_not_contact', sfObject: args.sfObject, sfRecordId: args.sfRecordId,
    payload: { reason: 'do_not_contact_confirmed' },
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox.test.ts && npm -w services/outreach-api run typecheck
```

Expected: `✓ src/crm/outbox.test.ts (29 tests)`, then `Tests  29 passed (29)`. The typecheck exits 0.

- [ ] **Step 7: Add the real-Postgres test, then run it**

`services/outreach-api/src/crm/outbox.pg.test.ts`:
```ts
/** Real-Postgres lane (A3): the production OutboxStore against the real `sf_writes` table. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { SalesforceClient } from '@cti/salesforce';
import { createTestDb, pgLane } from '../test/pg.js';
import { drainOutbox, enqueueSfWrite } from './outbox.js';

describe.skipIf(!pgLane)('outbox against real Postgres', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let orgId: string;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [org] = await db.insert(schema.organizations).values({ name: 'Outbox Co', slug: `outbox-${Date.now()}` }).returning();
    orgId = org!.id;
  });
  afterAll(async () => { await t?.drop(); });

  it('a successful drain marks the row done; a failing one backs off 1 minute and records first_failed_at', async () => {
    const now = new Date('2026-10-05T15:00:00.000Z');
    await enqueueSfWrite(db, { orgId, kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', payload: { consent: true, source: 'Rep', at: now.toISOString() } });
    // Enqueued with next_attempt_at = now() (wall clock), so drain "later" than that.
    const later = new Date(Date.now() + 1000);
    const okClient = { updateRecords: async (r: unknown[]) => r.map(() => ({ id: 'x', success: true, errors: [] })) } as unknown as SalesforceClient;
    expect(await drainOutbox({ db, clients: async () => okClient, now: later, log, alert: async () => {} })).toEqual({ done: 1, failed: 0 });
    const [done] = await db.select().from(schema.sfWrites).where(eq(schema.sfWrites.orgId, orgId));
    expect(done).toMatchObject({ status: 'done', attempts: 0, lastError: null });
    expect(done!.doneAt).toEqual(later);

    await enqueueSfWrite(db, { orgId, kind: 'do_not_contact', sfObject: 'Lead', sfRecordId: '00Q000000000002AAA', payload: {} });
    const later2 = new Date(Date.now() + 1000);
    const downClient = { updateRecords: async () => { throw new Error('socket hang up'); } } as unknown as SalesforceClient;
    expect(await drainOutbox({ db, clients: async () => downClient, now: later2, log, alert: async () => {} })).toEqual({ done: 0, failed: 1 });
    const [retrying] = await db.select().from(schema.sfWrites).where(eq(schema.sfWrites.sfRecordId, '00Q000000000002AAA'));
    expect(retrying).toMatchObject({ status: 'pending', attempts: 1, lastError: 'socket hang up' });
    expect(retrying!.firstFailedAt).toEqual(later2);
    expect(retrying!.nextAttemptAt).toEqual(new Date(later2.getTime() + 60_000));
    // Not due yet: a drain one second later picks nothing up.
    expect(await drainOutbox({ db, clients: async () => downClient, now: new Date(later2.getTime() + 1000), log, alert: async () => {} })).toEqual({ done: 0, failed: 0 });
  });
});
```

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox.pg.test.ts && npm run test:pg 2>&1 | tail -4; docker rm -f outreach-test-pg >/dev/null 2>&1; true
```

Expected:
- The plain run shows `↓ src/crm/outbox.pg.test.ts (1 test | 1 skipped)`.
- `npm run test:pg` passes, with `✓ src/crm/outbox.pg.test.ts (1 test)` among the files. This proves the Drizzle store's real SQL: the row goes `done`, a failing row goes `pending` with `attempts = 1` and `next_attempt_at = now + 1 min`.

- [ ] **Step 8: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/outreach-api/src/crm/outbox-store.ts \
  services/outreach-api/src/crm/outbox-writes.ts \
  services/outreach-api/src/crm/outbox.ts \
  services/outreach-api/src/crm/outbox.test.ts \
  services/outreach-api/src/crm/outbox.pg.test.ts
git commit -m "feat(outreach-api): add the Salesforce write outbox with backoff, terminal failures and a 24-hour alert"
```

#### Part 2: wire the `sf.write` tick and A11's hook

- [ ] **Step 9: Write the failing wiring test**

`services/outreach-api/src/crm/outbox-wiring.test.ts`:
```ts
/**
 * The outbox is only real if something runs it. server.ts calls main() on
 * import, so its text is the only thing that can pin the wiring (the same
 * approach as cti-api's no-answer-chatter-worker.test.ts).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sfWriteAlert } from '../alerts.js';
import { QUEUES, TICK_QUEUE_OPTIONS } from '../jobs/queues.js';
import { SCHEDULES } from '../jobs/schedules.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(resolve(here, '../server.ts'), 'utf8');

describe('sf.write wiring', () => {
  it("reuses A8's stately tick options (one queued + one active drain, never a backlog) and runs every minute", () => {
    expect(QUEUES.find((q) => q.name === 'sf.write')?.options).toBe(TICK_QUEUE_OPTIONS);
    expect(TICK_QUEUE_OPTIONS.policy).toBe('stately');
    expect(SCHEDULES).toContainEqual({ queue: 'sf.write', cron: '* * * * *' });
  });

  it('server.ts registers the drain as the sf.write handler, alerting through sfWriteAlert', () => {
    expect(server).toContain("import { doNotContactEnqueuer, outboxJob } from './crm/outbox.js';");
    expect(server).toContain("'sf.write': outboxJob({ db, clients");
    expect(server).toContain('alert: sfWriteAlert(console)');
  });

  it("server.ts wires A11's onConfirmed hook to queue the do_not_contact write", () => {
    expect(server).toContain('onConfirmed: doNotContactEnqueuer(db)');
  });

  it('sfWriteAlert logs a sf_write_failing warning for the tenant', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await sfWriteAlert(logger)('O1', 'failing for over 24 hours');
    expect(logger.warn).toHaveBeenCalledWith({ alert: 'sf_write_failing', orgId: 'O1' }, 'alert: failing for over 24 hours');
  });
});
```

Then extend A8's exact-list assertions in `services/outreach-api/src/jobs/schedules.test.ts`. In the first `it`, rename it and add `'sf.write'` to the loop:

```ts
  it('declares the tick queues as stately, never retried, 15-minute expiry', () => {
    const byName = new Map(QUEUES.map((q) => [q.name, q.options]));
    for (const name of ['campaign.refresh', 'record.triage', 'touch.plan', 'sf.write']) {
```

In the second `it`, rename it and add the `sf.write` line:

```ts
  it('schedules refresh every 5 minutes and triage, planning and the Salesforce outbox every minute', () => {
    expect(SCHEDULES).toEqual([
      { queue: 'campaign.refresh', cron: '*/5 * * * *' },
      { queue: 'record.triage', cron: '* * * * *' },
      { queue: 'touch.plan', cron: '* * * * *' },
      { queue: 'sf.write', cron: '* * * * *' },
    ]);
  });
```

- [ ] **Step 10: Run them to verify they fail**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm/outbox-wiring.test.ts src/jobs/schedules.test.ts
```

Expected: `Tests  6 failed | 1 passed (7)`.
- The four wiring tests fail with:
  - `AssertionError: expected undefined to be { Object (retryLimit, retryDelay, ...) }`
  - two `expected 'import \'dotenv/config\';…' to contain …` failures
  - `TypeError: sfWriteAlert is not a function`
- The two schedules assertions fail with no `sf.write` entry.
- `schedules only queues that exist` passes.

- [ ] **Step 11: Add the alert kind and `sfWriteAlert`**

In `services/outreach-api/src/alerts.ts`, replace lines 15–18:

```ts
  kind:
    | 'provisioning_failed'
    | 'job_dead_lettered'
    | 'auth_failure_spike';
```

with:

```ts
  kind:
    | 'provisioning_failed'
    | 'job_dead_lettered'
    | 'auth_failure_spike'
    | 'sf_write_failing';
```

and append at the end of the file:

```ts

/**
 * The outbox's 24-hour alert (crm/outbox.ts `DrainDeps.alert`), as a warning
 * through the same log + webhook path as every other alert.
 */
export function sfWriteAlert(logger: AlertLogger): (orgId: string, message: string) => Promise<void> {
  return (orgId, message) => dispatchAlert(logger, { kind: 'sf_write_failing', severity: 'warning', orgId, message });
}
```

- [ ] **Step 12: Declare the queue and its schedule**

In `services/outreach-api/src/jobs/queues.ts`, add the last entry of `QUEUES`, after `{ name: 'touch.plan', options: TICK_QUEUE_OPTIONS },`:

```ts
  // B2: drains the Salesforce write outbox (crm/outbox.ts).
  { name: 'sf.write', options: TICK_QUEUE_OPTIONS },
```

In `services/outreach-api/src/jobs/schedules.ts`, add the last entry of `SCHEDULES`, after `{ queue: 'touch.plan', cron: '* * * * *' },`:

```ts
  { queue: 'sf.write', cron: '* * * * *' },
```

- [ ] **Step 13: Wire the handler and the review hook in `server.ts`**

Add these imports to `services/outreach-api/src/server.ts`, keeping path order. Put `./alerts.js` directly before `./app.js`, and `./crm/outbox.js` directly after A5's `./crm/client-factory.js`:

```ts
import { sfWriteAlert } from './alerts.js';
import { doNotContactEnqueuer, outboxJob } from './crm/outbox.js';
```

In `main()`, add this entry at the end of the `handlers` object (after the last spread A8–A10 added). It follows A8's pattern, where an unconfigured feature gets no worker:

```ts
    ...(cfg.salesforceEnabled
      ? { 'sf.write': outboxJob({ db, clients, log: console, alert: sfWriteAlert(console) }) }
      : {}),
```

In `apiRoutes`, replace A11's entry `(scope) => registerReviewRoutes(scope, { db }),` with:

```ts
      (scope) => registerReviewRoutes(scope, { db, onConfirmed: doNotContactEnqueuer(db) }),
```

Rows queue even without Salesforce configured; they drain once it is. `doNotContactEnqueuer(db)` matches A11's `(args: ConfirmedDoNotContact, tx: Db) => Promise<void>` and writes through A11's `tx`.

- [ ] **Step 14: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/crm src/jobs && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```

Expected: `outbox-wiring.test.ts (4 tests)` and `schedules.test.ts (3 tests)` pass, alongside the outbox and metadata files. The typecheck exits 0. The full suite passes, with the real-Postgres files skipped.

- [ ] **Step 15: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/outreach-api/src/crm/outbox-wiring.test.ts \
  services/outreach-api/src/alerts.ts \
  services/outreach-api/src/jobs/queues.ts \
  services/outreach-api/src/jobs/schedules.ts \
  services/outreach-api/src/jobs/schedules.test.ts \
  services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): drain the Salesforce outbox every minute and queue do-not-contact writes from review"
```

#### Part 3: the review dialog says what Salesforce gets

- [ ] **Step 16: Write the failing assertion**

In `apps/outreach-web/src/components/review-page.test.tsx`, in `it('confirms do-not-contact only after a dialog that explains it opts the person out of everything'`, add this directly after `expect(dialog).toHaveTextContent('This opts Jane Seller out of everything');`:

```ts
    expect(dialog).toHaveTextContent('Salesforce marks them Do Not Call and Email Opt Out');
```

- [ ] **Step 17: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test -- src/components/review-page.test.tsx
```

Expected: `Tests  1 failed | 4 passed (5)`. The failing test is `confirms do-not-contact only after a dialog that explains it opts the person out of everything`, with `expect(element).toHaveTextContent()`.

- [ ] **Step 18: Update the copy**

In `apps/outreach-web/src/components/review-page.tsx`, replace the confirm dialog's `description` line:

```tsx
            description={`This opts ${label} out of everything: their phone numbers go on your company's opt-out list, so no campaign or rep dialer will call or text them, and they leave this campaign. You can't undo this here.`}
```

with:

```tsx
            description={`This opts ${label} out of everything: their phone numbers go on your company's opt-out list, so no campaign or rep dialer will call or text them, they leave this campaign, and Salesforce marks them Do Not Call and Email Opt Out. You can't undo this here.`}
```

- [ ] **Step 19: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test -- src/components/review-page.test.tsx && npm -w apps/outreach-web run typecheck
```

Expected: `Tests  5 passed (5)`. The typecheck exits 0.

- [ ] **Step 20: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add apps/outreach-web/src/components/review-page.tsx apps/outreach-web/src/components/review-page.test.tsx
git commit -m "feat(outreach-web): say that confirming do-not-contact also marks Salesforce"
```

---

### Task 3: Consent capture, backfill, settings routes, and the Consent card [B3]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> **Packages are consumed through `dist/`.** `@cti/db` and `@cti/contracts` resolve to their built `dist/` files. After any task step that edits `packages/*`, run `npm run build:packages` before running a service's tests.
>
> **Cross-draft decisions applied here:**
> - A11's `onConfirmed(args, tx)` runs inside the confirm transaction, and B2 enqueues with that `tx`.
> - `@cti/salesforce` throws `SalesforceAuthError` when the token refresh fails and `SalesforceApiError` for 5xx or an unreadable response. `createRecords` and `updateRecords` throw `RangeError` above 200 records and return `[]` for empty input.
> - Tests reuse A5's extended `fakeDb` harness.
> - `opt_outs` has `source` and `note`.
> - Tick queues reuse A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`).
> - No B1–B4 code pauses a campaign. A broken connection leaves outbox rows pending, and A8's `pauseOrgCampaigns(…, 'crm_broken')` does the pausing.
>

There are two tenant settings, both off by default (A10's `outreachSettings`). Each turns on one consent source (spec §11.1):
- **Web forms:** a record whose web-form source field is set counts as consented. Turning this on is the admin's confirmation that the forms carry consent language. The route stamps who confirmed it and when.
- **Inbound calls:** a record whose number called us, or that the CTI matched an inbound call to by Salesforce who/what id, counts as consented.

`recordConsent` is the one write path. In one transaction it:
1. Ticks `crm_records` with a compare-and-swap, so a second call is a no-op returning `false`.
2. Inserts one `consent_records` row per distinct number (`consent_type = 'ai_call'`, `notes = '<source>: <evidence>'`).
3. Queues one `consent` outbox row.

Consent is captured in two places. Each campaign refresh applies the switched-on sources to the records it just fetched. An admin's Backfill applies them to every not-yet-consented record of the tenant.

**Files:**
- Create: `packages/contracts/src/consent.ts`; Test: `packages/contracts/src/consent.test.ts`
- Modify: `packages/contracts/src/index.ts`: add `export * from './consent.js';` in alphabetical order, after `./campaigns.js`
- Create: `services/outreach-api/src/consent/rules.ts` (pure); Test: `services/outreach-api/src/consent/rules.test.ts`
- Create: `services/outreach-api/src/consent/capture.ts`; Test: `services/outreach-api/src/consent/capture.test.ts`, `services/outreach-api/src/consent/capture.pg.test.ts`
- Modify: `services/outreach-api/src/campaigns/refresh.ts` (A8): the import list, and the `if (fetchIds.length > 0) { … }` block in `refreshCampaign`; Test: `services/outreach-api/src/consent/refresh-hook.test.ts`
- Create: `services/outreach-api/src/routes/consent.ts`; Test: `services/outreach-api/src/routes/consent.test.ts`
- Modify: `services/outreach-api/src/server.ts`: the import list and `apiRoutes`
- Modify: `apps/outreach-web/src/lib/outreach-api.ts` (A12/A13): the `@cti/contracts` import, `outreachKeys`, and three functions appended
- Create: `apps/outreach-web/src/components/consent-card.tsx`; Test: `apps/outreach-web/src/components/consent-card.test.tsx`
- Modify: `apps/outreach-web/src/components/connections-page.tsx` (A12): one import, and one line after the `FieldMapEditor` block

**Interfaces:**
- Consumes:
  - **A3:** `schema.crmRecords` (`consentAiCall`, `consentSource`, `consentAt`), `schema.consentRecords` (`orgId`, `e164`, `consentType`, `capturedAt`, `notes`), `schema.calls` (`orgId`, `direction`, `fromNumber`, `salesforceWhoId`, `salesforceWhatId`, `createdAt`), and `schema.organizations.settings`. Also `createTestDb`/`pgLane`.
  - **A8:** `type SfRecordSnapshot` (`src/campaigns/records.ts`: `webFormSource`, `consentAiCall`, `phones: { field; e164 }[]`), and `upsertRecords(db, orgId, snapshots): Promise<Map<sfRecordId, { id; changed }>>` with `refreshCampaign` in `src/campaigns/refresh.ts`.
  - **A10:** `outreachSettings(org: { settings: unknown }): OutreachSettings` (`consentFromWebForms`, `consentFromInboundCalls`).
  - **A5:** `requireContext`, `requireAdmin`, `sendError`, `buildApp`, `fakeDb`, `testConfig`.
  - **B1:** `type ConsentSource`.
  - **B2:** `enqueueSfWrite`.
  - **`@cti/phone`:** `toE164`.
  - **A12:** web `api`, `json`, `outreachKeys`, `errorText`, `stubApi`, `renderWithProviders`, and the `connection()` fixture.
- Produces:
  ```ts
  // @cti/contracts (packages/contracts/src/consent.ts)
  export const ConsentSettings = z.object({ consentFromWebForms: z.boolean(), consentFromInboundCalls: z.boolean() });
  export const ConsentSettingsUpdate = ConsentSettings.partial();
  export const BackfillResult = z.object({ webForm: z.number().int().nonnegative(), inboundCall: z.number().int().nonnegative() });
  // src/consent/rules.ts (pure)
  export function consentFromRecord(s: Pick<SfRecordSnapshot, 'webFormSource' | 'consentAiCall'>, settings: Pick<OutreachSettings, 'consentFromWebForms'>): { source: 'Web Form' } | null;
  export interface InboundCallRow { id: string; fromNumber: string; salesforceWhoId: string | null; salesforceWhatId: string | null }
  export function inboundCallerMatches(records: ReadonlyArray<{ id: string; sfRecordId: string; phones: ReadonlyArray<{ e164: string }> }>, calls: readonly InboundCallRow[]): Map<string /* crmRecordId */, string /* callId */>;
  export interface ConsentCandidate { crmRecordId; sfObject: 'Lead' | 'Opportunity'; sfRecordId; phones: ReadonlyArray<{ e164: string }>; webFormSource: string | null }
  export interface PlannedConsent { crmRecordId; sfObject; sfRecordId; e164s: string[]; source: 'Web Form' | 'Inbound Call'; evidence: string }
  export function planConsent(settings, candidates: readonly ConsentCandidate[], calls: readonly InboundCallRow[]): PlannedConsent[];
  // src/consent/capture.ts
  export const AI_CALL_CONSENT_TYPE = 'ai_call';
  export const INBOUND_CALLS_CAP = 200_000;
  export interface RecordConsentInput { orgId; crmRecordId; sfObject: 'Lead' | 'Opportunity'; sfRecordId; e164s: string[]; source: ConsentSource; evidence: string; at: Date }
  export function recordConsent(db: Db, input: RecordConsentInput): Promise<boolean>;
  export function applyConsentPlan(db: Db, orgId: string, plan: readonly PlannedConsent[], at: Date): Promise<BackfillResult>;
  export function loadInboundCalls(db: Db, orgId: string): Promise<InboundCallRow[]>;
  export function backfillConsent(deps: { db: Db; orgId: string; now: Date }): Promise<BackfillResult>;
  export function captureConsentOnRefresh(db: Db, input: { orgId; snapshots: readonly SfRecordSnapshot[]; upserted: ReadonlyMap<string, { id: string }>; now: Date }): Promise<BackfillResult>;
  // src/routes/consent.ts
  export function registerConsentRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void>;
  // apps/outreach-web
  export function getConsentSettings(): Promise<ConsentSettings>;
  export function saveConsentSettings(update: ConsentSettingsUpdate): Promise<ConsentSettings>;
  export function backfillConsent(): Promise<BackfillResult>;
  export const WEB_FORM_CONFIRMATION = 'Our forms carry consent language for calls and texts.';
  export function ConsentCard(props: { canEdit: boolean }): JSX.Element;
  ```
  Routes (under `/api`):
  - `GET /settings/consent` (any member) → `ConsentSettings`.
  - `PUT /settings/consent` (admin, `ConsentSettingsUpdate`) → `ConsentSettings`. Errors: `400 VALIDATION`, `404 TENANT_NOT_FOUND`. Switching web forms on also stores `consentFromWebFormsConfirmedBy`/`…ConfirmedAt` in `organizations.settings`.
  - `POST /settings/consent/backfill` (admin, no body) → `BackfillResult`.

#### Part 1: contracts

- [ ] **Step 1: Write the failing test**

`packages/contracts/src/consent.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { BackfillResult, ConsentSettings, ConsentSettingsUpdate } from './index.js';

describe('consent contracts', () => {
  it('ConsentSettings needs both flags', () => {
    expect(ConsentSettings.safeParse({ consentFromWebForms: true, consentFromInboundCalls: false }).success).toBe(true);
    expect(ConsentSettings.safeParse({ consentFromWebForms: true }).success).toBe(false);
  });
  it('ConsentSettingsUpdate takes either flag alone and strips every other key', () => {
    expect(ConsentSettingsUpdate.parse({ consentFromInboundCalls: true })).toEqual({ consentFromInboundCalls: true });
    expect(ConsentSettingsUpdate.safeParse({ consentFromWebForms: 'yes' }).success).toBe(false);
    // The route merges exactly the parsed object into organizations.settings,
    // so a smuggled key (another setting) can never be written through it.
    expect(ConsentSettingsUpdate.parse({ aiDailyBudgetUsd: 999, consentFromWebForms: false })).toEqual({ consentFromWebForms: false });
  });
  it('BackfillResult counts are non-negative integers', () => {
    expect(BackfillResult.safeParse({ webForm: 3, inboundCall: 0 }).success).toBe(true);
    expect(BackfillResult.safeParse({ webForm: -1, inboundCall: 0 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test -- src/consent.test.ts
```

Expected: `FAIL src/consent.test.ts`, with `Error: Failed to load url ./consent.js (resolved id: ./consent.js) in …/consent.test.ts. Does the file exist?`.

- [ ] **Step 3: Write the contracts**

`packages/contracts/src/consent.ts`:
```ts
import { z } from 'zod';

/**
 * Which consent sources the tenant has switched on (spec §11.1). Stored in
 * `organizations.settings` under these same keys; both default to off.
 * `consentFromWebForms` is the admin's confirmation that the tenant's web
 * forms carry consent language covering calls and texts.
 */
export const ConsentSettings = z.object({
  consentFromWebForms: z.boolean(),
  consentFromInboundCalls: z.boolean(),
});
export type ConsentSettings = z.infer<typeof ConsentSettings>;

export const ConsentSettingsUpdate = ConsentSettings.partial();
export type ConsentSettingsUpdate = z.infer<typeof ConsentSettingsUpdate>;

/** How many records a backfill ticked, by source. */
export const BackfillResult = z.object({
  webForm: z.number().int().nonnegative(),
  inboundCall: z.number().int().nonnegative(),
});
export type BackfillResult = z.infer<typeof BackfillResult>;
```

In `packages/contracts/src/index.ts`, add after `export * from './campaigns.js';`:

```ts
export * from './consent.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test && npm run build:packages
```

Expected: `✓ src/consent.test.ts (3 tests)` and the whole contracts suite passes. `build:packages` exits 0.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add packages/contracts/src/consent.ts packages/contracts/src/consent.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add consent settings and backfill result contracts"
```

#### Part 2: the rules (pure)

- [ ] **Step 6: Write the failing test**

`services/outreach-api/src/consent/rules.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { consentFromRecord, inboundCallerMatches, planConsent, type ConsentCandidate, type InboundCallRow } from './rules.js';

const ON = { consentFromWebForms: true, consentFromInboundCalls: true };
const OFF = { consentFromWebForms: false, consentFromInboundCalls: false };

describe('consentFromRecord — the web-form rule', () => {
  it.each([
    ['setting on, form source set, not consented', { consentFromWebForms: true }, { webFormSource: 'Zillow form', consentAiCall: false }, { source: 'Web Form' }],
    ['setting OFF: never, whatever the record says', { consentFromWebForms: false }, { webFormSource: 'Zillow form', consentAiCall: false }, null],
    ['no form source', { consentFromWebForms: true }, { webFormSource: null, consentAiCall: false }, null],
    ['blank form source', { consentFromWebForms: true }, { webFormSource: '   ', consentAiCall: false }, null],
    ['already consented', { consentFromWebForms: true }, { webFormSource: 'Zillow form', consentAiCall: true }, null],
  ] as const)('%s', (_name, settings, record, expected) => {
    expect(consentFromRecord(record, settings)).toEqual(expected);
  });
});

describe('inboundCallerMatches', () => {
  const records = [
    { id: 'R-LEAD', sfRecordId: '00Q000000000001AAA', phones: [{ e164: '+15125550101' }] },
    { id: 'R-OPP', sfRecordId: '006000000000002AAA', phones: [{ e164: '+15125550202' }, { e164: '+15125550203' }] },
    { id: 'R-NONE', sfRecordId: '00Q000000000009AAA', phones: [{ e164: '+15125550999' }] },
  ];

  it('matches by the caller number, normalizing what the carrier sent', () => {
    const calls: InboundCallRow[] = [{ id: 'C1', fromNumber: '(512) 555-0203', salesforceWhoId: null, salesforceWhatId: null }];
    expect(inboundCallerMatches(records, calls)).toEqual(new Map([['R-OPP', 'C1']]));
  });

  it("matches by the call's Salesforce who id or what id, 15- or 18-character", () => {
    const calls: InboundCallRow[] = [
      { id: 'C1', fromNumber: '+19995550000', salesforceWhoId: '00Q000000000001', salesforceWhatId: null },
      { id: 'C2', fromNumber: 'anonymous', salesforceWhoId: '003000000000005AAA', salesforceWhatId: '006000000000002AAA' },
    ];
    expect(inboundCallerMatches(records, calls)).toEqual(new Map([['R-LEAD', 'C1'], ['R-OPP', 'C2']]));
  });

  it('the first matching call (in the order given) is the evidence; unmatched records are absent', () => {
    const calls: InboundCallRow[] = [
      { id: 'NEWEST', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null },
      { id: 'OLDER', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null },
    ];
    const m = inboundCallerMatches(records, calls);
    expect(m.get('R-LEAD')).toBe('NEWEST');
    expect(m.has('R-NONE')).toBe(false);
  });
});

describe('planConsent', () => {
  const cand = (over: Partial<ConsentCandidate> & Pick<ConsentCandidate, 'crmRecordId'>): ConsentCandidate => ({
    sfObject: 'Lead', sfRecordId: `00Q00000000000${over.crmRecordId.slice(-1)}AAA`, phones: [], webFormSource: null, ...over,
  });
  const candidates = [
    cand({ crmRecordId: 'R1', webFormSource: 'Website', phones: [{ e164: '+15125550101' }] }),
    cand({ crmRecordId: 'R2', phones: [{ e164: '+15125550102' }, { e164: '+15125550103' }] }),
    cand({ crmRecordId: 'R3', phones: [{ e164: '+15125550104' }] }),
  ];
  const calls: InboundCallRow[] = [
    { id: 'C1', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null },
    { id: 'C2', fromNumber: '+15125550103', salesforceWhoId: null, salesforceWhatId: null },
  ];

  it('both sources on: web form first, inbound for the rest, never the same record twice', () => {
    expect(planConsent(ON, candidates, calls)).toEqual([
      { crmRecordId: 'R1', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', e164s: ['+15125550101'], source: 'Web Form', evidence: 'form source Website' },
      { crmRecordId: 'R2', sfObject: 'Lead', sfRecordId: '00Q000000000002AAA', e164s: ['+15125550102', '+15125550103'], source: 'Inbound Call', evidence: 'call C2' },
    ]);
  });

  it('only the web-form source on', () => {
    expect(planConsent({ consentFromWebForms: true, consentFromInboundCalls: false }, candidates, calls).map((p) => [p.crmRecordId, p.source]))
      .toEqual([['R1', 'Web Form']]);
  });

  it('only the inbound source on: R1 qualifies by its call instead', () => {
    expect(planConsent({ consentFromWebForms: false, consentFromInboundCalls: true }, candidates, calls).map((p) => [p.crmRecordId, p.source, p.evidence]))
      .toEqual([['R1', 'Inbound Call', 'call C1'], ['R2', 'Inbound Call', 'call C2']]);
  });

  it('both off: nothing', () => {
    expect(planConsent(OFF, candidates, calls)).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/rules.test.ts
```

Expected: `FAIL src/consent/rules.test.ts`, with `Error: Failed to load url ./rules.js (resolved id: ./rules.js) in …/rules.test.ts. Does the file exist?`.

- [ ] **Step 8: Write the rules**

`services/outreach-api/src/consent/rules.ts`:
```ts
/**
 * AI-call consent rules (spec §11.1) — pure. Which records the tenant's switched-on
 * consent sources tick, and with what evidence. Capture (capture.ts) applies
 * the plan; nothing here touches the database or Salesforce.
 */
import { toE164 } from '@cti/phone';
import type { SfRecordSnapshot } from '../campaigns/records.js';
import type { OutreachSettings } from '../settings.js';

type ConsentSettingsView = Pick<OutreachSettings, 'consentFromWebForms' | 'consentFromInboundCalls'>;

/** Web-form rule: the tenant confirmed its forms carry consent language, and this record came from a form. */
export function consentFromRecord(
  s: Pick<SfRecordSnapshot, 'webFormSource' | 'consentAiCall'>,
  settings: Pick<OutreachSettings, 'consentFromWebForms'>,
): { source: 'Web Form' } | null {
  if (!settings.consentFromWebForms || s.consentAiCall) return null;
  return s.webFormSource && s.webFormSource.trim() !== '' ? { source: 'Web Form' } : null;
}

export interface InboundCallRow {
  id: string;
  fromNumber: string;
  salesforceWhoId: string | null;
  salesforceWhatId: string | null;
}

/** 15-character form, so a 15- and an 18-character Salesforce id compare equal. */
const id15 = (id: string): string => id.slice(0, 15);

/**
 * crmRecordId → the id of the first call (in the order given) the CTI logged
 * FROM this person: the call's Salesforce match names the record, or the
 * caller's number is one of the record's numbers.
 */
export function inboundCallerMatches(
  records: ReadonlyArray<{ id: string; sfRecordId: string; phones: ReadonlyArray<{ e164: string }> }>,
  calls: readonly InboundCallRow[],
): Map<string, string> {
  const byNumber = new Map<string, string>();
  const bySfId = new Map<string, string>();
  for (const c of calls) {
    const from = toE164(c.fromNumber);
    if (from && !byNumber.has(from)) byNumber.set(from, c.id);
    for (const sfId of [c.salesforceWhoId, c.salesforceWhatId]) {
      if (sfId && !bySfId.has(id15(sfId))) bySfId.set(id15(sfId), c.id);
    }
  }
  const out = new Map<string, string>();
  for (const r of records) {
    const callId = bySfId.get(id15(r.sfRecordId)) ?? r.phones.map((p) => byNumber.get(p.e164)).find((id) => id !== undefined);
    if (callId) out.set(r.id, callId);
  }
  return out;
}

export interface ConsentCandidate {
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  phones: ReadonlyArray<{ e164: string }>;
  webFormSource: string | null;
}

export interface PlannedConsent {
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  e164s: string[];
  source: 'Web Form' | 'Inbound Call';
  evidence: string;
}

/**
 * The consents the switched-on sources give these (not yet consented)
 * candidates. Web form first; a record the web form already covers is not
 * planned twice. Each source runs only when its setting is on.
 */
export function planConsent(settings: ConsentSettingsView, candidates: readonly ConsentCandidate[], calls: readonly InboundCallRow[]): PlannedConsent[] {
  const plan: PlannedConsent[] = [];
  const planned = new Set<string>();
  const base = (c: ConsentCandidate) => ({ crmRecordId: c.crmRecordId, sfObject: c.sfObject, sfRecordId: c.sfRecordId, e164s: c.phones.map((p) => p.e164) });
  for (const c of candidates) {
    if (!consentFromRecord({ webFormSource: c.webFormSource, consentAiCall: false }, settings)) continue;
    plan.push({ ...base(c), source: 'Web Form', evidence: `form source ${c.webFormSource!.trim()}` });
    planned.add(c.crmRecordId);
  }
  if (settings.consentFromInboundCalls) {
    const rest = candidates.filter((c) => !planned.has(c.crmRecordId));
    const matches = inboundCallerMatches(rest.map((c) => ({ id: c.crmRecordId, sfRecordId: c.sfRecordId, phones: c.phones })), calls);
    for (const c of rest) {
      const callId = matches.get(c.crmRecordId);
      if (callId) plan.push({ ...base(c), source: 'Inbound Call', evidence: `call ${callId}` });
    }
  }
  return plan;
}
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/rules.test.ts
```

Expected: `✓ src/consent/rules.test.ts (12 tests)`.

#### Part 3: capture and backfill

- [ ] **Step 10: Write the failing tests**

`services/outreach-api/src/consent/capture.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import type { SfRecordSnapshot } from '../campaigns/records.js';
import { fakeDb } from '../test/harness.js';
import { backfillConsent, captureConsentOnRefresh, recordConsent } from './capture.js';

const dialect = new PgDialect();
const AT = new Date('2026-10-05T15:00:00.000Z');
const org = (settings: Record<string, unknown>) => [{ id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', settings }];
/** A consent UPDATE that matched its record (fakeDb's updateReturning); `[]` = it was already consented. */
const TICKS = [{ id: 'R' }];

const input = {
  orgId: 'O1', crmRecordId: 'R1', sfObject: 'Lead' as const, sfRecordId: '00Q000000000001AAA',
  e164s: ['+15125550101', '+15125550102', '+15125550101'], source: 'Web Form' as const, evidence: 'form source Website', at: AT,
};

describe('recordConsent', () => {
  it('ticks the record, writes one consent_records row per distinct number and ONE consent sf_write', async () => {
    const { db, writes } = fakeDb({ updateReturning: TICKS });
    expect(await recordConsent(db, input)).toBe(true);
    expect(writes.find((w) => w.table === schema.crmRecords)?.values).toEqual({ consentAiCall: true, consentSource: 'Web Form', consentAt: AT });
    expect(writes.filter((w) => w.table === schema.consentRecords).map((w) => w.values)).toEqual([[
      { orgId: 'O1', e164: '+15125550101', consentType: 'ai_call', capturedAt: AT, notes: 'Web Form: form source Website' },
      { orgId: 'O1', e164: '+15125550102', consentType: 'ai_call', capturedAt: AT, notes: 'Web Form: form source Website' },
    ]]);
    expect(writes.filter((w) => w.table === schema.sfWrites).map((w) => w.values)).toEqual([{
      orgId: 'O1', kind: 'consent', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA',
      payload: { consent: true, source: 'Web Form', at: '2026-10-05T15:00:00.000Z' },
    }]);
  });

  it('is a no-op returning false when the record is already consented: no evidence row, no Salesforce write', async () => {
    const { db, writes } = fakeDb({ updateReturning: [] });
    expect(await recordConsent(db, input)).toBe(false);
    expect(writes.filter((w) => w.op === 'insert')).toEqual([]);
  });

  it('the tick is a compare-and-swap scoped to the org and to records not yet consented', async () => {
    const { db, captured } = fakeDb({ updateReturning: TICKS });
    await recordConsent(db, input);
    const q = dialect.sqlToQuery(captured.where[0] as SQL);
    expect(q.sql).toBe('("crm_records"."id" = $1 and "crm_records"."org_id" = $2 and "crm_records"."consent_ai_call" = $3)');
    expect(q.params).toEqual(['R1', 'O1', false]);
  });
});

describe('backfillConsent', () => {
  // The crm_records select, then the calls select — in the order backfillConsent awaits them.
  const records = [
    { crmRecordId: 'R1', sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', phones: [{ field: 'MobilePhone', e164: '+15125550101' }], webFormSource: 'Website' },
    { crmRecordId: 'R2', sfObject: 'Opportunity', sfRecordId: '006000000000002AAA', phones: [{ field: 'Phone__c', e164: '+15125550102' }], webFormSource: null },
    { crmRecordId: 'R3', sfObject: 'Lead', sfRecordId: '00Q000000000003AAA', phones: [{ field: 'Phone', e164: '+15125550103' }], webFormSource: null },
    { crmRecordId: 'R4', sfObject: 'Lead', sfRecordId: '00Q000000000004AAA', phones: [], webFormSource: 'Facebook ad' },
  ];
  const calls = [
    { id: 'C1', fromNumber: '+15125550102', salesforceWhoId: null, salesforceWhatId: null },
    { id: 'C2', fromNumber: '+19995550000', salesforceWhoId: '00Q000000000003', salesforceWhatId: null },
  ];

  it('counts each source it ticked', async () => {
    const { db, writes } = fakeDb({ organizations: org({ consentFromWebForms: true, consentFromInboundCalls: true }), selectResults: [records, calls], updateReturning: TICKS });
    expect(await backfillConsent({ db, orgId: 'O1', now: AT })).toEqual({ webForm: 2, inboundCall: 2 });
    expect(writes.filter((w) => w.table === schema.sfWrites).map((w) => (w.values as { payload: { source: string } }).payload.source))
      .toEqual(['Web Form', 'Web Form', 'Inbound Call', 'Inbound Call']);
  });

  it('only the switched-on source runs; with both off nothing is read or written', async () => {
    const webOnly = fakeDb({ organizations: org({ consentFromWebForms: true }), selectResults: [records], updateReturning: TICKS });
    expect(await backfillConsent({ db: webOnly.db, orgId: 'O1', now: AT })).toEqual({ webForm: 2, inboundCall: 0 });
    const neither = fakeDb({ organizations: org({}), selectResults: [records, calls], updateReturning: TICKS });
    expect(await backfillConsent({ db: neither.db, orgId: 'O1', now: AT })).toEqual({ webForm: 0, inboundCall: 0 });
    expect(neither.writes).toEqual([]);
  });

  it('counts only records it actually ticked (a re-run over consented records counts nothing)', async () => {
    const { db } = fakeDb({ organizations: org({ consentFromWebForms: true, consentFromInboundCalls: true }), selectResults: [records, calls], updateReturning: [] });
    expect(await backfillConsent({ db, orgId: 'O1', now: AT })).toEqual({ webForm: 0, inboundCall: 0 });
  });
});

describe('captureConsentOnRefresh', () => {
  const snap = (over: Partial<SfRecordSnapshot>): SfRecordSnapshot => ({
    sfObject: 'Lead', sfRecordId: '00Q000000000001AAA', name: null, ownerSfUserId: null, ownerName: null, leadManagerSfUserId: null,
    phones: [{ field: 'MobilePhone', e164: '+15125550101' }], email: null, state: null, webFormSource: 'Website', consentAiCall: false,
    sfDoNotCall: false, sfEmailOptOut: false, skipOnDialer: false, isClosed: false, lastModifiedAt: null, ...over,
  });
  const upserted = new Map([['00Q000000000001AAA', { id: 'R1', changed: true }], ['00Q000000000002AAA', { id: 'R2', changed: false }]]);

  it('applies the web-form rule to the refreshed records when the setting is on, skipping ones Salesforce already marks consented', async () => {
    const { db, writes } = fakeDb({ organizations: org({ consentFromWebForms: true }), updateReturning: TICKS });
    const result = await captureConsentOnRefresh(db, {
      orgId: 'O1', now: AT, upserted,
      snapshots: [snap({}), snap({ sfRecordId: '00Q000000000002AAA', consentAiCall: true })],
    });
    expect(result).toEqual({ webForm: 1, inboundCall: 0 });
    expect(writes.filter((w) => w.table === schema.sfWrites)).toHaveLength(1);
  });

  it('with the inbound source on, matches the refreshed records against inbound calls', async () => {
    const { db } = fakeDb({
      organizations: org({ consentFromInboundCalls: true }),
      selectResults: [[{ id: 'C9', fromNumber: '+15125550101', salesforceWhoId: null, salesforceWhatId: null }]],
      updateReturning: TICKS,
    });
    expect(await captureConsentOnRefresh(db, { orgId: 'O1', now: AT, upserted, snapshots: [snap({ webFormSource: null })] }))
      .toEqual({ webForm: 0, inboundCall: 1 });
  });

  it('does nothing when both settings are off', async () => {
    const { db, writes } = fakeDb({ organizations: org({}), updateReturning: TICKS });
    expect(await captureConsentOnRefresh(db, { orgId: 'O1', now: AT, upserted, snapshots: [snap({})] })).toEqual({ webForm: 0, inboundCall: 0 });
    expect(writes).toEqual([]);
  });
});
```

`services/outreach-api/src/consent/capture.pg.test.ts`:
```ts
/** Real-Postgres lane (A3): consent capture is idempotent in the database, not just in a fake. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { backfillConsent, recordConsent } from './capture.js';

describe.skipIf(!pgLane)('consent capture against real Postgres', () => {
  let t: TestDb;
  let db: Db;
  let orgId: string;
  const AT = new Date('2026-10-05T15:00:00.000Z');

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    const [org] = await db.insert(schema.organizations).values({
      name: 'Consent Co', slug: `consent-${Date.now()}`, settings: { consentFromWebForms: true, consentFromInboundCalls: true },
    }).returning();
    orgId = org!.id;
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('recordConsent twice: one tick, one consent_records row per number, one sf_writes row', async () => {
    const [rec] = await db.insert(schema.crmRecords).values({
      orgId, sfObject: 'Lead', sfRecordId: '00Q000000000001AAA',
      phones: [{ field: 'MobilePhone', e164: '+15125550101' }, { field: 'Phone', e164: '+15125550102' }],
    }).returning();
    const input = { orgId, crmRecordId: rec!.id, sfObject: 'Lead' as const, sfRecordId: rec!.sfRecordId, e164s: ['+15125550101', '+15125550102'], source: 'Rep' as const, evidence: 'ticked by admin', at: AT };
    expect(await recordConsent(db, input)).toBe(true);
    expect(await recordConsent(db, input)).toBe(false);
    const [after] = await db.select().from(schema.crmRecords).where(eq(schema.crmRecords.id, rec!.id));
    expect(after).toMatchObject({ consentAiCall: true, consentSource: 'Rep', consentAt: AT });
    expect(await db.select().from(schema.consentRecords).where(eq(schema.consentRecords.orgId, orgId))).toHaveLength(2);
    expect(await db.select().from(schema.sfWrites).where(eq(schema.sfWrites.orgId, orgId))).toHaveLength(1);
  });

  it('backfillConsent counts web-form and inbound-call consents, and a re-run counts nothing', async () => {
    const [user] = await db.insert(schema.users).values({ orgId, email: `rep-${Date.now()}@consent.co` }).returning();
    await db.insert(schema.crmRecords).values([
      { orgId, sfObject: 'Lead', sfRecordId: '00Q000000000002AAA', webFormSource: 'Website', phones: [] },
      { orgId, sfObject: 'Opportunity', sfRecordId: '006000000000003AAA', phones: [{ field: 'Phone__c', e164: '+15125550103' }] },
      { orgId, sfObject: 'Lead', sfRecordId: '00Q000000000004AAA', phones: [{ field: 'Phone', e164: '+15125550104' }] },
    ]);
    await db.insert(schema.calls).values({
      orgId, userId: user!.id, provider: 'twilio', fromNumber: '+15125550103', toNumber: '+15125550000', normalizedToNumber: '+15125550000', direction: 'inbound',
    });
    expect(await backfillConsent({ db, orgId, now: AT })).toEqual({ webForm: 1, inboundCall: 1 });
    expect(await backfillConsent({ db, orgId, now: AT })).toEqual({ webForm: 0, inboundCall: 0 });
  });
});
```

- [ ] **Step 11: Run them to verify they fail**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/capture.test.ts
```

Expected: `FAIL src/consent/capture.test.ts`, with `Error: Failed to load url ./capture.js (resolved id: ./capture.js) in …/capture.test.ts. Does the file exist?`.

- [ ] **Step 12: Write capture and backfill**

`services/outreach-api/src/consent/capture.ts`:
```ts
/**
 * Capturing AI-call consent (spec §11.1): tick our record, keep the evidence in
 * `consent_records` (one row per number), and queue the Salesforce write — all
 * in one transaction, and a no-op for a record that is already consented.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { BackfillResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SfRecordSnapshot } from '../campaigns/records.js';
import type { ConsentSource } from '../crm/consent-fields.js';
import { enqueueSfWrite } from '../crm/outbox.js';
import { outreachSettings } from '../settings.js';
import { planConsent, type ConsentCandidate, type InboundCallRow, type PlannedConsent } from './rules.js';

/** consent_records.consent_type for this system's consent. */
export const AI_CALL_CONSENT_TYPE = 'ai_call';
/** Most recent inbound calls a backfill or refresh matches against. */
export const INBOUND_CALLS_CAP = 200_000;

export interface RecordConsentInput {
  orgId: string;
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  e164s: string[];
  source: ConsentSource;
  evidence: string;
  at: Date;
}

/** True when this call consented the record; false when it already was (nothing written). */
export async function recordConsent(db: Db, input: RecordConsentInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [ticked] = await tx
      .update(schema.crmRecords)
      .set({ consentAiCall: true, consentSource: input.source, consentAt: input.at })
      .where(and(
        eq(schema.crmRecords.id, input.crmRecordId),
        eq(schema.crmRecords.orgId, input.orgId),
        eq(schema.crmRecords.consentAiCall, false),
      ))
      .returning({ id: schema.crmRecords.id });
    if (!ticked) return false;
    const numbers = [...new Set(input.e164s)];
    if (numbers.length > 0) {
      await tx.insert(schema.consentRecords).values(numbers.map((e164) => ({
        orgId: input.orgId, e164, consentType: AI_CALL_CONSENT_TYPE, capturedAt: input.at, notes: `${input.source}: ${input.evidence}`,
      })));
    }
    await enqueueSfWrite(tx, {
      orgId: input.orgId, kind: 'consent', sfObject: input.sfObject, sfRecordId: input.sfRecordId,
      payload: { consent: true, source: input.source, at: input.at.toISOString() },
    });
    return true;
  });
}

/** Apply a plan; counts only the records this run actually ticked. */
export async function applyConsentPlan(db: Db, orgId: string, plan: readonly PlannedConsent[], at: Date): Promise<BackfillResult> {
  let webForm = 0;
  let inboundCall = 0;
  for (const p of plan) {
    const ticked = await recordConsent(db, { orgId, crmRecordId: p.crmRecordId, sfObject: p.sfObject, sfRecordId: p.sfRecordId, e164s: p.e164s, source: p.source, evidence: p.evidence, at });
    if (!ticked) continue;
    if (p.source === 'Web Form') webForm += 1;
    else inboundCall += 1;
  }
  return { webForm, inboundCall };
}

/** The tenant's inbound calls, newest first (so the newest call is a match's evidence). */
export async function loadInboundCalls(db: Db, orgId: string): Promise<InboundCallRow[]> {
  return db
    .select({ id: schema.calls.id, fromNumber: schema.calls.fromNumber, salesforceWhoId: schema.calls.salesforceWhoId, salesforceWhatId: schema.calls.salesforceWhatId })
    .from(schema.calls)
    .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.direction, 'inbound')))
    .orderBy(desc(schema.calls.createdAt))
    .limit(INBOUND_CALLS_CAP);
}

async function settingsFor(db: Db, orgId: string) {
  const org = await db.query.organizations.findFirst({ where: eq(schema.organizations.id, orgId), columns: { settings: true } });
  return outreachSettings({ settings: org?.settings ?? {} });
}

/**
 * Admin-run backfill (Settings → Connections → Consent): every not-yet-consented
 * record of the tenant, against the sources that are switched on. Safe to
 * re-run — recordConsent skips anything already consented.
 */
export async function backfillConsent(deps: { db: Db; orgId: string; now: Date }): Promise<BackfillResult> {
  const settings = await settingsFor(deps.db, deps.orgId);
  if (!settings.consentFromWebForms && !settings.consentFromInboundCalls) return { webForm: 0, inboundCall: 0 };
  const candidates: ConsentCandidate[] = await deps.db
    .select({
      crmRecordId: schema.crmRecords.id, sfObject: schema.crmRecords.sfObject, sfRecordId: schema.crmRecords.sfRecordId,
      phones: schema.crmRecords.phones, webFormSource: schema.crmRecords.webFormSource,
    })
    .from(schema.crmRecords)
    .where(and(eq(schema.crmRecords.orgId, deps.orgId), eq(schema.crmRecords.consentAiCall, false)));
  const calls = settings.consentFromInboundCalls && candidates.length > 0 ? await loadInboundCalls(deps.db, deps.orgId) : [];
  return applyConsentPlan(deps.db, deps.orgId, planConsent(settings, candidates, calls), deps.now);
}

/**
 * The refresh hook (A8's refreshCampaign calls this right after upsertRecords):
 * the same rules, for the records this refresh fetched. `upserted` is
 * upsertRecords' result, keyed by Salesforce record id.
 */
export async function captureConsentOnRefresh(
  db: Db,
  input: { orgId: string; snapshots: readonly SfRecordSnapshot[]; upserted: ReadonlyMap<string, { id: string }>; now: Date },
): Promise<BackfillResult> {
  const settings = await settingsFor(db, input.orgId);
  if (!settings.consentFromWebForms && !settings.consentFromInboundCalls) return { webForm: 0, inboundCall: 0 };
  const candidates: ConsentCandidate[] = input.snapshots.flatMap((s) => {
    const row = input.upserted.get(s.sfRecordId);
    return row && !s.consentAiCall
      ? [{ crmRecordId: row.id, sfObject: s.sfObject, sfRecordId: s.sfRecordId, phones: s.phones, webFormSource: s.webFormSource }]
      : [];
  });
  if (candidates.length === 0) return { webForm: 0, inboundCall: 0 };
  const calls = settings.consentFromInboundCalls ? await loadInboundCalls(db, input.orgId) : [];
  return applyConsentPlan(db, input.orgId, planConsent(settings, candidates, calls), input.now);
}
```

- [ ] **Step 13: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/rules.test.ts src/consent/capture.test.ts src/consent/capture.pg.test.ts && npm -w services/outreach-api run typecheck && npm run test:pg 2>&1 | tail -4; docker rm -f outreach-test-pg >/dev/null 2>&1; true
```

Expected:
- `✓ src/consent/capture.test.ts (9 tests)` and `rules.test.ts (12 tests)`, with `capture.pg.test.ts` skipped. The typecheck exits 0.
- `npm run test:pg` passes, including `✓ src/consent/capture.pg.test.ts (2 tests)`. One test proves a second `recordConsent` writes nothing. The other proves a backfill ticks 1 web-form record and 1 inbound caller, then 0/0 on a re-run.

- [ ] **Step 14: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/outreach-api/src/consent/rules.ts \
  services/outreach-api/src/consent/rules.test.ts \
  services/outreach-api/src/consent/capture.ts \
  services/outreach-api/src/consent/capture.test.ts \
  services/outreach-api/src/consent/capture.pg.test.ts
git commit -m "feat(outreach-api): capture AI-call consent from web forms and inbound callers, with backfill"
```

#### Part 4: capture on every campaign refresh

- [ ] **Step 15: Write the failing test**

`services/outreach-api/src/consent/refresh-hook.test.ts`:
```ts
/**
 * The refresh hook is wiring inside A8's refreshCampaign, whose collaborators
 * (Salesforce membership, field fetch, enrollment) are pinned by A8's own
 * tests. What B3 adds is one call in one place, so its text is pinned here:
 * captureConsentOnRefresh runs on exactly the snapshots that were upserted,
 * with upsertRecords' id map, before enrollment.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const refresh = readFileSync(resolve(here, '../campaigns/refresh.ts'), 'utf8');

describe('refreshCampaign → consent capture', () => {
  it('imports the hook', () => {
    expect(refresh).toContain("import { captureConsentOnRefresh } from '../consent/capture.js';");
  });

  it('captures consent on the fetched snapshots, right after they are upserted and before anything is enrolled', () => {
    const fetched = refresh.indexOf('const snapshots = await fetchRecords(');
    const upsert = refresh.indexOf('const upserted = await upsertRecords(db, campaign.orgId, snapshots);');
    const capture = refresh.indexOf('await captureConsentOnRefresh(db, { orgId: campaign.orgId, snapshots, upserted, now });');
    const enroll = refresh.indexOf('await enrollRecords(');
    expect(fetched).toBeGreaterThan(-1);
    expect(upsert).toBeGreaterThan(fetched);
    expect(capture).toBeGreaterThan(upsert);
    expect(enroll).toBeGreaterThan(capture);
  });
});
```

- [ ] **Step 16: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent/refresh-hook.test.ts
```

Expected: `Tests  2 failed (2)`: `imports the hook` and `captures consent on the fetched snapshots, …`.

- [ ] **Step 17: Call the hook from `refreshCampaign`**

In `services/outreach-api/src/campaigns/refresh.ts`, add this import directly after `import { SalesforceAuthError, soqlEscape, type SalesforceClient } from '@cti/salesforce';`, so it comes before `../crm/client-factory.js` in path order:

```ts
import { captureConsentOnRefresh } from '../consent/capture.js';
```

In `refreshCampaign`, replace A8's block:

```ts
  if (fetchIds.length > 0) {
    await upsertRecords(db, campaign.orgId, await fetchRecords(client, sfObject, fetchIds, fieldMap[sfObject]));
  }
```

with:

```ts
  if (fetchIds.length > 0) {
    const snapshots = await fetchRecords(client, sfObject, fetchIds, fieldMap[sfObject]);
    const upserted = await upsertRecords(db, campaign.orgId, snapshots);
    // B3: the tenant's switched-on consent sources (web forms, inbound callers)
    // tick consent on the records this refresh fetched.
    await captureConsentOnRefresh(db, { orgId: campaign.orgId, snapshots, upserted, now });
  }
```

A consent failure throws like any other refresh failure, and A8's `refreshDueCampaigns` records it on the campaign. A8's upsert ORs `consent_ai_call`, so a later sync never un-ticks what this wrote.

- [ ] **Step 18: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/consent src/campaigns && npm -w services/outreach-api run typecheck
```

Expected: `✓ src/consent/refresh-hook.test.ts (2 tests)`, and A8's refresh tests still pass unchanged. The typecheck exits 0.

- [ ] **Step 19: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add services/outreach-api/src/campaigns/refresh.ts services/outreach-api/src/consent/refresh-hook.test.ts
git commit -m "feat(outreach-api): capture consent on the records each campaign refresh fetches"
```

#### Part 5: settings routes

- [ ] **Step 20: Write the failing test**

`services/outreach-api/src/routes/consent.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerConsentRoutes } from './consent.js';

const state = vi.hoisted(() => ({
  session: null as Record<string, unknown> | null,
  backfillCalls: [] as Array<{ orgId: string }>,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));
vi.mock('../consent/capture.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../consent/capture.js')>()),
  backfillConsent: async (deps: { orgId: string }) => { state.backfillCalls.push({ orgId: deps.orgId }); return { webForm: 4, inboundCall: 2 }; },
}));

const ADMIN = { userId: '11111111-1111-4111-8111-111111111111', orgId: 'O1', email: 'admin@gg.co', isAdmin: true, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null, settings: { consentFromInboundCalls: true, aiDailyBudgetUsd: 40 } };
const auth = { authorization: 'Bearer t' };
let app: FastifyInstance;
let writes: ReturnType<typeof fakeDb>['writes'];

async function build(updateReturning?: Array<Record<string, unknown>>): Promise<FastifyInstance> {
  const fx = fakeDb({ organizations: [org], updateReturning });
  writes = fx.writes;
  return buildApp({ cfg: testConfig(), readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(a) => registerConsentRoutes(a, { db: fx.db })] });
}

beforeEach(async () => {
  state.session = ADMIN;
  state.backfillCalls = [];
  app = await build();
});
afterEach(async () => { await app.close(); });

describe('consent settings routes', () => {
  it('GET returns the two flags from the tenant settings, defaults filled in', async () => {
    state.session = { ...ADMIN, isAdmin: false };
    const res = await app.inject({ method: 'GET', url: '/api/settings/consent', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ consentFromWebForms: false, consentFromInboundCalls: true });
  });

  it('PUT merges only the consent keys into settings (jsonb ||), stamping who confirmed web forms', async () => {
    await app.close();
    app = await build([{ settings: { consentFromWebForms: true, consentFromInboundCalls: true, aiDailyBudgetUsd: 40 } }]);
    const res = await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromWebForms: true, aiDailyBudgetUsd: 9999 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ consentFromWebForms: true, consentFromInboundCalls: true });
    const update = writes.find((w) => w.op === 'update' && w.table === schema.organizations)!;
    const q = new PgDialect().sqlToQuery(update.values.settings as SQL);
    expect(q.sql).toBe('"organizations"."settings" || $1::jsonb');
    const patch = JSON.parse(q.params[0] as string);
    expect(patch).toEqual({ consentFromWebForms: true, consentFromWebFormsConfirmedBy: ADMIN.userId, consentFromWebFormsConfirmedAt: expect.any(String) });
    expect(patch).not.toHaveProperty('aiDailyBudgetUsd');
  });

  it('PUT turning a source off writes just that key', async () => {
    await app.close();
    app = await build([{ settings: { consentFromInboundCalls: false } }]);
    await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromInboundCalls: false } });
    const update = writes.find((w) => w.op === 'update')!;
    expect(JSON.parse(new PgDialect().sqlToQuery(update.values.settings as SQL).params[0] as string)).toEqual({ consentFromInboundCalls: false });
  });

  it('PUT and backfill are admin-only; a bad body is 400', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromWebForms: 'yes' } });
    expect(bad.statusCode).toBe(400);
    state.session = { ...ADMIN, isAdmin: false };
    expect((await app.inject({ method: 'PUT', url: '/api/settings/consent', headers: auth, payload: { consentFromWebForms: true } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/settings/consent/backfill', headers: auth })).statusCode).toBe(403);
    expect(state.backfillCalls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("POST backfill runs for the caller's tenant and returns the counts", async () => {
    const res = await app.inject({ method: 'POST', url: '/api/settings/consent/backfill', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ webForm: 4, inboundCall: 2 });
    expect(state.backfillCalls).toEqual([{ orgId: 'O1' }]);
  });
});

describe('server wiring', () => {
  it('server.ts registers the consent routes under /api', () => {
    const server = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../server.ts'), 'utf8');
    expect(server).toContain("import { registerConsentRoutes } from './routes/consent.js';");
    expect(server).toContain('(scope) => registerConsentRoutes(scope, { db }),');
  });
});
```

- [ ] **Step 21: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/routes/consent.test.ts
```

Expected: `FAIL src/routes/consent.test.ts`, with `Error: Failed to load url ./consent.js (resolved id: ./consent.js) in …/routes/consent.test.ts. Does the file exist?`.

- [ ] **Step 22: Write the routes and register them**

`services/outreach-api/src/routes/consent.ts`:
```ts
/**
 * Consent settings (spec §11.1), under /api:
 *   GET  /settings/consent           → ConsentSettings (any member)
 *   PUT  /settings/consent           → ConsentSettings (admin; ConsentSettingsUpdate)
 *   POST /settings/consent/backfill  → BackfillResult (admin)
 */
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ConsentSettingsUpdate, type ConsentSettings } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { backfillConsent } from '../consent/capture.js';
import { sendError } from '../http/errors.js';
import { outreachSettings } from '../settings.js';
import { requireAdmin, requireContext } from '../tenancy/scope.js';

function toConsentSettings(settings: unknown): ConsentSettings {
  const s = outreachSettings({ settings });
  return { consentFromWebForms: s.consentFromWebForms, consentFromInboundCalls: s.consentFromInboundCalls };
}

export async function registerConsentRoutes(app: FastifyInstance, deps: { db: Db }): Promise<void> {
  const { db } = deps;

  app.get('/settings/consent', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    return toConsentSettings(ctx.tenant.settings);
  });

  app.put('/settings/consent', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    const body = ConsentSettingsUpdate.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid consent settings', body.error.flatten());
    // Switching web forms on IS the admin's confirmation that the forms carry
    // consent language (spec §11.1) — record who confirmed it, and when.
    const patch: Record<string, unknown> = body.data.consentFromWebForms === true
      ? { ...body.data, consentFromWebFormsConfirmedBy: ctx.session.userId, consentFromWebFormsConfirmedAt: new Date().toISOString() }
      : { ...body.data };
    // A jsonb merge in SQL, so a concurrent write to another settings key is never lost.
    const [row] = await db
      .update(schema.organizations)
      .set({ settings: sql`${schema.organizations.settings} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(schema.organizations.id, ctx.orgId))
      .returning({ settings: schema.organizations.settings });
    if (!row) return sendError(reply, 404, 'TENANT_NOT_FOUND', 'This tenant no longer exists');
    return toConsentSettings(row.settings);
  });

  app.post('/settings/consent/backfill', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx || !requireAdmin(ctx, reply)) return;
    return backfillConsent({ db, orgId: ctx.orgId, now: new Date() });
  });
}
```

In `services/outreach-api/src/server.ts`, add `import { registerConsentRoutes } from './routes/consent.js';` among the `./routes/…` imports in path order (directly after A5's `./routes/connections.js`). Then add this as the last entry of `apiRoutes`:

```ts
      (scope) => registerConsentRoutes(scope, { db }),
```

- [ ] **Step 23: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/routes/consent.test.ts && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```

Expected: `✓ src/routes/consent.test.ts (6 tests)`. The typecheck exits 0. The full suite passes, with the real-Postgres files skipped.

- [ ] **Step 24: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add services/outreach-api/src/routes/consent.ts services/outreach-api/src/routes/consent.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): add consent settings and backfill routes"
```

#### Part 6: the Consent card

- [ ] **Step 25: Write the failing test**

`apps/outreach-web/src/components/consent-card.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../test/render';
import { connection } from '../test/outreach-fixtures';
import { stubApi } from '../test/stub-api';
import { ConnectionsPage } from './connections-page';
import { ConsentCard, WEB_FORM_CONFIRMATION } from './consent-card';

afterEach(() => vi.unstubAllGlobals());

const OFF = { consentFromWebForms: false, consentFromInboundCalls: false };

describe('ConsentCard', () => {
  it('shows both sources; a member sees them read-only and no Backfill', async () => {
    stubApi({ 'GET /api/settings/consent': { consentFromWebForms: true, consentFromInboundCalls: false } });
    renderWithProviders(<ConsentCard canEdit={false} />);
    const web = await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' });
    expect(web).toBeChecked();
    expect(web).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Count people who have called us as consented' })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: 'Backfill consent' })).not.toBeInTheDocument();
  });

  it('turning web forms on asks for the confirmation first, and saves only on Confirm', async () => {
    const calls = stubApi({
      'GET /api/settings/consent': OFF,
      'PUT /api/settings/consent': { consentFromWebForms: true, consentFromInboundCalls: false },
    });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' }));
    expect(screen.getByText(WEB_FORM_CONFIRMATION)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ consentFromWebForms: true }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Count web-form leads as consented' })).toBeChecked());
    expect(screen.queryByText(WEB_FORM_CONFIRMATION)).not.toBeInTheDocument();
  });

  it('Cancel leaves web forms off and saves nothing', async () => {
    const calls = stubApi({ 'GET /api/settings/consent': OFF });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('checkbox', { name: 'Count web-form leads as consented' })).not.toBeChecked();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the inbound-calls source saves straight away', async () => {
    const calls = stubApi({
      'GET /api/settings/consent': OFF,
      'PUT /api/settings/consent': { consentFromWebForms: false, consentFromInboundCalls: true },
    });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Count people who have called us as consented' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ consentFromInboundCalls: true }));
  });

  it('Backfill is disabled while no source is on', async () => {
    stubApi({ 'GET /api/settings/consent': OFF });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    expect(await screen.findByRole('button', { name: 'Backfill consent' })).toBeDisabled();
    expect(screen.getByText('Turn on a source to backfill.')).toBeInTheDocument();
  });

  it('Backfill reports what it ticked', async () => {
    const calls = stubApi({
      'GET /api/settings/consent': { consentFromWebForms: true, consentFromInboundCalls: true },
      'POST /api/settings/consent/backfill': { webForm: 3, inboundCall: 1 },
    });
    renderWithProviders(<ConsentCard canEdit />, { isAdmin: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Backfill consent' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Ticked 3 records from web forms and 1 record from inbound calls.');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/api/settings/consent/backfill']);
  });
});

describe('ConnectionsPage → Consent card', () => {
  it('appears once Salesforce is connected', async () => {
    stubApi({ 'GET /api/connections/salesforce': connection(), 'GET /api/settings/consent': OFF });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    expect(await screen.findByRole('checkbox', { name: 'Count web-form leads as consented' })).toBeInTheDocument();
  });

  it('is absent while Salesforce is not connected', async () => {
    const calls = stubApi({ 'GET /api/connections/salesforce': connection({ connected: false, status: null, fieldMap: null }) });
    renderWithProviders(<ConnectionsPage />, { isAdmin: true });
    await screen.findByRole('button', { name: 'Connect Salesforce' });
    expect(screen.queryByRole('checkbox', { name: 'Count web-form leads as consented' })).not.toBeInTheDocument();
    expect(calls.map((c) => c.url)).not.toContain('/api/settings/consent');
  });
});
```

- [ ] **Step 26: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test -- src/components/consent-card.test.tsx
```

Expected: `FAIL`, with `Error: Failed to resolve import "./consent-card" from "src/components/consent-card.test.tsx". Does the file exist?`.

- [ ] **Step 27: Add the API calls**

In `apps/outreach-web/src/lib/outreach-api.ts`:
1. Add `BackfillResult,` and `ConsentSettings,` to the value imports from `@cti/contracts`, and `type ConsentSettingsUpdate,` to the type imports, each in alphabetical order. The import list then begins `BackfillResult, Campaign, …, CampaignsResponse, ConsentSettings, CrmConnectionStatus, …`, and its types include `type CampaignStatusChange, type ConsentSettingsUpdate, type CreateCampaignRequest, …`.
2. Add this as the last key of `outreachKeys`:

```ts
  consent: ['settings', 'consent'] as const,
```

3. Append at the end of the file:

```ts

export function getConsentSettings(): Promise<ConsentSettings> {
  return api('/api/settings/consent', ConsentSettings);
}

export function saveConsentSettings(update: ConsentSettingsUpdate): Promise<ConsentSettings> {
  return api('/api/settings/consent', ConsentSettings, { method: 'PUT', body: json(update) });
}

export function backfillConsent(): Promise<BackfillResult> {
  return api('/api/settings/consent/backfill', BackfillResult, { method: 'POST' });
}
```

- [ ] **Step 28: Write the card and put it on the Connections page**

`apps/outreach-web/src/components/consent-card.tsx`:
```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { backfillConsent, getConsentSettings, outreachKeys, saveConsentSettings } from '@/lib/outreach-api';
import { errorText } from '@/lib/outreach-words';

/** The sentence an admin confirms before web-form leads count as consented (spec §11.1). */
export const WEB_FORM_CONFIRMATION = 'Our forms carry consent language for calls and texts.';

const records = (n: number): string => `${n} record${n === 1 ? '' : 's'}`;

/**
 * Settings → Connections → Consent: which sources tick a record's AI Call
 * Consent, and a backfill over the records already synced. Turning web forms
 * on asks for the confirmation sentence first; nothing is saved until Confirm.
 */
export function ConsentCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: outreachKeys.consent, queryFn: getConsentSettings });
  const [confirming, setConfirming] = useState(false);
  const save = useMutation({
    mutationFn: saveConsentSettings,
    onSuccess: (next) => {
      setConfirming(false);
      qc.setQueryData(outreachKeys.consent, next);
    },
  });
  const backfill = useMutation({ mutationFn: backfillConsent });
  const s = settings.data;
  const anySource = Boolean(s && (s.consentFromWebForms || s.consentFromInboundCalls));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Consent</CardTitle>
        <CardDescription>
          Which sources tick AI Call Consent on a record. Consent is recorded with its evidence and written to Salesforce.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
        {settings.error && <p role="alert" className="text-sm text-destructive">{errorText(settings.error)}</p>}
        {s && (
          <>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={s.consentFromWebForms}
                  disabled={!canEdit || save.isPending}
                  onChange={(e) => (e.target.checked ? setConfirming(true) : save.mutate({ consentFromWebForms: false }))}
                />
                Count web-form leads as consented
              </label>
              {confirming && (
                <div role="group" aria-label="Confirm web form consent" className="space-y-2 rounded-md border p-3">
                  <p className="text-sm">{WEB_FORM_CONFIRMATION}</p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={save.isPending} onClick={() => save.mutate({ consentFromWebForms: true })}>Confirm</Button>
                    <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={s.consentFromInboundCalls}
                disabled={!canEdit || save.isPending}
                onChange={(e) => save.mutate({ consentFromInboundCalls: e.target.checked })}
              />
              Count people who have called us as consented
            </label>
            {save.error && <p role="alert" className="text-sm text-destructive">{errorText(save.error)}</p>}
            {canEdit && (
              <div className="space-y-2">
                <Button variant="outline" disabled={!anySource || backfill.isPending} onClick={() => backfill.mutate()}>
                  Backfill consent
                </Button>
                {!anySource && <p className="text-sm text-muted-foreground">Turn on a source to backfill.</p>}
                {backfill.data && (
                  <p role="status" className="text-sm">
                    Ticked {records(backfill.data.webForm)} from web forms and {records(backfill.data.inboundCall)} from inbound calls.
                  </p>
                )}
                {backfill.error && <p role="alert" className="text-sm text-destructive">{errorText(backfill.error)}</p>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

In `apps/outreach-web/src/components/connections-page.tsx`, add `import { ConsentCard } from './consent-card';` directly after `import { ConfirmAction } from './confirm-action';`. Directly after the `{data?.fieldMap && (…) && (<FieldMapEditor … />)}` block, inside the page's outer `<div>`, add:

```tsx
      {data?.connected && <ConsentCard canEdit={isAdmin} />}
```

- [ ] **Step 29: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test && npm -w apps/outreach-web run typecheck
```

Expected: `✓ src/components/consent-card.test.tsx (8 tests)`, and A12's `connections-page.test.tsx` still passes unchanged. The whole web suite passes, and the typecheck exits 0.

- [ ] **Step 30: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  apps/outreach-web/src/lib/outreach-api.ts \
  apps/outreach-web/src/components/consent-card.tsx \
  apps/outreach-web/src/components/consent-card.test.tsx \
  apps/outreach-web/src/components/connections-page.tsx
git commit -m "feat(outreach-web): add the Consent card to the Connections settings page"
```

---

### Task 4: Campaign calls in the CTI dialer (claim, build, release) [B4]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> **Packages are consumed through `dist/`.** `@cti/db` and `@cti/contracts` resolve to their built `dist/` files. After any task step that edits `packages/*`, run `npm run build:packages` before running a service's tests.
>
> **Cross-draft decisions applied here:**
> - A11's `onConfirmed(args, tx)` runs inside the confirm transaction, and B2 enqueues with that `tx`.
> - `@cti/salesforce` throws `SalesforceAuthError` when the token refresh fails and `SalesforceApiError` for 5xx or an unreadable response. `createRecords` and `updateRecords` throw `RangeError` above 200 records and return `[]` for empty input.
> - Tests reuse A5's extended `fakeDb` harness.
> - `opt_outs` has `source` and `note`.
> - Tick queues reuse A8's `TICK_QUEUE_OPTIONS` (`policy: 'stately'`).
> - No B1–B4 code pauses a campaign. A broken connection leaves outbox rows pending, and A8's `pauseOrgCampaigns(…, 'crm_broken')` does the pausing.
>

A rep's **Campaign calls** picker (B6) lists the org's `active` campaigns that have queued `rep_call` touches due now (`GET /dialer/campaigns`). Starting one (`POST /dialer/sessions/from-campaign`) works like this:
1. Claim up to one run's worth (500) of that campaign's due touches, `queued` → `dialing`, in one statement with `FOR UPDATE … SKIP LOCKED`. Two reps pressing at once get disjoint touches.
2. Build a normal READY power-dial run over their records with the rep's own Salesforce token. `createDialerSession` stores the campaign on `dialer_sessions.campaign_id`, and every dialer gate applies unchanged.
3. Link the touches to the run.

The claim commits before the build, so no row lock is held across Salesforce HTTP. If the build or the link fails, the claim is released and the route answers 502.

**Where the claim lives, and how concurrency is proven.** The claim SQL is in `@cti/db` (`packages/db/src/campaign-calls.ts`), and cti-api re-exports it, so one definition serves cti-api and outreach-api. cti-api has no real-Postgres lane. The cleanest real-PG option is outreach-api's existing A3 lane (`createTestDb`, `npm run test:pg`), which already runs every outreach-api `*.pg.test.ts` against a throwaway database with all migrations applied. One test file there fires eight concurrent `limit: 1` claims through a 10-connection pool and asserts they return the five due touches exactly once. cti-api itself gets rendered-SQL assertions and route tests over a fake `execute`.

**Files:**
- Create: `packages/db/src/campaign-calls.ts`; Test: `packages/db/src/campaign-calls.test.ts`
- Modify: `packages/db/src/index.ts`: add `export * from './campaign-calls.js';` after `export { loadMigrationFiles } from './migration-files.js';` (A3)
- Create: `packages/contracts/src/campaign-calls.ts`; Test: `packages/contracts/src/campaign-calls.test.ts`
- Modify: `packages/contracts/src/index.ts`: add `export * from './campaign-calls.js';` as the first line (alphabetical)
- Test: `services/outreach-api/src/campaigns/campaign-calls.pg.test.ts`
- Create: `services/cti-api/src/dialer/campaign-calls.ts`; Test: `services/cti-api/src/dialer/campaign-calls.test.ts`
- Modify: `services/cti-api/src/dialer/create-session.ts`: the `createDialerSession` args (lines 360–363) and the session insert (lines 394–398)
- Modify: `services/cti-api/src/dialer/create-session.test.ts`: two tests appended inside `describe('createDialerSession — nothing dials at creation'`, which closes at line 168
- Modify: `services/cti-api/src/routes/dialer.ts`: the header comment (line 4), the imports (lines 31 and 37), and two handlers inserted after the `/dialer/sessions` handler (after line 395)
- Test: `services/cti-api/src/routes/dialer-campaigns.test.ts`

**Interfaces:**
- Consumes:
  - **A3:**
    - Tables `touches` (`channel`, `status`, `due_at`, `claimed_at`, `dialer_session_id`, `enrollment_id`, `org_id`), `campaign_enrollments` (`status`, `campaign_id`, `crm_record_id`), `campaigns` (`status`, `org_id`, `name`, `sf_object`) and `crm_records` (`sf_record_id`, `sf_object`).
    - The `dialer_sessions.campaign_id` column, as Drizzle `campaignId`.
    - `createTestDb`/`pgLane`, and `npm run test:pg`.
  - **A4:** `SfObject`.
  - **A10:** `active` campaigns' due `rep_call` touches are `queued`.
  - **Existing cti-api:** `createDialerSession(deps, args)` and its deps (`resolveDialNumber`, `fetchTasks`, `fetchContactNames`, `salesforceUserId`, `workedRecentlySafe`, `blockedTargetsSafe`, `preferredNumbersFor`, `listRunStart`), `requirePowerDialer`, `resolveSession`, `getDb`, and `MAX_RUN_RECORDS` (500).
- Produces:
  ```ts
  // @cti/db (packages/db/src/campaign-calls.ts)
  export type SqlExecutor = Pick<Db, 'execute'>;
  export interface DueCampaignCallRow { id: string; name: string; sfObject: 'Lead' | 'Opportunity'; due: number }
  export interface ClaimedCampaignTouch { touchId: string; sfRecordId: string; sfObject: 'Lead' | 'Opportunity' }
  export function dueCampaignCallsSql(orgId: string, now: Date): SQL;
  export function dueCampaignCallRows(db: SqlExecutor, orgId: string, now: Date): Promise<DueCampaignCallRow[]>;
  export function claimCampaignTouchesSql(args: { orgId: string; campaignId: string; now: Date; limit: number }): SQL;
  export function claimCampaignTouches(db: SqlExecutor, args: { orgId: string; campaignId: string; now: Date; limit: number }): Promise<ClaimedCampaignTouch[]>;   // earliest due first
  export function attachSessionSql(touchIds: readonly string[], sessionId: string): SQL;
  export function attachSession(db: SqlExecutor, touchIds: readonly string[], sessionId: string): Promise<void>;   // only touches still 'dialing'
  export function releaseTouchesSql(touchIds: readonly string[]): SQL;
  export function releaseTouches(db: SqlExecutor, touchIds: readonly string[]): Promise<void>;   // 'dialing' → 'queued', session and claim cleared
  // @cti/contracts (packages/contracts/src/campaign-calls.ts)
  export const CampaignCallsResponse = z.object({ campaigns: z.array(z.object({ id: z.string().uuid(), name: z.string(), sfObject: SfObject, due: z.number().int().nonnegative() })) });
  export const StartCampaignCallsRequest = z.object({ campaignId: z.string().uuid() });
  export const StartCampaignCallsResponse = z.object({ sessionId: z.string().uuid(), total: z.number().int().nonnegative() });
  // services/cti-api/src/dialer/campaign-calls.ts
  export { attachSession, claimCampaignTouches, releaseTouches } from '@cti/db';
  export const CAMPAIGN_CALL_BATCH = MAX_RUN_RECORDS;   // 500
  export function dueCampaignCalls(db: SqlExecutor, orgId: string, now: Date): Promise<CampaignCallsResponse>;
  export type StartCampaignCallsResult = { kind: 'started'; sessionId: string; total: number } | { kind: 'nothing_due' } | { kind: 'build_failed'; error: string };
  export interface StartCampaignCallsDeps { db: SqlExecutor; now: Date; build: (args: { objectType: 'Lead' | 'Opportunity'; recordIds: string[]; campaignId: string }) => Promise<{ sessionId: string; total: number }> }
  export function startCampaignCalls(deps: StartCampaignCallsDeps, args: { orgId: string; campaignId: string }): Promise<StartCampaignCallsResult>;
  // services/cti-api/src/dialer/create-session.ts
  createDialerSession(deps, args: { userId; orgId; objectType; recordIds; listViewId?; campaignId?: string })   // stored on dialer_sessions.campaign_id
  ```
  Routes (cti-api, both behind `requirePowerDialer`, with errors as `{ error }`):
  - `GET /dialer/campaigns` → `CampaignCallsResponse`. 401 without a session; 403 without the grant.
  - `POST /dialer/sessions/from-campaign` (`StartCampaignCallsRequest`) → `StartCampaignCallsResponse`.
    - 400 on a bad body.
    - 404 `No campaign calls are due right now.`
    - 502 `Could not build the call list from Salesforce — is the rep signed in? Try again.`, with the claim released.

#### Part 1: the shared claim in `@cti/db`

- [ ] **Step 1: Write the failing tests**

`packages/db/src/campaign-calls.test.ts` renders each statement with Drizzle's `PgDialect` and asserts on the SQL:
```ts
/**
 * Pins the campaign-call SQL as Postgres receives it. Rendered, not faked:
 * drop the org filter and one tenant's rep dials another tenant's people; drop
 * `c.status = 'active'` and a paused or dry-run campaign places real calls;
 * drop SKIP LOCKED and two reps get the same person. The concurrency itself is
 * proven on real Postgres in services/outreach-api/src/campaigns/campaign-calls.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  attachSession, attachSessionSql, claimCampaignTouches, claimCampaignTouchesSql, dueCampaignCallRows, dueCampaignCallsSql,
  releaseTouches, releaseTouchesSql,
} from './campaign-calls.js';

const dialect = new PgDialect();
const flat = (q: SQL) => { const r = dialect.sqlToQuery(q); return { sql: r.sql.replace(/\s+/g, ' ').trim(), params: r.params }; };
const NOW = new Date('2026-10-05T15:00:00.000Z');
const ARGS = { orgId: 'org-1', campaignId: 'camp-1', now: NOW, limit: 500 };

describe('claimCampaignTouchesSql', () => {
  const q = flat(claimCampaignTouchesSql(ARGS));

  it("is scoped to the caller's org on both the touch and the campaign, and to the one campaign asked for", () => {
    expect(q.sql).toContain('where t.org_id = $1 and c.org_id = $2 and c.id = $3');
    expect(q.params.slice(0, 3)).toEqual(['org-1', 'org-1', 'camp-1']);
  });

  it('takes only due, queued rep calls of ACTIVE enrollments in an ACTIVE campaign', () => {
    expect(q.sql).toContain("and c.status = 'active' and e.status = 'active' and t.channel = 'rep_call' and t.status = 'queued' and t.due_at <= $4");
    expect(q.params[3]).toBe(NOW);
  });

  it('locks only the touch rows it picks, skipping rows another claimer holds, inside a CTE so the limit holds', () => {
    expect(q.sql).toMatch(/^with picked as \( select t\.id from touches t/);
    expect(q.sql).toContain('order by t.due_at, t.id limit $5 for update of t skip locked )');
    expect(q.params[4]).toBe(500);
  });

  it('flips them to dialing with the claim time and returns what the dialer needs', () => {
    expect(q.sql).toContain("update touches t set status = 'dialing', claimed_at = $6, updated_at = $7 from picked, campaign_enrollments e, crm_records r where t.id = picked.id");
    expect(q.sql).toMatch(/returning t\.id as touch_id, t\.due_at, r\.sf_record_id, r\.sf_object$/);
  });
});

describe('claimCampaignTouches', () => {
  it('maps and orders the claimed rows by due time', async () => {
    const execute = vi.fn(async () => ({ rows: [
      { touch_id: 'T2', due_at: '2026-10-05T14:00:00.000Z', sf_record_id: '00Q2', sf_object: 'Lead' },
      { touch_id: 'T1', due_at: '2026-10-05T13:00:00.000Z', sf_record_id: '00Q1', sf_object: 'Lead' },
    ] }));
    expect(await claimCampaignTouches({ execute } as never, ARGS)).toEqual([
      { touchId: 'T1', sfRecordId: '00Q1', sfObject: 'Lead' },
      { touchId: 'T2', sfRecordId: '00Q2', sfObject: 'Lead' },
    ]);
  });
});

describe('dueCampaignCallsSql', () => {
  it('counts due queued rep calls per active campaign of the org', () => {
    const q = flat(dueCampaignCallsSql('org-1', NOW));
    expect(q.sql).toContain('select c.id, c.name, c.sf_object, count(*)::int as due');
    expect(q.sql).toContain("where t.org_id = $1 and c.org_id = $2 and c.status = 'active' and e.status = 'active' and t.channel = 'rep_call' and t.status = 'queued' and t.due_at <= $3");
    expect(q.sql).toContain('group by c.id, c.name, c.sf_object order by c.name, c.id');
    expect(q.params).toEqual(['org-1', 'org-1', NOW]);
  });

  it('dueCampaignCallRows maps snake_case to the contract shape', async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 'C1', name: 'Spring', sf_object: 'Opportunity', due: 7 }] }));
    expect(await dueCampaignCallRows({ execute } as never, 'org-1', NOW)).toEqual([{ id: 'C1', name: 'Spring', sfObject: 'Opportunity', due: 7 }]);
  });
});

describe('attachSession / releaseTouches', () => {
  it('attach links only touches still dialing', () => {
    const q = flat(attachSessionSql(['T1', 'T2'], 'S1'));
    expect(q.sql).toBe("update touches set dialer_session_id = $1, updated_at = now() where id in ($2, $3) and status = 'dialing'");
    expect(q.params).toEqual(['S1', 'T1', 'T2']);
  });

  it('release puts dialing touches back in the queue with no session and no claim', () => {
    const q = flat(releaseTouchesSql(['T1']));
    expect(q.sql).toBe("update touches set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now() where id in ($1) and status = 'dialing'");
  });

  it('an empty id list touches nothing (no "in ()" ever reaches Postgres)', async () => {
    const execute = vi.fn();
    await attachSession({ execute } as never, [], 'S1');
    await releaseTouches({ execute } as never, []);
    expect(execute).not.toHaveBeenCalled();
  });
});
```

`services/outreach-api/src/campaigns/campaign-calls.pg.test.ts` is the real-Postgres concurrency proof:
```ts
/**
 * Real-Postgres lane (A3) for the campaign-call claim that cti-api runs
 * (@cti/db campaign-calls.ts). cti-api has no database lane of its own; the
 * claim is one shared definition, so it is proven here, once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { attachSession, claimCampaignTouches, dueCampaignCallRows, releaseTouches, schema, type Db } from '@cti/db';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';

describe.skipIf(!pgLane)('campaign call claims against real Postgres', () => {
  let t: TestDb;
  let db: Db;
  const now = new Date('2026-10-05T15:00:00.000Z');
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

  async function org(slug: string): Promise<string> {
    const [o] = await db.insert(schema.organizations).values({ name: slug, slug: `${slug}-${Date.now()}` }).returning();
    return o!.id;
  }
  async function campaign(orgId: string, name: string, status: 'active' | 'paused' | 'dry_run'): Promise<string> {
    const [c] = await db.insert(schema.campaigns).values({ orgId, name, sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead', status }).returning();
    return c!.id;
  }
  /** One record + enrollment + touch per call. */
  async function touch(orgId: string, campaignId: string, over: { status?: 'queued' | 'planned'; channel?: 'rep_call' | 'sms'; dueAt?: Date } = {}): Promise<string> {
    const [r] = await db.insert(schema.crmRecords).values({ orgId, sfObject: 'Lead', sfRecordId: `00Q${Math.random().toString(36).slice(2, 14).padEnd(12, '0')}AAA` }).returning();
    const [e] = await db.insert(schema.campaignEnrollments).values({ orgId, campaignId, crmRecordId: r!.id }).returning();
    const [x] = await db.insert(schema.touches).values({
      orgId, enrollmentId: e!.id, seq: 1, channel: over.channel ?? 'rep_call', status: over.status ?? 'queued', dueAt: over.dueAt ?? minutesAgo(5),
    }).returning();
    return x!.id;
  }

  let orgA: string;
  let orgB: string;
  let active: string;
  let paused: string;
  let foreign: string;
  let due: string[];

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db;
    orgA = await org('a');
    orgB = await org('b');
    active = await campaign(orgA, 'Spring sellers', 'active');
    paused = await campaign(orgA, 'Paused', 'paused');
    foreign = await campaign(orgB, 'Other tenant', 'active');
    due = [];
    for (let i = 0; i < 5; i++) due.push(await touch(orgA, active, { dueAt: minutesAgo(10 + i) }));
    await touch(orgA, active, { status: 'planned' });
    await touch(orgA, active, { dueAt: new Date(now.getTime() + 60 * 60_000) });
    await touch(orgA, active, { channel: 'sms' });
    await touch(orgA, paused);
    await touch(orgB, foreign);
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('lists only active campaigns of the org with due queued rep calls, with the count', async () => {
    expect(await dueCampaignCallRows(db, orgA, now)).toEqual([{ id: active, name: 'Spring sellers', sfObject: 'Lead', due: 5 }]);
  });

  it('never claims from a paused campaign or from another tenant', async () => {
    expect(await claimCampaignTouches(db, { orgId: orgA, campaignId: paused, now, limit: 500 })).toEqual([]);
    expect(await claimCampaignTouches(db, { orgId: orgA, campaignId: foreign, now, limit: 500 })).toEqual([]);
  });

  it('eight concurrent claims never return the same touch, and together take exactly the five due ones', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => claimCampaignTouches(db, { orgId: orgA, campaignId: active, now, limit: 1 })));
    const claimed = results.flat().map((c) => c.touchId);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect([...claimed].sort()).toEqual([...due].sort());
    const rows = await db.select().from(schema.touches).where(inArray(schema.touches.id, due));
    expect(rows.every((r) => r.status === 'dialing' && r.claimedAt?.getTime() === now.getTime())).toBe(true);
  });

  it('attach stamps the session; release puts the touches back in the queue', async () => {
    const sessionId = '6f1c7a4e-0000-4000-8000-000000000001';
    await attachSession(db, due.slice(0, 2), sessionId);
    const [attached] = await db.select().from(schema.touches).where(eq(schema.touches.id, due[0]!));
    expect(attached!.dialerSessionId).toBe(sessionId);
    await releaseTouches(db, due);
    const rows = await db.select().from(schema.touches).where(inArray(schema.touches.id, due));
    expect(rows.map((r) => [r.status, r.dialerSessionId, r.claimedAt])).toEqual(due.map(() => ['queued', null, null]));
    expect(await dueCampaignCallRows(db, orgA, now)).toEqual([{ id: active, name: 'Spring sellers', sfObject: 'Lead', due: 5 }]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/db run test -- src/campaign-calls.test.ts
```

Expected: `FAIL src/campaign-calls.test.ts`, with `Error: Failed to load url ./campaign-calls.js (resolved id: ./campaign-calls.js) in …/campaign-calls.test.ts. Does the file exist?`.

- [ ] **Step 3: Write the claim module**

`packages/db/src/campaign-calls.ts`:
```ts
/**
 * Campaign rep calls (outreach spec §10.1): the claim protocol on `touches`
 * between outreach-api (which queues `rep_call` touches) and the CTI dialer
 * (which claims them into a power-dial run). It lives here, in the package
 * both services share, so there is ONE definition of the claim: cti-api's
 * routes use it (services/cti-api/src/dialer/campaign-calls.ts), and
 * outreach-api's real-Postgres lane proves two concurrent claims never take the
 * same touch (services/outreach-api/src/campaigns/campaign-calls.pg.test.ts).
 *
 * Every statement is built by a `*Sql` function so a unit test can render it —
 * each predicate here is a safety property (tenant, campaign state, due-ness),
 * and a fake database would let any of them go missing unnoticed.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.js';

/** Only what these functions use, so a caller can pass a transaction or a test double. */
export type SqlExecutor = Pick<Db, 'execute'>;

export interface DueCampaignCallRow {
  id: string;
  name: string;
  sfObject: 'Lead' | 'Opportunity';
  due: number;
}

export interface ClaimedCampaignTouch {
  touchId: string;
  sfRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/** The org's `active` campaigns with queued rep calls due now, and how many. */
export function dueCampaignCallsSql(orgId: string, now: Date): SQL {
  return sql`
    select c.id, c.name, c.sf_object, count(*)::int as due
      from touches t
      join campaign_enrollments e on e.id = t.enrollment_id
      join campaigns c on c.id = e.campaign_id
     where t.org_id = ${orgId}
       and c.org_id = ${orgId}
       and c.status = 'active'
       and e.status = 'active'
       and t.channel = 'rep_call'
       and t.status = 'queued'
       and t.due_at <= ${now}
     group by c.id, c.name, c.sf_object
     order by c.name, c.id`;
}

export async function dueCampaignCallRows(db: SqlExecutor, orgId: string, now: Date): Promise<DueCampaignCallRow[]> {
  const rows = rowsOf<{ id: string; name: string; sf_object: 'Lead' | 'Opportunity'; due: number }>(await db.execute(dueCampaignCallsSql(orgId, now)));
  return rows.map((r) => ({ id: r.id, name: r.name, sfObject: r.sf_object, due: r.due }));
}

/**
 * Claim up to `limit` due rep-call touches of ONE active campaign of the
 * caller's org: `queued` → `dialing`, in one statement.
 *
 * - The pick and the write are one statement, and the pick takes row locks
 *   with SKIP LOCKED, so two reps pressing "Dial campaign calls" at once get
 *   disjoint touches instead of waiting or double-dialing.
 * - `for update OF t`: lock only the touch rows. A bare FOR UPDATE would also
 *   lock the joined campaign row, and with SKIP LOCKED the second claimer
 *   would then skip EVERY touch of that campaign and get nothing.
 * - A CTE, not `where id in (select … limit n for update skip locked)`: the
 *   planner may re-run an IN-subquery per outer row and hand back more than n;
 *   a locking CTE is materialized once (same reasoning as cti-api's
 *   fleet/auto-assign-live.ts).
 */
export function claimCampaignTouchesSql(args: { orgId: string; campaignId: string; now: Date; limit: number }): SQL {
  return sql`
    with picked as (
      select t.id
        from touches t
        join campaign_enrollments e on e.id = t.enrollment_id
        join campaigns c on c.id = e.campaign_id
       where t.org_id = ${args.orgId}
         and c.org_id = ${args.orgId}
         and c.id = ${args.campaignId}
         and c.status = 'active'
         and e.status = 'active'
         and t.channel = 'rep_call'
         and t.status = 'queued'
         and t.due_at <= ${args.now}
       order by t.due_at, t.id
       limit ${args.limit}
         for update of t skip locked
    )
    update touches t
       set status = 'dialing',
           claimed_at = ${args.now},
           updated_at = ${args.now}
      from picked, campaign_enrollments e, crm_records r
     where t.id = picked.id
       and e.id = t.enrollment_id
       and r.id = e.crm_record_id
    returning t.id as touch_id, t.due_at, r.sf_record_id, r.sf_object`;
}

/** Claimed touches, earliest due first (RETURNING order is not guaranteed, so it is sorted here). */
export async function claimCampaignTouches(
  db: SqlExecutor,
  args: { orgId: string; campaignId: string; now: Date; limit: number },
): Promise<ClaimedCampaignTouch[]> {
  const rows = rowsOf<{ touch_id: string; due_at: Date | string; sf_record_id: string; sf_object: 'Lead' | 'Opportunity' }>(
    await db.execute(claimCampaignTouchesSql(args)),
  );
  return [...rows]
    .sort((a, b) => new Date(a.due_at).getTime() - new Date(b.due_at).getTime() || a.touch_id.localeCompare(b.touch_id))
    .map((r) => ({ touchId: r.touch_id, sfRecordId: r.sf_record_id, sfObject: r.sf_object }));
}

/** Link claimed touches to the run they went into (only touches still `dialing`). */
export function attachSessionSql(touchIds: readonly string[], sessionId: string): SQL {
  return sql`
    update touches
       set dialer_session_id = ${sessionId}, updated_at = now()
     where id in (${idList(touchIds)})
       and status = 'dialing'`;
}

export async function attachSession(db: SqlExecutor, touchIds: readonly string[], sessionId: string): Promise<void> {
  if (touchIds.length === 0) return;
  await db.execute(attachSessionSql(touchIds, sessionId));
}

/** Give claimed touches back (`dialing` → `queued`, no session, no claim) — e.g. when the run could not be built. */
export function releaseTouchesSql(touchIds: readonly string[]): SQL {
  return sql`
    update touches
       set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now()
     where id in (${idList(touchIds)})
       and status = 'dialing'`;
}

export async function releaseTouches(db: SqlExecutor, touchIds: readonly string[]): Promise<void> {
  if (touchIds.length === 0) return;
  await db.execute(releaseTouchesSql(touchIds));
}
```

In `packages/db/src/index.ts`, add after `export { loadMigrationFiles } from './migration-files.js';`:

```ts
export * from './campaign-calls.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/db run test && npm run build:packages && npm run test:pg 2>&1 | tail -4; docker rm -f outreach-test-pg >/dev/null 2>&1; true
```

Expected:
- `✓ src/campaign-calls.test.ts (10 tests)`, and the whole db suite passes.
- `build:packages` exits 0.
- `npm run test:pg` passes, including `✓ src/campaigns/campaign-calls.pg.test.ts (4 tests)`. Those tests cover: the due list; no claim from a paused or foreign campaign; eight concurrent claims taking the five due touches exactly once; attach and release.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add packages/db/src/campaign-calls.ts packages/db/src/campaign-calls.test.ts packages/db/src/index.ts services/outreach-api/src/campaigns/campaign-calls.pg.test.ts
git commit -m "feat(db): add the campaign-call claim (FOR UPDATE SKIP LOCKED), attach and release"
```

#### Part 2: contracts

- [ ] **Step 6: Write the failing test**

`packages/contracts/src/campaign-calls.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { CampaignCallsResponse, StartCampaignCallsRequest, StartCampaignCallsResponse } from './index.js';

const ID = '11111111-1111-4111-8111-111111111111';

describe('campaign-call contracts', () => {
  it('CampaignCallsResponse: uuid, name, Lead/Opportunity, a non-negative due count', () => {
    expect(CampaignCallsResponse.safeParse({ campaigns: [{ id: ID, name: 'Spring', sfObject: 'Lead', due: 3 }] }).success).toBe(true);
    expect(CampaignCallsResponse.safeParse({ campaigns: [{ id: ID, name: 'Spring', sfObject: 'Account', due: 3 }] }).success).toBe(false);
    expect(CampaignCallsResponse.safeParse({ campaigns: [{ id: 'nope', name: 'Spring', sfObject: 'Lead', due: 3 }] }).success).toBe(false);
  });
  it('StartCampaignCallsRequest needs a campaign uuid', () => {
    expect(StartCampaignCallsRequest.safeParse({ campaignId: ID }).success).toBe(true);
    expect(StartCampaignCallsRequest.safeParse({ campaignId: '006000000000001' }).success).toBe(false);
    expect(StartCampaignCallsRequest.safeParse({}).success).toBe(false);
  });
  it('StartCampaignCallsResponse is the run id and its size', () => {
    expect(StartCampaignCallsResponse.parse({ sessionId: ID, total: 12 })).toEqual({ sessionId: ID, total: 12 });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test -- src/campaign-calls.test.ts
```

Expected: `FAIL src/campaign-calls.test.ts`, with `Error: Failed to load url ./campaign-calls.js (resolved id: ./campaign-calls.js) in …/campaign-calls.test.ts. Does the file exist?`.

- [ ] **Step 8: Write the contracts**

`packages/contracts/src/campaign-calls.ts`:
```ts
import { z } from 'zod';
import { SfObject } from './crm.js';

/**
 * Campaign rep calls through the CTI power dialer (outreach spec §10.1), served
 * by cti-api: `GET /dialer/campaigns` and `POST /dialer/sessions/from-campaign`.
 */
export const CampaignCallsResponse = z.object({
  campaigns: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    sfObject: SfObject,
    /** Queued rep-call touches due now. */
    due: z.number().int().nonnegative(),
  })),
});
export type CampaignCallsResponse = z.infer<typeof CampaignCallsResponse>;

export const StartCampaignCallsRequest = z.object({ campaignId: z.string().uuid() });
export type StartCampaignCallsRequest = z.infer<typeof StartCampaignCallsRequest>;

/** The run that was built — the same shape POST /dialer/sessions answers with. */
export const StartCampaignCallsResponse = z.object({ sessionId: z.string().uuid(), total: z.number().int().nonnegative() });
export type StartCampaignCallsResponse = z.infer<typeof StartCampaignCallsResponse>;
```

In `packages/contracts/src/index.ts`, add as the first line:

```ts
export * from './campaign-calls.js';
```

- [ ] **Step 9: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test && npm run build:packages
```

Expected: `✓ src/campaign-calls.test.ts (3 tests)`, and the whole contracts suite passes. `build:packages` exits 0.

- [ ] **Step 10: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add packages/contracts/src/campaign-calls.ts packages/contracts/src/campaign-calls.test.ts packages/contracts/src/index.ts
git commit -m "feat(contracts): add campaign calls contracts"
```

#### Part 3: cti-api — start campaign calls

- [ ] **Step 11: Write the failing test**

`services/cti-api/src/dialer/campaign-calls.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CAMPAIGN_CALL_BATCH, dueCampaignCalls, startCampaignCalls } from './campaign-calls.js';

const dialect = new PgDialect();
const NOW = new Date('2026-10-05T15:00:00.000Z');
const ARGS = { orgId: 'O1', campaignId: '11111111-1111-4111-8111-111111111111' };

/** Records every statement; the claim (the only SKIP LOCKED one) answers with `claimRows`. */
function fakeDb(claimRows: Array<Record<string, unknown>>) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const execute = vi.fn(async (q: SQL) => {
    const r = dialect.sqlToQuery(q);
    const flat = r.sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: flat, params: r.params });
    return { rows: flat.includes('skip locked') ? claimRows : [] };
  });
  return { db: { execute } as never, statements };
}
const claimRow = (n: number) => ({ touch_id: `T${n}`, due_at: `2026-10-05T1${n}:00:00.000Z`, sf_record_id: `00Q00000000000${n}AAA`, sf_object: 'Lead' });

describe('startCampaignCalls', () => {
  it('nothing due: no run is built', async () => {
    const { db } = fakeDb([]);
    const build = vi.fn();
    expect(await startCampaignCalls({ db, now: NOW, build }, ARGS)).toEqual({ kind: 'nothing_due' });
    expect(build).not.toHaveBeenCalled();
  });

  it("claims at most one run's worth, builds the run over the claimed records, and links the touches to it", async () => {
    const { db, statements } = fakeDb([claimRow(2), claimRow(1)]);
    const build = vi.fn(async () => ({ sessionId: 'S1', total: 2 }));
    expect(await startCampaignCalls({ db, now: NOW, build }, ARGS)).toEqual({ kind: 'started', sessionId: 'S1', total: 2 });
    expect(statements[0]!.params).toEqual(['O1', 'O1', ARGS.campaignId, NOW, CAMPAIGN_CALL_BATCH, NOW, NOW]);
    expect(CAMPAIGN_CALL_BATCH).toBe(500);
    expect(build).toHaveBeenCalledWith({ objectType: 'Lead', recordIds: ['00Q000000000001AAA', '00Q000000000002AAA'], campaignId: ARGS.campaignId });
    expect(statements[1]).toEqual({ sql: "update touches set dialer_session_id = $1, updated_at = now() where id in ($2, $3) and status = 'dialing'", params: ['S1', 'T1', 'T2'] });
    expect(statements).toHaveLength(2);
  });

  it('a Salesforce failure while building releases the claim', async () => {
    const { db, statements } = fakeDb([claimRow(1), claimRow(2)]);
    const build = vi.fn(async () => { throw new Error('could not resolve Salesforce user id (status 401)'); });
    expect(await startCampaignCalls({ db, now: NOW, build }, ARGS)).toEqual({ kind: 'build_failed', error: 'could not resolve Salesforce user id (status 401)' });
    expect(statements[1]).toEqual({
      sql: "update touches set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now() where id in ($1, $2) and status = 'dialing'",
      params: ['T1', 'T2'],
    });
  });

  it('a failure linking the touches also releases them (the READY run never starts on its own)', async () => {
    const { db, statements } = fakeDb([claimRow(1)]);
    const execute = (db as unknown as { execute: ReturnType<typeof vi.fn> }).execute;
    const real = execute.getMockImplementation()!;
    execute.mockImplementation(async (q: SQL) => {
      if (dialect.sqlToQuery(q).sql.includes('dialer_session_id = $1')) throw new Error('connection reset');
      return real(q);
    });
    const result = await startCampaignCalls({ db, now: NOW, build: async () => ({ sessionId: 'S1', total: 1 }) }, ARGS);
    expect(result).toEqual({ kind: 'build_failed', error: 'connection reset' });
    expect(statements.at(-1)!.sql).toContain("set status = 'queued'");
  });
});

describe('dueCampaignCalls', () => {
  it('wraps the due rows in the CampaignCallsResponse shape', async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: ARGS.campaignId, name: 'Spring', sf_object: 'Lead', due: 4 }] }));
    expect(await dueCampaignCalls({ execute } as never, 'O1', NOW)).toEqual({ campaigns: [{ id: ARGS.campaignId, name: 'Spring', sfObject: 'Lead', due: 4 }] });
  });
});
```

- [ ] **Step 12: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/campaign-calls.test.ts
```

Expected: `FAIL src/dialer/campaign-calls.test.ts`, with `Error: Failed to load url ./campaign-calls.js (resolved id: ./campaign-calls.js) in …/dialer/campaign-calls.test.ts. Does the file exist?`.

- [ ] **Step 13: Write the module**

`services/cti-api/src/dialer/campaign-calls.ts`:
```ts
/**
 * Campaign calls (outreach spec §10.1): a rep starts a normal power-dial run
 * from a campaign's due rep-call touches. The claim protocol itself is shared
 * with outreach-api and lives in @cti/db (campaign-calls.ts) — re-exported here
 * so the dialer's imports stay in the dialer. This file adds only the
 * claim → build → attach sequence and its failure path.
 *
 * Every dialer rule still applies: the run is built by the same
 * `createDialerSession` (consent, DNC, Skip on Dialer, already-worked) and
 * dialed by the same engine (calling hours, daily caps, cadence, AMD).
 */
import { MAX_RUN_RECORDS, type CampaignCallsResponse } from '@cti/contracts';
import { attachSession, claimCampaignTouches, dueCampaignCallRows, releaseTouches, type SqlExecutor } from '@cti/db';

export { attachSession, claimCampaignTouches, releaseTouches } from '@cti/db';

/** At most one run's worth of touches per start — the dialer's own cap. */
export const CAMPAIGN_CALL_BATCH = MAX_RUN_RECORDS;

export async function dueCampaignCalls(db: SqlExecutor, orgId: string, now: Date): Promise<CampaignCallsResponse> {
  return { campaigns: await dueCampaignCallRows(db, orgId, now) };
}

export type StartCampaignCallsResult =
  | { kind: 'started'; sessionId: string; total: number }
  | { kind: 'nothing_due' }
  | { kind: 'build_failed'; error: string };

export interface StartCampaignCallsDeps {
  db: SqlExecutor;
  now: Date;
  /** Builds the READY run — in production `createDialerSession` with the rep's own Salesforce token. */
  build: (args: { objectType: 'Lead' | 'Opportunity'; recordIds: string[]; campaignId: string }) => Promise<{ sessionId: string; total: number }>;
}

/**
 * Claim the campaign's due touches, build the run over their records, then
 * link the touches to it. The claim commits BEFORE the build (which makes
 * Salesforce calls — no row lock is held across HTTP); if the build or the link
 * fails, the claim is released so the touches go back in the queue.
 */
export async function startCampaignCalls(
  deps: StartCampaignCallsDeps,
  args: { orgId: string; campaignId: string },
): Promise<StartCampaignCallsResult> {
  const claimed = await claimCampaignTouches(deps.db, { orgId: args.orgId, campaignId: args.campaignId, now: deps.now, limit: CAMPAIGN_CALL_BATCH });
  if (claimed.length === 0) return { kind: 'nothing_due' };
  const touchIds = claimed.map((c) => c.touchId);
  try {
    const run = await deps.build({
      objectType: claimed[0]!.sfObject,
      recordIds: [...new Set(claimed.map((c) => c.sfRecordId))],
      campaignId: args.campaignId,
    });
    await attachSession(deps.db, touchIds, run.sessionId);
    return { kind: 'started', sessionId: run.sessionId, total: run.total };
  } catch (err) {
    await releaseTouches(deps.db, touchIds);
    return { kind: 'build_failed', error: (err as Error).message };
  }
}
```

- [ ] **Step 14: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/campaign-calls.test.ts
```

Expected: `✓ src/dialer/campaign-calls.test.ts (5 tests)`.

- [ ] **Step 15: Write the failing `campaignId` tests for `createDialerSession`**

In `services/cti-api/src/dialer/create-session.test.ts`, inside `describe('createDialerSession — nothing dials at creation'`, insert after line 167 (the `  });` that closes its only `it`) and before line 168 (the `});` that closes the `describe`):

```ts

  it('stores the outreach campaign a run came from, so its touches can be reconciled against it', async () => {
    const db = fakeDb();
    await createDialerSession({ ...noResolveDeps, db: db as never }, { ...args, campaignId: '11111111-1111-4111-8111-111111111111' });
    expect(db._sessionInsert).toMatchObject({ campaignId: '11111111-1111-4111-8111-111111111111', listViewId: null });
  });

  it('a run that is not from a campaign stores campaign_id null', async () => {
    const db = fakeDb();
    await createDialerSession({ ...noResolveDeps, db: db as never }, args);
    expect(db._sessionInsert).toMatchObject({ campaignId: null });
  });
```

- [ ] **Step 16: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/create-session.test.ts
```

Expected: `Tests  2 failed | 58 passed (60)`. The failures are the two new tests: the insert has no `campaignId`.

- [ ] **Step 17: Store `campaign_id`**

In `services/cti-api/src/dialer/create-session.ts`, replace the `args` type of `createDialerSession` (line 362):

```ts
  args: { userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[]; listViewId?: string },
```

with:

```ts
  args: {
    userId: string; orgId: string; objectType: DialerRunObject; recordIds: string[]; listViewId?: string;
    /** Outreach campaign the run's records came from (POST /dialer/sessions/from-campaign); reconciliation keys on it. */
    campaignId?: string;
  },
```

In the `dialer_sessions` insert's `.values({ … })`, add after `listViewId: args.listViewId ?? null,`:

```ts
      campaignId: args.campaignId ?? null,
```

- [ ] **Step 18: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/dialer/create-session.test.ts && npm -w services/cti-api run typecheck
```

Expected: `Tests  60 passed (60)`. The typecheck exits 0.

- [ ] **Step 19: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add \
  services/cti-api/src/dialer/campaign-calls.ts \
  services/cti-api/src/dialer/campaign-calls.test.ts \
  services/cti-api/src/dialer/create-session.ts \
  services/cti-api/src/dialer/create-session.test.ts
git commit -m "feat(cti-api): claim due campaign calls into a READY run and record the campaign on the session"
```

#### Part 4: cti-api routes

- [ ] **Step 20: Write the failing test**

`services/cti-api/src/routes/dialer-campaigns.test.ts` runs the real claim functions over a fake `execute` that renders each statement:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Campaign calls (outreach spec §10.1) — the two routes, wired end to end
// through the REAL startCampaignCalls / @cti/db claim functions. Only the
// edges are faked, in this file's usual way (see dialer-handoffs.test.ts):
// the session (`@cti/auth`), the database handle (`getDb` → `state.db`, whose
// `execute` answers the claim with `state.claimRows`), and the run builder
// (`createDialerSession`). The claim SQL itself is pinned in
// packages/db/src/campaign-calls.test.ts and on real Postgres in
// services/outreach-api/src/campaigns/campaign-calls.pg.test.ts.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  authedUser: null as { userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean } | null,
  db: null as unknown,
  claimRows: [] as Array<Record<string, unknown>>,
  dueRows: [] as Array<Record<string, unknown>>,
  statements: [] as Array<{ sql: string; params: unknown[] }>,
  createCalls: [] as Array<Record<string, unknown>>,
  createResult: { sessionId: '22222222-2222-4222-8222-222222222222', total: 2 } as { sessionId: string; total: number } | Error,
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.authedUser,
}));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => state.db,
}));
vi.mock('../dialer/create-session.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/create-session.js')>()),
  createDialerSession: async (_deps: unknown, args: Record<string, unknown>) => {
    state.createCalls.push(args);
    if (state.createResult instanceof Error) throw state.createResult;
    return state.createResult;
  },
}));

import { registerDialerRoutes } from './dialer.js';

const dialect = new PgDialect();
const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
const CAMPAIGN = '11111111-1111-4111-8111-111111111111';
const auth = { authorization: 'Bearer t' };

let app: FastifyInstance;
beforeEach(async () => {
  state.authedUser = REP;
  state.claimRows = [];
  state.dueRows = [];
  state.statements = [];
  state.createCalls = [];
  state.createResult = { sessionId: '22222222-2222-4222-8222-222222222222', total: 2 };
  state.db = {
    execute: async (q: SQL) => {
      const r = dialect.sqlToQuery(q);
      const sql = r.sql.replace(/\s+/g, ' ').trim();
      state.statements.push({ sql, params: r.params });
      if (sql.includes('skip locked')) return { rows: state.claimRows };
      if (sql.includes('count(*)')) return { rows: state.dueRows };
      return { rows: [] };
    },
  };
  app = Fastify();
  await registerDialerRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

describe('GET /dialer/campaigns', () => {
  it("lists the caller's org's campaigns with due rep calls", async () => {
    state.dueRows = [{ id: CAMPAIGN, name: 'Spring sellers', sf_object: 'Lead', due: 12 }];
    const res = await app.inject({ method: 'GET', url: '/dialer/campaigns', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ campaigns: [{ id: CAMPAIGN, name: 'Spring sellers', sfObject: 'Lead', due: 12 }] });
    expect(state.statements[0]!.params.slice(0, 2)).toEqual(['O1', 'O1']);
  });

  it('401 without a session, 403 without the power-dialer grant — and no query either way', async () => {
    state.authedUser = null;
    expect((await app.inject({ method: 'GET', url: '/dialer/campaigns' })).statusCode).toBe(401);
    state.authedUser = { ...REP, powerDialerEnabled: false };
    const res = await app.inject({ method: 'GET', url: '/dialer/campaigns', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'power_dialer_disabled' });
    expect(state.statements).toEqual([]);
  });
});

describe('POST /dialer/sessions/from-campaign', () => {
  const start = (payload: unknown) => app.inject({ method: 'POST', url: '/dialer/sessions/from-campaign', headers: auth, payload: payload as Record<string, unknown> });

  it("claims the due touches, builds a READY run over their records with the campaign on it, and answers { sessionId, total }", async () => {
    state.claimRows = [
      { touch_id: 'T1', due_at: '2026-10-05T13:00:00.000Z', sf_record_id: '006000000000001AAA', sf_object: 'Opportunity' },
      { touch_id: 'T2', due_at: '2026-10-05T14:00:00.000Z', sf_record_id: '006000000000002AAA', sf_object: 'Opportunity' },
    ];
    const res = await start({ campaignId: CAMPAIGN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: '22222222-2222-4222-8222-222222222222', total: 2 });
    expect(state.statements[0]!.params.slice(0, 3)).toEqual(['O1', 'O1', CAMPAIGN]);
    expect(state.createCalls).toEqual([{
      userId: 'U-ME', orgId: 'O1', objectType: 'Opportunity', recordIds: ['006000000000001AAA', '006000000000002AAA'], campaignId: CAMPAIGN,
    }]);
    expect(state.statements[1]!.sql).toContain('set dialer_session_id = $1');
    expect(state.statements[1]!.params).toEqual(['22222222-2222-4222-8222-222222222222', 'T1', 'T2']);
  });

  it('404 when nothing is due — no run is built', async () => {
    const res = await start({ campaignId: CAMPAIGN });
    expect(res.statusCode).toBe(404);
    expect(state.createCalls).toEqual([]);
  });

  it('a Salesforce failure while building releases the claimed touches and answers 502', async () => {
    state.claimRows = [{ touch_id: 'T1', due_at: '2026-10-05T13:00:00.000Z', sf_record_id: '00Q000000000001AAA', sf_object: 'Lead' }];
    state.createResult = new Error('could not resolve Salesforce user id (status 401)');
    const res = await start({ campaignId: CAMPAIGN });
    expect(res.statusCode).toBe(502);
    expect(state.statements.at(-1)!.sql).toBe(
      "update touches set status = 'queued', dialer_session_id = null, claimed_at = null, updated_at = now() where id in ($1) and status = 'dialing'",
    );
    expect(state.statements.at(-1)!.params).toEqual(['T1']);
  });

  it('400 on a body without a campaign uuid; 403 without the grant; 401 without a session — nothing claimed', async () => {
    expect((await start({ campaignId: 'not-a-uuid' })).statusCode).toBe(400);
    state.authedUser = { ...REP, powerDialerEnabled: false };
    expect((await start({ campaignId: CAMPAIGN })).statusCode).toBe(403);
    state.authedUser = null;
    expect((await start({ campaignId: CAMPAIGN })).statusCode).toBe(401);
    expect(state.statements).toEqual([]);
  });
});
```

- [ ] **Step 21: Run it to verify it fails**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/routes/dialer-campaigns.test.ts
```

Expected: `Tests  5 failed | 1 passed (6)`. Neither route exists, so every request gets Fastify's 404. The `404 when nothing is due` test passes for that reason, and Step 24 makes it pass for the right one.

- [ ] **Step 22: Add the routes**

In `services/cti-api/src/routes/dialer.ts`, after the header line ` *  POST /dialer/sessions              → create a READY session over a Lead/Opportunity/Task id list (nothing dials yet)` (line 4), add:

```ts
 *  GET  /dialer/campaigns             → outreach campaigns with rep calls due now (the Campaign calls picker)
 *  POST /dialer/sessions/from-campaign → claim a campaign's due rep calls and build a READY session over them
```

Replace line 31:

```ts
import { MAX_RUN_RECORDS, type DialerRunSettings } from '@cti/contracts';
```

with:

```ts
import { MAX_RUN_RECORDS, StartCampaignCallsRequest, type DialerRunSettings, type StartCampaignCallsResponse } from '@cti/contracts';
```

After line 37, `import { createDialerSession } from '../dialer/create-session.js';`, add:

```ts
import { dueCampaignCalls, startCampaignCalls } from '../dialer/campaign-calls.js';
```

After the `POST /dialer/sessions` handler, which ends `    return result;\n  });` at line 395, insert:

```ts

  // Campaign calls (outreach spec §10.1): the org's active campaigns with
  // rep-call touches due now — what the softphone's Campaign calls picker lists.
  app.get('/dialer/campaigns', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    if (!requirePowerDialer(authed, reply)) return reply;
    return dueCampaignCalls(getDb(), authed.orgId, new Date());
  });

  // POST /dialer/sessions/from-campaign { campaignId } — claim the campaign's
  // due rep-call touches and build a normal READY run over their records with
  // the rep's own Salesforce token (every build-time gate applies). A failed
  // build gives the touches back to the queue.
  app.post('/dialer/sessions/from-campaign', async (req, reply) => {
    const authed = await resolveSession(req.headers.authorization);
    if (!authed) return reply.code(401).send({ error: 'Unauthorized' });
    if (!requirePowerDialer(authed, reply)) return reply;
    const parsed = StartCampaignCallsRequest.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const db = getDb();
    const result = await startCampaignCalls(
      {
        db,
        now: new Date(),
        build: ({ objectType, recordIds, campaignId }) => createDialerSession(
          {
            resolveDialNumber, fetchTasks, fetchContactNames, salesforceUserId, db,
            workedRecently: (orgId, numbers) => workedRecentlySafe(db, orgId, numbers),
            consentBlocked: (orgId, numbers) => blockedTargetsSafe(db, orgId, numbers),
            preferredNumbers: (orgId, pairs) => preferredNumbersFor(db, orgId, pairs),
            listStartPosition: (orgId, listViewIdArg, now) => listRunStart(db, orgId, listViewIdArg, now),
          },
          { userId: authed.userId, orgId: authed.orgId, objectType, recordIds, campaignId },
        ),
      },
      { orgId: authed.orgId, campaignId: parsed.data.campaignId },
    );
    if (result.kind === 'nothing_due') return reply.code(404).send({ error: 'No campaign calls are due right now.' });
    if (result.kind === 'build_failed') {
      req.log.warn({ campaignId: parsed.data.campaignId, err: result.error }, 'campaign_calls_build_failed');
      return reply.code(502).send({ error: 'Could not build the call list from Salesforce — is the rep signed in? Try again.' });
    }
    const body: StartCampaignCallsResponse = { sessionId: result.sessionId, total: result.total };
    return body;
  });
```

The `createDialerSession` deps are exactly the ones `POST /dialer/sessions` passes, plus `campaignId`. Check them against that handler (lines 368–395) when you apply this. If that handler's deps have changed since, copy its object.

- [ ] **Step 23: Run the tests to verify they pass**

```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/routes/dialer-campaigns.test.ts src/dialer && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -4
```

Expected: `✓ src/routes/dialer-campaigns.test.ts (6 tests)` and the dialer files pass. The typecheck exits 0. The full cti-api suite passes; on the prototype base that was `Test Files  102 passed (102)`, `Tests  2074 passed (2074)`.

- [ ] **Step 24: Commit**

```bash
cd "$(git rev-parse --show-toplevel)" && git add services/cti-api/src/routes/dialer.ts services/cti-api/src/routes/dialer-campaigns.test.ts
git commit -m "feat(cti-api): add GET /dialer/campaigns and POST /dialer/sessions/from-campaign"
```

> **Note for B5 (reconciliation):** `createDialerSession` can gate a claimed record out at build time (opt-out, already worked, no dialable number). Its touch is still linked to the session as `dialing`, but no dial attempt for it will ever exist. B5 must treat "session ended, no attempt for this record" as not dialed, and requeue or skip that touch. Otherwise the touch stays `dialing` forever.

---

### Task 5: cti-web — Campaign calls picker [B5]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> - B5 ran in full against apps/cti-web at fa78987, with B4's contracts shimmed. The cti-web suite went from 57 files / 912 tests to 59 / 928, and the typecheck was clean.
> - B6 ran on Postgres 17 with a stand-in for the A3 tables. That covers reconcile.ts and both reconcile test files.
> - B7 ran the same way for config, alerts, pause.ts, pause.pg.test.ts, kill-switch.pg.test.ts, routes/status.ts and the outreach-web banner.
> - B7 code that edits files A8/A9/A10/B2/B4 have not produced yet was written against their drafts and was not run: pause-alerts.pg.test.ts, kill-switch.test.ts, the cti-api kill-switch test, and every server.ts and refresh/triage/outbox edit.
> - B8's railway.ts edit was typechecked. The .env.example test ran against the pre-A5 config. -->
>

A rep starts campaign calls from the softphone's Power dial tab. Below the list-view picker, a "Campaign calls" picker lists the tenant's active campaigns with rep calls due now. "Dial campaign calls" starts a normal READY run through B4's `POST /dialer/sessions/from-campaign`, with the same confirm block and the same gates. The picker renders nothing when nothing is due or the list cannot be loaded, so a tenant with no campaigns sees the softphone exactly as before.

**Files:**
- Create:
  - `apps/cti-web/src/components/CampaignCallsPicker.tsx`
  - `apps/cti-web/src/components/CampaignCallsPicker.test.tsx`
  - `apps/cti-web/src/dialer-api.campaign-calls.test.ts`
- Modify `apps/cti-web/src/dialer-api.ts`:
  - lines 1–2 (imports)
  - append after line 192 (the end of the file)
- Modify `apps/cti-web/src/components/DialerPanel.tsx`:
  - lines 2–3 (header comment)
  - insert after line 37 (import)
  - insert after line 560 (prop)
  - line 937 (destructure)
  - line 1227 (idle render)
- Modify `apps/cti-web/src/App.tsx`:
  - lines 23–33 (the `./dialer-api` import)
  - insert after line 1398 (the end of `startPowerDialFromListView`)
  - insert after line 2255 (`onStartFromListView={startPowerDialFromListView}`)

Line numbers are at fa78987. cti-web is edited live by another session, so check each anchor before you edit it:
```bash
grep -n "import { RunSettingsBlock }\|onStartFromListView: (object\|sessionId, onScreenPop, onStartFromListView\|return <ListViewPicker onStart" apps/cti-web/src/components/DialerPanel.tsx
grep -n "^  startDialerFromListView,\|const startPowerDialFromListView\|onStartFromListView={startPowerDialFromListView}" apps/cti-web/src/App.tsx
```

**Interfaces:**
- **Consumes:**
  - From B4 `@cti/contracts`: the value `CampaignCallsResponse` (`{ campaigns: Array<{ id: uuid; name: string; sfObject: 'Lead' | 'Opportunity'; due: number }> }`).
  - B4 cti-api routes:
    - `GET /dialer/campaigns` → `CampaignCallsResponse`
    - `POST /dialer/sessions/from-campaign` with `{ campaignId }` → `{ sessionId, total }`. It answers 404 when nothing is due and 502 when the build failed.
  - From cti-web `./api`: `api(path, { method, body })` and `class ApiError { status; body }`.
  - In `App.tsx`: `beginRun`, `refreshMe`, `setToast` and `dialerStartErrorMessage`.
- **Produces:**
  - `dialer-api.ts`:
    - `getCampaignCalls(): Promise<CampaignCallsResponse>`
    - `startDialerFromCampaign(campaignId: string): Promise<{ sessionId: string; total: number }>`
    - `campaignStartErrorText(e: unknown): string | null`
  - `components/CampaignCallsPicker.tsx`:
    - `campaignDueLabel(c: { due: number; sfObject: 'Lead' | 'Opportunity' }): string`
    - `CampaignCallsPicker({ onStart }: { onStart: (campaignId: string) => Promise<void> }): JSX.Element | null`
  - `DialerPanelProps.onStartFromCampaign?: (campaignId: string) => Promise<void>`
  - `App.tsx` `startPowerDialFromCampaign`

- [ ] **Step 1: Write the failing tests**

Create `apps/cti-web/src/dialer-api.campaign-calls.test.ts`:
```ts
/**
 * The two Campaign calls API calls (plan 1B task B5) and the 404 toast text.
 * Same idiom as dialer-api.test.ts: `api` is spied, nothing hits the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { campaignStartErrorText, getCampaignCalls, startDialerFromCampaign } from './dialer-api';
import * as apiModule from './api';
import { ApiError } from './api';

const SPRING = { id: '11111111-1111-4111-8111-111111111111', name: 'Spring sellers', sfObject: 'Lead', due: 12 };

afterEach(() => { vi.restoreAllMocks(); });

describe('getCampaignCalls', () => {
  it('GETs /dialer/campaigns and returns the parsed list', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ campaigns: [SPRING] });
    expect(await getCampaignCalls()).toEqual({ campaigns: [SPRING] });
    expect(mockApi).toHaveBeenCalledWith('/dialer/campaigns', { method: 'GET' });
  });

  it('rejects a body that is not a campaign list (an older server answers {} or an HTML page)', async () => {
    vi.spyOn(apiModule, 'api').mockResolvedValue({});
    await expect(getCampaignCalls()).rejects.toThrow();
    vi.spyOn(apiModule, 'api').mockResolvedValue({ campaigns: [{ ...SPRING, id: 'not-a-uuid' }] });
    await expect(getCampaignCalls()).rejects.toThrow();
  });
});

describe('startDialerFromCampaign', () => {
  it('POSTs the campaign id to /dialer/sessions/from-campaign', async () => {
    const mockApi = vi.spyOn(apiModule, 'api').mockResolvedValue({ sessionId: 'sess-9', total: 12 });
    expect(await startDialerFromCampaign(SPRING.id)).toEqual({ sessionId: 'sess-9', total: 12 });
    expect(mockApi).toHaveBeenCalledWith('/dialer/sessions/from-campaign', { method: 'POST', body: { campaignId: SPRING.id } });
  });
});

describe('campaignStartErrorText', () => {
  it('names the race when nothing is due any more (404)', () => {
    expect(campaignStartErrorText(new ApiError(404, { error: 'nothing due' })))
      .toBe('No campaign calls are due right now. Another rep may have just started them.');
  });

  it('leaves every other failure to the generic dialer message', () => {
    expect(campaignStartErrorText(new ApiError(403, { error: 'power_dialer_disabled' }))).toBeNull();
    expect(campaignStartErrorText(new ApiError(502, { error: 'build failed' }))).toBeNull();
    expect(campaignStartErrorText(new Error('network'))).toBeNull();
  });
});
```

Create `apps/cti-web/src/components/CampaignCallsPicker.test.tsx`:
```tsx
/** @vitest-environment jsdom */
/**
 * Campaign calls picker (spec 2026-10-04 §10.1, plan 1B task B5): lists the
 * campaigns with rep calls due, starts the chosen one through the parent's
 * `onStartFromCampaign`, and stays out of the way — renders nothing — when
 * nothing is due or the list cannot be loaded. Also pins DialerPanel's idle
 * state: the list-view picker first, then this picker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CampaignCallsPicker, campaignDueLabel } from './CampaignCallsPicker';
import { DialerPanel } from './DialerPanel';
import * as dialerApi from '../dialer-api';

const SPRING = { id: '11111111-1111-4111-8111-111111111111', name: 'Spring sellers', sfObject: 'Lead' as const, due: 12 };
const PROBATE = { id: '22222222-2222-4222-8222-222222222222', name: 'Probate', sfObject: 'Opportunity' as const, due: 1 };
const noop = () => {};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('campaignDueLabel', () => {
  it.each([
    [{ due: 12, sfObject: 'Lead' as const }, '12 Leads due'],
    [{ due: 1, sfObject: 'Lead' as const }, '1 Lead due'],
    [{ due: 1, sfObject: 'Opportunity' as const }, '1 Opportunity due'],
    [{ due: 3, sfObject: 'Opportunity' as const }, '3 Opportunities due'],
  ])('%o → %s', (input, expected) => {
    expect(campaignDueLabel(input)).toBe(expected);
  });
});

describe('CampaignCallsPicker', () => {
  it('lists every campaign with calls due, with its due count', async () => {
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING, PROBATE] });
    render(<CampaignCallsPicker onStart={async () => {}} />);
    expect(await screen.findByText('Campaign calls')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Spring sellers · 12 Leads due' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Probate · 1 Opportunity due' })).toBeTruthy();
  });

  it('starts the first campaign by default, and the one the rep picks after that', async () => {
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING, PROBATE] });
    const onStart = vi.fn(async () => {});
    render(<CampaignCallsPicker onStart={onStart} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dial campaign calls' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(SPRING.id));

    fireEvent.change(screen.getByRole('combobox', { name: 'Campaign' }), { target: { value: PROBATE.id } });
    fireEvent.click(await screen.findByRole('button', { name: 'Dial campaign calls' }));
    await waitFor(() => expect(onStart).toHaveBeenLastCalledWith(PROBATE.id));
    expect(onStart).toHaveBeenCalledTimes(2);
  });

  it('disables the button while the run is being built', async () => {
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING] });
    let finish: () => void = noop;
    const onStart = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    render(<CampaignCallsPicker onStart={onStart} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dial campaign calls' }));
    const busy = await screen.findByRole('button', { name: 'Building the run…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    finish();
    expect(await screen.findByRole('button', { name: 'Dial campaign calls' })).toBeTruthy();
  });

  it('renders nothing when no campaign has calls due', async () => {
    const spy = vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [{ ...SPRING, due: 0 }] });
    const { container } = render(<CampaignCallsPicker onStart={async () => {}} />);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing, and logs, when the list cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
    const failure = new Error('API 500: {"error":"boom"}');
    vi.spyOn(dialerApi, 'getCampaignCalls').mockRejectedValue(failure);
    const { container } = render(<CampaignCallsPicker onStart={async () => {}} />);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('[campaign-calls]'), failure));
    expect(container.innerHTML).toBe('');
  });
});

describe('DialerPanel idle state', () => {
  const props = {
    onScreenPop: noop, onStartFromListView: async () => {}, onPrepare: async () => {},
    onJoin: async () => true, onStop: noop, onComplete: noop, onDismiss: noop,
  };

  it('renders the list-view picker, then the Campaign calls picker, which starts through onStartFromCampaign', async () => {
    vi.spyOn(dialerApi, 'getSalesforceListViews').mockResolvedValue({ listViews: [] });
    vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING] });
    const onStartFromCampaign = vi.fn(async () => {});
    render(<DialerPanel sessionId={null} {...props} onStartFromCampaign={onStartFromCampaign} />);
    await screen.findByText('Campaign calls');
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Power dial a list')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Power dial a list')).toBeLessThan(text.indexOf('Campaign calls'));
    fireEvent.click(screen.getByRole('button', { name: 'Dial campaign calls' }));
    await waitFor(() => expect(onStartFromCampaign).toHaveBeenCalledWith(SPRING.id));
  });

  it('without onStartFromCampaign: only the list-view picker, and no campaign request', async () => {
    vi.spyOn(dialerApi, 'getSalesforceListViews').mockResolvedValue({ listViews: [] });
    const campaigns = vi.spyOn(dialerApi, 'getCampaignCalls').mockResolvedValue({ campaigns: [SPRING] });
    render(<DialerPanel sessionId={null} {...props} />);
    await screen.findByText('Power dial a list');
    expect(screen.queryByText('Campaign calls')).toBeNull();
    expect(campaigns).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

B4 must be merged first, because `CampaignCallsResponse` comes from `@cti/contracts`.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run build:packages >/dev/null && npm -w apps/cti-web run test -- src/components/CampaignCallsPicker.test.tsx src/dialer-api.campaign-calls.test.ts 2>&1 | tail -20
```
Expected: `Test Files  2 failed (2)`.
- `CampaignCallsPicker.test.tsx` fails to load with `Failed to resolve import "./CampaignCallsPicker" from "src/components/CampaignCallsPicker.test.tsx". Does the file exist?`.
- The dialer-api file runs, and its 5 tests fail with `TypeError: … getCampaignCalls is not a function` (and the same error for the other two functions).

- [ ] **Step 3: Add the API calls to `dialer-api.ts`**

In `apps/cti-web/src/dialer-api.ts`, replace lines 1–2:
```ts
import type { DialerPasses, DialerRunSettings, RolloverBusinessDays } from '@cti/contracts';
import { api } from './api';
```
with:
```ts
import { CampaignCallsResponse, type DialerPasses, type DialerRunSettings, type RolloverBusinessDays } from '@cti/contracts';
import { api, ApiError } from './api';
```
Append to the end of the file, after line 192, the closing brace of `takeDialerCallback`:
```ts

/** Outreach campaigns with rep calls due now (spec 2026-10-04 §10.1). The
 *  body is parsed: anything else (an older server, a proxy's error page)
 *  throws, and the Campaign calls picker stays hidden. */
export async function getCampaignCalls(): Promise<CampaignCallsResponse> {
  return CampaignCallsResponse.parse(await api('/dialer/campaigns', { method: 'GET' }));
}

/** Claim a campaign's due calls and create a READY run over their records —
 *  nothing dials until dialerControl(id, 'start'). The server answers 404
 *  when nothing is due any more (another rep started them first). */
export async function startDialerFromCampaign(campaignId: string): Promise<{ sessionId: string; total: number }> {
  return api('/dialer/sessions/from-campaign', {
    method: 'POST',
    body: { campaignId },
  });
}

/** The toast for a Campaign calls start that the generic dialer message
 *  would explain badly; null means "use the generic message". */
export function campaignStartErrorText(e: unknown): string | null {
  if (e instanceof ApiError && e.status === 404) {
    return 'No campaign calls are due right now. Another rep may have just started them.';
  }
  return null;
}
```

- [ ] **Step 4: Create the picker**

Create `apps/cti-web/src/components/CampaignCallsPicker.tsx`. It reuses the list-view picker's classes (`dialer-panel`, `section dp-picker`, `kicker`, `dp-picker-select`, `btn primary full`), so it needs no new CSS:
```tsx
/**
 * Campaign calls (spec 2026-10-04 §10.1): the outreach campaigns that have rep
 * calls due now. Choosing one builds a normal power-dial run over those
 * records (POST /dialer/sessions/from-campaign) — every dialer rule applies
 * unchanged (consent and DNC at build, calling hours, the FL/OK/WA/MD cap,
 * screening); the campaign adds no new path to a phone line.
 *
 * Hidden when nothing is due or the list cannot be loaded, so a softphone
 * whose tenant runs no campaigns looks exactly as it did before.
 */
import { useEffect, useState } from 'react';
import type { CampaignCallsResponse } from '@cti/contracts';
import { getCampaignCalls } from '../dialer-api';

type DueCampaign = CampaignCallsResponse['campaigns'][number];

/** Pure — "12 Leads due", "1 Opportunity due". */
export function campaignDueLabel(c: Pick<DueCampaign, 'due' | 'sfObject'>): string {
  const noun = c.sfObject === 'Lead'
    ? (c.due === 1 ? 'Lead' : 'Leads')
    : (c.due === 1 ? 'Opportunity' : 'Opportunities');
  return `${c.due} ${noun} due`;
}

export function CampaignCallsPicker({
  onStart,
}: {
  onStart: (campaignId: string) => Promise<void>;
}): JSX.Element | null {
  const [campaigns, setCampaigns] = useState<DueCampaign[]>([]);
  const [selected, setSelected] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCampaignCalls()
      .then((r) => {
        if (cancelled) return;
        const due = r.campaigns.filter((c) => c.due > 0);
        setCampaigns(due);
        setSelected(due[0]?.id ?? '');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCampaigns([]);
        console.warn('[campaign-calls] could not load campaigns with calls due', e);
      });
    return () => { cancelled = true; };
  }, []);

  if (campaigns.length === 0) return null;

  const dial = async (): Promise<void> => {
    if (!selected) return;
    setStarting(true);
    try {
      await onStart(selected);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="dialer-panel">
      <div className="section dp-picker">
        <div className="kicker">Campaign calls</div>
        <select
          className="dp-picker-select"
          aria-label="Campaign"
          value={selected}
          disabled={starting}
          onChange={(e) => setSelected(e.target.value)}
        >
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{`${c.name} · ${campaignDueLabel(c)}`}</option>
          ))}
        </select>
        <button className="btn primary full" disabled={!selected || starting} onClick={() => void dial()}>
          {starting ? 'Building the run…' : 'Dial campaign calls'}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Render it in DialerPanel's idle state**

In `apps/cti-web/src/components/DialerPanel.tsx`, replace lines 2–3:
```ts
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it). During a
```
with:
```ts
 * Power dialer control panel. With no run active it shows the list-view picker
 * (pick an object + one of the rep's Salesforce list views → dial it) and,
 * when the parent passes `onStartFromCampaign`, the Campaign calls picker
 * below it (outreach campaigns with rep calls due). During a
```
After line 37 (`import { RunSettingsBlock } from './RunSettingsBlock';`), insert:
```ts
import { CampaignCallsPicker } from './CampaignCallsPicker';
```
After line 560 (`  onStartFromListView: (object: DialerObjectType, listViewId: string) => Promise<void>;`), insert:
```ts
  /** Start a run from an outreach campaign's due calls (spec 2026-10-04
   *  §10.1; the parent creates the session). Absent: no Campaign calls picker. */
  onStartFromCampaign?: (campaignId: string) => Promise<void>;
```
On line 937, change `sessionId, onScreenPop, onStartFromListView, onPrepare,` to `sessionId, onScreenPop, onStartFromListView, onStartFromCampaign, onPrepare,`. The rest of the line stays the same.

Replace line 1227:
```tsx
    return <ListViewPicker onStart={onStartFromListView} />;
```
with:
```tsx
    return (
      <>
        <ListViewPicker onStart={onStartFromListView} />
        {onStartFromCampaign && <CampaignCallsPicker onStart={onStartFromCampaign} />}
      </>
    );
```

- [ ] **Step 6: Wire it in App.tsx**

In `apps/cti-web/src/App.tsx`, the `./dialer-api` import (lines 23–33) becomes:
```ts
import {
  campaignStartErrorText,
  dialerControl,
  getDialer,
  getPendingHandoff,
  startDialer,
  startDialerFromCampaign,
  startDialerFromListView,
  takeDialerCallback,
  type DialerObjectType,
  type DialerSession,
  type DialerSessionCounts,
} from './dialer-api';
```
This adds two lines, so `startPowerDialFromListView` now ends at line 1400 (`  );`). Insert this after it:
```tsx

  // Start a run from an outreach campaign's due calls (spec 2026-10-04
  // §10.1): the server claims the campaign's queued call touches and builds a
  // normal READY run over their records — same confirm block, same gates.
  const startPowerDialFromCampaign = useCallback(
    async (campaignId: string): Promise<void> => {
      try {
        // See startPowerDial's comment — same reasoning, same fix.
        const [{ sessionId }] = await Promise.all([
          startDialerFromCampaign(campaignId),
          refreshMe(),
        ]);
        beginRun(sessionId);
      } catch (e) {
        setToast({ text: campaignStartErrorText(e) ?? dialerStartErrorMessage(e), type: 'error' });
      }
    },
    [beginRun, refreshMe],
  );
```
On the `<DialerPanel` element, after the line `      onStartFromListView={startPowerDialFromListView}` (line 2255 before this task, about 2277 now; find it by its text), insert:
```tsx
      onStartFromCampaign={startPowerDialFromCampaign}
```

- [ ] **Step 7: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/cti-web run test -- src/components/CampaignCallsPicker.test.tsx src/dialer-api.campaign-calls.test.ts 2>&1 | tail -5
```
Expected: `Test Files  2 passed (2)` and `Tests  16 passed (16)`.

Now run the whole cti-web suite and its typecheck. Every existing test stays green: DialerPanel tests that render the idle state without the new prop get no picker and send no request. App tests that open the Power dial tab hit a failing or unstubbed `/dialer/campaigns`, so the picker hides itself.
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/cti-web run test 2>&1 | tail -5 && npm -w apps/cti-web run typecheck
```
Expected: no failures. Compared with a run before this task, there are 2 more test files and 16 more tests (at fa78987, 57 → 59 files and 912 → 928 tests). The typecheck is clean.

- [ ] **Step 8: Commit**
```bash
git add apps/cti-web/src/dialer-api.ts apps/cti-web/src/dialer-api.campaign-calls.test.ts apps/cti-web/src/components/CampaignCallsPicker.tsx apps/cti-web/src/components/CampaignCallsPicker.test.tsx apps/cti-web/src/components/DialerPanel.tsx apps/cti-web/src/App.tsx
git commit -m "feat(cti-web): Campaign calls picker starts a power-dial run from an outreach campaign"
```

---

### Task 6: outreach-api — `calls.reconcile` settles campaign call touches [B6]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> - B5 ran in full against apps/cti-web at fa78987, with B4's contracts shimmed. The cti-web suite went from 57 files / 912 tests to 59 / 928, and the typecheck was clean.
> - B6 ran on Postgres 17 with a stand-in for the A3 tables. That covers reconcile.ts and both reconcile test files.
> - B7 ran the same way for config, alerts, pause.ts, pause.pg.test.ts, kill-switch.pg.test.ts, routes/status.ts and the outreach-web banner.
> - B7 code that edits files A8/A9/A10/B2/B4 have not produced yet was written against their drafts and was not run: pause-alerts.pg.test.ts, kill-switch.test.ts, the cti-api kill-switch test, and every server.ts and refresh/triage/outbox edit.
> - B8's railway.ts edit was typechecked. The .env.example test ran against the pre-A5 config. -->
>

When a rep starts Campaign calls, B4 claims the campaign's queued `rep_call` touches: status `dialing`, `claimed_at` set, `dialer_session_id` stamped by `attachSession`. The CTI dialer never learns about touches. It writes `dialer_queue_items` for (session, record), including the engine's attempt-2 retry rows. This tick reads those rows every minute and settles each claimed touch, then moves its enrollment on.

**Files:**
- Create `services/outreach-api/src/campaigns/reconcile.ts`.
- Create `services/outreach-api/src/campaigns/reconcile.test.ts`. It holds the pure, table-driven decision tests plus the queue and schedule wiring.
- Create `services/outreach-api/src/campaigns/reconcile.pg.test.ts` (real Postgres).
- Modify `services/outreach-api/src/jobs/queues.ts`: add one `QUEUES` entry after `'sf.write'` (B2).
- Modify `services/outreach-api/src/jobs/schedules.ts`: add one `SCHEDULES` entry after `'sf.write'`.
- Modify `services/outreach-api/src/jobs/schedules.test.ts`: A8's exact-list assertion gains the new entry.
- Modify `services/outreach-api/src/server.ts`: one import and one `handlers` entry.

**Interfaces:**
- **Consumes:**
  - A3 tables:
    - `touches`: `id`, `enrollment_id`, `seq`, `channel`, `status`, `outcome`, `skip_reason`, `sent_at`, `dialer_session_id`, `claimed_at`, `updated_at`
    - `campaign_enrollments`: `status`, `exit_reason`, `touches_done`, `next_touch_at`
    - `crm_records`: `sf_record_id`
    - `enrollment_contact_keys`: `active`, which is left alone
  - CTI tables:
    - `dialer_sessions`: `id`, `status` (one of `active|paused|stopped|done|ready`), `created_at`, `updated_at`
    - `dialer_queue_items`: `session_id`, `record_id` (the Salesforce Id passed to `createDialerSession`), `status` (one of `pending|dialing|connected|no_connect|skipped|unreachable|done`), `outcome`, `attempt`, `ordinal`
  - A10 `advanceAfterTouch(db: Db, touchId: string, now: Date): Promise<void>`. It acts only on a touch in `sent|failed|skipped` and only while `touches_done < seq`.
  - A8 `type RunnerLogger`, `TICK_QUEUE_OPTIONS` (`policy: 'stately'`), `QUEUES` and `SCHEDULES`.
  - From `src/test/pg.ts`: `createTestDb()`, `pgLane` and `type TestDb`.
  - B4's claim protocol:
    - claim: `queued` → `dialing` with `claimed_at = now`
    - `attachSession` stamps `dialer_session_id`
    - `releaseTouches` puts a touch back to `queued`
- **Produces:**
  - Constants: `STALE_CLAIM_MS` (10 min), `ENDED_RUN_GRACE_MS` (10 min), `ABANDONED_READY_MS` (2 h), `RECONCILE_BATCH` (1000), `NOT_IN_RUN` (`'not_in_run'`).
  - Types: `DialerItemStatus`, `DialerSessionStatus`, `ReconcileItem`, `ReconcileSession`, `ReconcileInput`, and `Resolution` (`connected | sent{outcome} | skipped{reason} | release | abandon | wait`).
  - `resolveCampaignTouch(input: ReconcileInput): Resolution` (pure).
  - `reconcileCampaignCalls(deps: { db: Db; now: Date; log: RunnerLogger; batch?: number }): Promise<{ resolved: number; released: number }>`.
  - The queue `calls.reconcile`, scheduled `* * * * *`.

**Rules the tick applies, in order:**

| Situation | Touch becomes | Enrollment |
|---|---|---|
| Any item for the record is `connected` or `done` (an item becomes `done` only from `connected`, when the rep presses Next, End call or Redial) | `sent`, outcome `connected` | becomes `conversing` if `active`. `next_touch_at` is cleared. `touches_done` + 1. Contact keys stay active. No `advanceAfterTouch`. |
| Every item settled, at least one `no_connect` | `sent`, outcome = the last miss's outcome (ordered by attempt, then ordinal), `no_connect` if it had none | `advanceAfterTouch` if `active`, else `touches_done` + 1 |
| Every item settled, no `no_connect`. This includes records `createDialerSession` gated at build: consent, opt-out, DNC, Skip on Dialer, already worked, unreachable. They arrive as settled `skipped`/`unreachable` rows and are never dialed | `skipped`, `skip_reason` = the first item's outcome, or its status when the outcome is null (`unreachable`) | same as above |
| The run exists but has **no** row for the record (the build dropped it; the run's rows are complete before B4 stamps the run on the touch) | `skipped`, `skip_reason` `not_in_run`. Releasing it instead would re-claim and re-drop it on every run | same as above |
| Run ended (`stopped`/`done`), an item still `dialing`, run updated < 10 min ago | waits for Twilio's status callback | — |
| Run ended, some items settled | settled as above | — |
| Run ended, nothing settled | released: `queued`, session and claim cleared. If the enrollment is no longer `active`, it becomes `skipped` with the enrollment's exit reason and `touches_done` + 1 | — |
| Run `ready` (never started) for 2 h | the run is stopped (compare-and-swap on `ready`), then released | — |
| The run row is gone | released | — |
| No run yet, claimed ≥ 10 min ago (a crash between claim and build) | released | — |
| Anything else (run active/paused with items pending, or a fresh claim) | waits | — |

Every write is a compare-and-swap on `status = 'dialing'` and the touch's own `dialer_session_id`, so a second tick, or a rep re-claiming a released touch, never double-counts. Nothing is written to Salesforce here: the dialer already logs connects (a call Task) and misses (Chatter).

- [ ] **Step 1: Write the failing pure tests**

Create `services/outreach-api/src/campaigns/reconcile.test.ts`:
```ts
/**
 * resolveCampaignTouch — the pure decision behind the `calls.reconcile` tick
 * (plan 1B task B6), table-driven over item-status combinations and run
 * statuses. The database half is pinned in reconcile.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { QUEUES, TICK_QUEUE_OPTIONS } from '../jobs/queues.js';
import { SCHEDULES } from '../jobs/schedules.js';
import {
  ABANDONED_READY_MS,
  ENDED_RUN_GRACE_MS,
  STALE_CLAIM_MS,
  resolveCampaignTouch,
  type DialerItemStatus,
  type DialerSessionStatus,
  type ReconcileInput,
  type ReconcileItem,
  type Resolution,
} from './reconcile.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const msAgo = (ms: number): Date => new Date(NOW.getTime() - ms);
const minAgo = (m: number): Date => msAgo(m * 60_000);
const item = (status: DialerItemStatus, outcome: string | null = null, attempt = 1, ordinal = 0): ReconcileItem => ({ status, outcome, attempt, ordinal });
const inRun = (status: DialerSessionStatus, items: ReconcileItem[], at: { createdAgoMs?: number; updatedAgoMs?: number } = {}): ReconcileInput => ({
  sessionId: 'S1',
  claimedAt: minAgo(30),
  session: { status, createdAt: msAgo(at.createdAgoMs ?? 30 * 60_000), updatedAt: msAgo(at.updatedAgoMs ?? 60_000) },
  items,
  now: NOW,
});

const CONNECTED: Resolution = { kind: 'connected' };
const WAIT: Resolution = { kind: 'wait' };
const RELEASE: Resolution = { kind: 'release' };
const sent = (outcome: string): Resolution => ({ kind: 'sent', outcome });
const skipped = (reason: string): Resolution => ({ kind: 'skipped', reason });

describe('resolveCampaignTouch', () => {
  it.each<[string, ReconcileInput, Resolution]>([
    // A person answered — whatever else happened, and whatever the run's state.
    ['connected, run active', inRun('active', [item('connected', 'connected')]), CONNECTED],
    ['connected then closed by Next (done)', inRun('active', [item('done', 'connected')]), CONNECTED],
    ['connected, run stopped mid-call', inRun('stopped', [item('connected', 'connected')]), CONNECTED],
    ['attempt-2 row for the same record counted: miss, then connect', inRun('done', [item('no_connect', 'voicemail', 1), item('done', 'connected', 2)]), CONNECTED],
    // Every item settled without a connect.
    ['one miss', inRun('done', [item('no_connect', 'voicemail')]), sent('voicemail')],
    ['two misses: the outcome is the last dial', inRun('done', [item('no_connect', 'voicemail', 1, 4), item('no_connect', 'no_answer', 2, 4)]), sent('no_answer')],
    ['a miss, then a dial-time skip of the retry', inRun('active', [item('no_connect', 'busy', 1), item('skipped', 'out_of_hours', 2)]), sent('busy')],
    ['a miss with no recorded reason', inRun('done', [item('no_connect', null)]), sent('no_connect')],
    ['build-time consent skip, run still ready', inRun('ready', [item('skipped', 'dnc_blocked')]), skipped('dnc_blocked')],
    ['dial-time skip', inRun('active', [item('skipped', 'out_of_hours')]), skipped('out_of_hours')],
    ['no number', inRun('active', [item('unreachable', null)]), skipped('unreachable')],
    ['skip and unreachable: the first item names it', inRun('done', [item('unreachable', null, 1, 2), item('skipped', 'already_worked', 1, 1)]), skipped('already_worked')],
    // Still in play.
    ['pending, run active', inRun('active', [item('pending')]), WAIT],
    ['dialing, run active', inRun('active', [item('dialing')]), WAIT],
    ['pending, run paused', inRun('paused', [item('pending')]), WAIT],
    ['a miss with its retry pending, run active', inRun('active', [item('no_connect', 'voicemail', 1), item('pending', null, 2)]), WAIT],
    ['dropped at build: no item for the record, run active', inRun('active', []), skipped('not_in_run')],
    ['pending, run ready for an hour', inRun('ready', [item('pending')], { createdAgoMs: 60 * 60_000 }), WAIT],
    // The run is over before it reached the record.
    ['pending, run stopped', inRun('stopped', [item('pending')]), RELEASE],
    ['pending, a limited run done', inRun('done', [item('pending')]), RELEASE],
    ['dropped at build: no item for the record, run done', inRun('done', []), skipped('not_in_run')],
    ['a miss with its retry never dialed, run stopped', inRun('stopped', [item('no_connect', 'no_answer', 1), item('pending', null, 2)]), sent('no_answer')],
    ['dialing in a run stopped moments ago waits for the status callback', inRun('stopped', [item('dialing')], { updatedAgoMs: ENDED_RUN_GRACE_MS - 1 }), WAIT],
    ['dialing in a run stopped 10 minutes ago is released', inRun('stopped', [item('dialing')], { updatedAgoMs: ENDED_RUN_GRACE_MS }), RELEASE],
    ['ready and never started for 2 hours', inRun('ready', [item('pending')], { createdAgoMs: ABANDONED_READY_MS }), { kind: 'abandon' }],
    // Claims with no run.
    ['the run row is gone', { sessionId: 'S1', claimedAt: minAgo(1), session: null, items: [], now: NOW }, RELEASE],
    ['claimed without a run, under 10 minutes', { sessionId: null, claimedAt: msAgo(STALE_CLAIM_MS - 1), session: null, items: [], now: NOW }, WAIT],
    ['claimed without a run, 10 minutes', { sessionId: null, claimedAt: msAgo(STALE_CLAIM_MS), session: null, items: [], now: NOW }, RELEASE],
    ['claimed without a run or a claim time', { sessionId: null, claimedAt: null, session: null, items: [], now: NOW }, RELEASE],
  ])('%s', (_name, input, expected) => {
    expect(resolveCampaignTouch(input)).toEqual(expected);
  });
});

describe('calls.reconcile wiring', () => {
  it('is a tick queue with the shared tick options', () => {
    expect(QUEUES.find((q) => q.name === 'calls.reconcile')?.options).toBe(TICK_QUEUE_OPTIONS);
  });
  it('runs every minute', () => {
    expect(SCHEDULES).toContainEqual({ queue: 'calls.reconcile', cron: '* * * * *' });
  });
});
```

- [ ] **Step 2: Write the failing real-Postgres test**

Create `services/outreach-api/src/campaigns/reconcile.pg.test.ts`. Each case gets its own tenant, run and queue items, inserted with raw SQL, the same rows the CTI dialer writes. Then one tick runs over all of them. `advanceAfterTouch` is wrapped, not replaced, so the test can see which touches advanced. The module mock spreads `importOriginal()`.
```ts
/**
 * calls.reconcile against real Postgres (plan 1B task B6): one tick over a
 * table of claimed campaign touches, each with its own tenant, run, and queue
 * items inserted directly — the rows the CTI dialer writes. Skipped unless
 * TEST_DATABASE_URL is set (root `npm run test:pg`).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import { createTestDb, pgLane } from '../test/pg.js';
import type { DialerItemStatus, DialerSessionStatus } from './reconcile.js';

const advanced = vi.hoisted(() => [] as string[]);
vi.mock('../planner/run.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../planner/run.js')>();
  return {
    ...actual,
    advanceAfterTouch: async (db: Db, touchId: string, now: Date) => {
      advanced.push(touchId);
      return actual.advanceAfterTouch(db, touchId, now);
    },
  };
});

import { reconcileCampaignCalls } from './reconcile.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const minAgo = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
const OTHER_RECORD = '00Q0000000OTHER001';
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

interface ItemSpec { status: DialerItemStatus; outcome?: string; attempt?: number; otherRecord?: boolean }
interface Case {
  name: string;
  run: DialerSessionStatus | null;
  runCreatedMinAgo?: number;
  runUpdatedMinAgo?: number;
  claimedMinAgo?: number;
  enrollment?: { status: 'exited'; exitReason: string };
  items: ItemSpec[];
  expectTouch: { status: 'sent' | 'skipped' | 'queued' | 'dialing'; outcome: string | null; skipReason: string | null; keepsRun: boolean };
  expectEnrollment: { status: string; touchesDone: number };
  expectAdvanced: boolean;
  expectRunStatus?: DialerSessionStatus;
}

const CASES: Case[] = [
  { name: 'connected → sent/connected, enrollment conversing, no advance', run: 'active', items: [{ status: 'connected', outcome: 'connected' }],
    expectTouch: { status: 'sent', outcome: 'connected', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'conversing', touchesDone: 1 }, expectAdvanced: false },
  { name: 'connected then Next (done) counts as connected', run: 'active', items: [{ status: 'done', outcome: 'connected' }],
    expectTouch: { status: 'sent', outcome: 'connected', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'conversing', touchesDone: 1 }, expectAdvanced: false },
  { name: 'attempt-2 row for the same record counted: miss, then connect', run: 'done', items: [{ status: 'no_connect', outcome: 'voicemail', attempt: 1 }, { status: 'done', outcome: 'connected', attempt: 2 }],
    expectTouch: { status: 'sent', outcome: 'connected', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'conversing', touchesDone: 1 }, expectAdvanced: false },
  { name: 'all no_connect → sent with the last outcome', run: 'done', items: [{ status: 'no_connect', outcome: 'voicemail', attempt: 1 }, { status: 'no_connect', outcome: 'no_answer', attempt: 2 }],
    expectTouch: { status: 'sent', outcome: 'no_answer', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: "another record's connect in the same run does not count", run: 'done', items: [{ status: 'no_connect', outcome: 'busy' }, { status: 'connected', outcome: 'connected', otherRecord: true }],
    expectTouch: { status: 'sent', outcome: 'busy', skipReason: null, keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'skipped at dial time → skipped with the reason', run: 'active', items: [{ status: 'skipped', outcome: 'out_of_hours' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'out_of_hours', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'unreachable → skipped unreachable', run: 'active', items: [{ status: 'unreachable' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'unreachable', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'consent skip at build while the run is still ready', run: 'ready', items: [{ status: 'skipped', outcome: 'dnc_blocked' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'dnc_blocked', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'record dropped at build (no queue row in its run) → skipped not_in_run', run: 'active', items: [{ status: 'pending', otherRecord: true }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'not_in_run', keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 1 }, expectAdvanced: true },
  { name: 'session stopped with pending items → released to queued', run: 'stopped', runUpdatedMinAgo: 5, items: [{ status: 'pending' }],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'a limited run done before the record → released to queued', run: 'done', items: [{ status: 'pending' }],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'a live run with the retry pending waits', run: 'active', items: [{ status: 'no_connect', outcome: 'voicemail', attempt: 1 }, { status: 'pending', attempt: 2 }],
    expectTouch: { status: 'dialing', outcome: null, skipReason: null, keepsRun: true }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'stale claim without a session (> 10 min) → queued', run: null, claimedMinAgo: 11, items: [],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'fresh claim without a session waits', run: null, claimedMinAgo: 5, items: [],
    expectTouch: { status: 'dialing', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false },
  { name: 'a run never started for 2 hours is stopped and its touch queued', run: 'ready', runCreatedMinAgo: 121, items: [{ status: 'pending' }],
    expectTouch: { status: 'queued', outcome: null, skipReason: null, keepsRun: false }, expectEnrollment: { status: 'active', touchesDone: 0 }, expectAdvanced: false, expectRunStatus: 'stopped' },
  { name: 'released touch of an exited enrollment is skipped with the exit reason', run: 'stopped', enrollment: { status: 'exited', exitReason: 'left_query' }, items: [{ status: 'pending' }],
    expectTouch: { status: 'skipped', outcome: null, skipReason: 'left_query', keepsRun: false }, expectEnrollment: { status: 'exited', touchesDone: 1 }, expectAdvanced: false },
];

interface Seeded { touchId: string; enrollmentId: string; sessionId: string | null }

async function one<T>(pool: pg.Pool, text: string, values: unknown[]): Promise<T> {
  const { rows } = await pool.query(text, values);
  return rows[0] as T;
}

async function seed(pool: pg.Pool, c: Case): Promise<Seeded> {
  const tag = randomUUID().slice(0, 8);
  const sfRecordId = `00Q00000${tag}00`;
  const org = await one<{ id: string }>(pool, `insert into organizations (name, slug) values ($1, $2) returning id`, [`Reconcile ${tag}`, `reconcile-${tag}`]);
  const user = await one<{ id: string }>(pool, `insert into users (org_id, email) values ($1, $2) returning id`, [org.id, `rep-${tag}@example.test`]);
  const campaign = await one<{ id: string }>(pool,
    `insert into campaigns (org_id, name, sf_object, source_kind, soql, status) values ($1, 'Spring sellers', 'Lead', 'soql', 'SELECT Id FROM Lead', 'active') returning id`, [org.id]);
  const record = await one<{ id: string }>(pool,
    `insert into crm_records (org_id, sf_object, sf_record_id, phones) values ($1, 'Lead', $2, '[{"field":"MobilePhone","e164":"+16195550100"}]') returning id`, [org.id, sfRecordId]);
  const enrollment = await one<{ id: string }>(pool,
    `insert into campaign_enrollments (org_id, campaign_id, crm_record_id, status, exit_reason, enrolled_at) values ($1, $2, $3, $4, $5, $6) returning id`,
    [org.id, campaign.id, record.id, c.enrollment?.status ?? 'active', c.enrollment?.exitReason ?? null, minAgo(24 * 60)]);
  await pool.query(`insert into enrollment_contact_keys (enrollment_id, org_id, key, active) values ($1, $2, '+16195550100', $3)`, [enrollment.id, org.id, !c.enrollment]);
  let sessionId: string | null = null;
  if (c.run) {
    const run = await one<{ id: string }>(pool,
      `insert into dialer_sessions (org_id, user_id, sf_owner_id, object_type, status, campaign_id, created_at, updated_at) values ($1, $2, '005000000000001AAA', 'Lead', $3, $4, $5, $6) returning id`,
      [org.id, user.id, c.run, campaign.id, minAgo(c.runCreatedMinAgo ?? 30), minAgo(c.runUpdatedMinAgo ?? 1)]);
    sessionId = run.id;
    for (const [i, it] of c.items.entries()) {
      await pool.query(
        `insert into dialer_queue_items (session_id, ordinal, object_type, record_id, status, outcome, attempt) values ($1, $2, 'Lead', $3, $4, $5, $6)`,
        [sessionId, i, it.otherRecord ? OTHER_RECORD : sfRecordId, it.status, it.outcome ?? null, it.attempt ?? 1]);
    }
  }
  const touch = await one<{ id: string }>(pool,
    `insert into touches (org_id, enrollment_id, seq, channel, status, due_at, dialer_session_id, claimed_at) values ($1, $2, 1, 'rep_call', 'dialing', $3, $4, $5) returning id`,
    [org.id, enrollment.id, minAgo(60), sessionId, minAgo(c.claimedMinAgo ?? 30)]);
  return { touchId: touch.id, enrollmentId: enrollment.id, sessionId };
}

describe.skipIf(!pgLane)('reconcileCampaignCalls (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const seeded = new Map<string, Seeded>();
  let result: { resolved: number; released: number };

  beforeAll(async () => {
    t = await createTestDb();
    for (const c of CASES) seeded.set(c.name, await seed(t.pool, c));
    result = await reconcileCampaignCalls({ db: t.db, now: NOW, log });
  }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('counts what it settled and what it handed back, and logs no failure', () => {
    expect(log.error).not.toHaveBeenCalled();
    const resolved = CASES.filter((c) => c.expectTouch.status === 'sent' || c.expectTouch.status === 'skipped').length;
    const released = CASES.filter((c) => c.expectTouch.status === 'queued').length;
    expect(result).toEqual({ resolved, released });
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const s = seeded.get(c.name)!;
    const touch = await one<{ status: string; outcome: string | null; skip_reason: string | null; dialer_session_id: string | null; claimed_at: Date | null; sent_at: Date | null }>(
      t.pool, `select status, outcome, skip_reason, dialer_session_id, claimed_at, sent_at from touches where id = $1`, [s.touchId]);
    expect({ status: touch.status, outcome: touch.outcome, skipReason: touch.skip_reason })
      .toEqual({ status: c.expectTouch.status, outcome: c.expectTouch.outcome, skipReason: c.expectTouch.skipReason });
    expect(touch.dialer_session_id).toBe(c.expectTouch.keepsRun ? s.sessionId : null);
    if (c.expectTouch.status === 'queued') expect(touch.claimed_at).toBeNull();
    if (c.expectTouch.status === 'sent') expect(touch.sent_at?.toISOString()).toBe(NOW.toISOString());

    const enrollment = await one<{ status: string; touches_done: number }>(
      t.pool, `select status, touches_done from campaign_enrollments where id = $1`, [s.enrollmentId]);
    expect({ status: enrollment.status, touchesDone: enrollment.touches_done }).toEqual(c.expectEnrollment);
    expect(advanced.includes(s.touchId)).toBe(c.expectAdvanced);

    if (c.expectRunStatus && s.sessionId) {
      const run = await one<{ status: string }>(t.pool, `select status from dialer_sessions where id = $1`, [s.sessionId]);
      expect(run.status).toBe(c.expectRunStatus);
    }
  });

  it('a connected enrollment keeps its contact keys active (one active campaign per person)', async () => {
    const s = seeded.get(CASES[0]!.name)!;
    const key = await one<{ active: boolean }>(t.pool, `select active from enrollment_contact_keys where enrollment_id = $1`, [s.enrollmentId]);
    expect(key.active).toBe(true);
  });

  it('a second tick changes nothing that the first settled', async () => {
    advanced.length = 0;
    const again = await reconcileCampaignCalls({ db: t.db, now: NOW, log });
    expect(again).toEqual({ resolved: 0, released: 0 });
    expect(advanced).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/campaigns/reconcile.test.ts 2>&1 | tail -8
```
Expected: `Test Files  1 failed (1)`, with `Error: Failed to load url ./reconcile.js (resolved id: ./reconcile.js) in …/src/campaigns/reconcile.test.ts. Does the file exist?`.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "reconcile|Test Files|Tests "
```
Expected: both `reconcile.test.ts` and `reconcile.pg.test.ts` fail with the same `Failed to load url ./reconcile.js` error. Every other file passes.

- [ ] **Step 4: Write `reconcile.ts`**

Create `services/outreach-api/src/campaigns/reconcile.ts`. Raw `db.execute` returns `timestamptz` columns as strings under drizzle's node-postgres driver (pool `query` returns `Date`s), so every timestamp read here goes through `toDate`. Each claimed touch is settled in its own transaction and its own `try`. One bad row is logged and skipped, and it never stops the tick.
```ts
/**
 * Campaign call reconciliation (spec §10.1, plan 1B task B6) — the
 * `calls.reconcile` tick.
 *
 * A rep starts "Campaign calls" in the softphone: cti-api claims the campaign's
 * queued `rep_call` touches (status `dialing`, `claimed_at`), builds a normal
 * power-dial run over their records, and stamps the run's id on each touch
 * (`dialer_session_id`). The dialer itself never learns about touches. This
 * tick reads what the run wrote — the `dialer_queue_items` for (session,
 * record), which includes the engine's attempt-2 retry rows that carry no link
 * of their own (plan refinement 5) — and settles each claimed touch:
 *
 *  - an item reached a person (`connected`, or `done`, which only a connected
 *    item becomes once the rep presses Next / End call / Redial) → touch
 *    `sent`, outcome `connected`; the enrollment becomes `conversing` (the rep
 *    owns it now) and its contact keys stay active.
 *  - every item settled without a connect → `sent` with the last miss's
 *    outcome when any dial missed (`no_connect`), otherwise `skipped` with the
 *    first item's reason (build-time consent or flag skips, dial-time
 *    `out_of_hours`, or `unreachable`).
 *  - the record has no queue row in its run: `createDialerSession` dropped it
 *    at build. The run's rows are complete before B4 stamps the run on the
 *    touch, so the record will not be dialed in this run → `skipped`, reason
 *    `not_in_run`. (Releasing it would re-claim and re-drop it every run.)
 *    Build-time gates that DO write a row (consent, DNC, Skip on Dialer,
 *    already worked, unreachable) arrive as settled `skipped`/`unreachable`
 *    items and are handled by the rule above.
 *  - the run ended (`stopped`/`done`) before reaching the record → back to
 *    `queued` for the next run.
 *  - a run created and never started for 2 hours → stopped (only while still
 *    `ready`, compare-and-swap — the same write the softphone's "Choose a
 *    different list" makes) and its touches go back to `queued`.
 *  - a claim that never got its run (a crash between claim and build) → back
 *    to `queued` after 10 minutes.
 *
 * Settled non-connected touches advance the sequence through
 * `advanceAfterTouch`; a connected one does not — the person left the sequence
 * for a conversation. Nothing is written to Salesforce here: the dialer already
 * logs connects (call Task) and misses (Chatter) — plan refinement 7.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@cti/db';
import type { RunnerLogger } from '../jobs/boss.js';
import { advanceAfterTouch } from '../planner/run.js';

export const STALE_CLAIM_MS = 10 * 60_000;
/** A `dialing` item in a run that just ended is still waiting on Twilio's status callback. */
export const ENDED_RUN_GRACE_MS = 10 * 60_000;
export const ABANDONED_READY_MS = 2 * 60 * 60_000;
export const RECONCILE_BATCH = 1000;
/** Skip reason for a claimed record that `createDialerSession` left out of the run entirely. */
export const NOT_IN_RUN = 'not_in_run';

export type DialerItemStatus = 'pending' | 'dialing' | 'connected' | 'no_connect' | 'skipped' | 'unreachable' | 'done';
export type DialerSessionStatus = 'active' | 'paused' | 'stopped' | 'done' | 'ready';

export interface ReconcileItem { status: DialerItemStatus; outcome: string | null; attempt: number; ordinal: number }
export interface ReconcileSession { status: DialerSessionStatus; createdAt: Date; updatedAt: Date }
export interface ReconcileInput {
  /** The touch's `dialer_session_id`; null while the claim has no run yet. */
  sessionId: string | null;
  claimedAt: Date | null;
  /** Null when `sessionId` is set but the run's row is gone. */
  session: ReconcileSession | null;
  /** Every queue item of the run for this touch's record, retries included. */
  items: readonly ReconcileItem[];
  now: Date;
}
export type Resolution =
  | { kind: 'connected' }
  | { kind: 'sent'; outcome: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'release' }
  | { kind: 'abandon' }
  | { kind: 'wait' };

const CONNECTED: ReadonlySet<DialerItemStatus> = new Set(['connected', 'done']);
const LIVE: ReadonlySet<DialerItemStatus> = new Set(['pending', 'dialing']);
const ENDED: ReadonlySet<DialerSessionStatus> = new Set(['stopped', 'done']);

const ageMs = (now: Date, then: Date): number => now.getTime() - then.getTime();
const dialOrder = (a: ReconcileItem, b: ReconcileItem): number => a.attempt - b.attempt || a.ordinal - b.ordinal;

/** Every item settled without a connect: any miss makes it a sent call; only skips make it a skipped touch. */
function settle(settled: readonly ReconcileItem[]): Resolution {
  const ordered = [...settled].sort(dialOrder);
  const lastMiss = ordered.filter((i) => i.status === 'no_connect').at(-1);
  if (lastMiss) return { kind: 'sent', outcome: lastMiss.outcome ?? 'no_connect' };
  const first = ordered[0]!; // callers pass at least one settled item
  return { kind: 'skipped', reason: first.outcome ?? first.status };
}

/** Pure: what one claimed (`dialing`) campaign call touch becomes now. */
export function resolveCampaignTouch(input: ReconcileInput): Resolution {
  const { session, items, now } = input;
  if (!input.sessionId) {
    const fresh = input.claimedAt !== null && ageMs(now, input.claimedAt) < STALE_CLAIM_MS;
    return fresh ? { kind: 'wait' } : { kind: 'release' };
  }
  if (!session) return { kind: 'release' };
  // The run's rows are complete before the touch carries its id: no row means the build dropped the record.
  if (items.length === 0) return { kind: 'skipped', reason: NOT_IN_RUN };
  if (items.some((i) => CONNECTED.has(i.status))) return { kind: 'connected' };
  const live = items.filter((i) => LIVE.has(i.status));
  const settled = items.filter((i) => !LIVE.has(i.status));
  if (live.length === 0 && settled.length > 0) return settle(settled);
  if (ENDED.has(session.status)) {
    const ringing = live.some((i) => i.status === 'dialing');
    if (ringing && ageMs(now, session.updatedAt) < ENDED_RUN_GRACE_MS) return { kind: 'wait' };
    return settled.length > 0 ? settle(settled) : { kind: 'release' };
  }
  if (session.status === 'ready' && ageMs(now, session.createdAt) >= ABANDONED_READY_MS) return { kind: 'abandon' };
  return { kind: 'wait' };
}

// Raw `db.execute` rows: drizzle's node-postgres driver hands timestamps back as strings.
type Timestamp = Date | string;
interface ClaimedRow { touch_id: string; enrollment_id: string; session_id: string | null; claimed_at: Timestamp | null; sf_record_id: string }
interface SessionRow { id: string; status: DialerSessionStatus; created_at: Timestamp; updated_at: Timestamp }
interface ItemRow { session_id: string; record_id: string; status: DialerItemStatus; outcome: string | null; attempt: number; ordinal: number }
interface Runs { sessions: Map<string, ReconcileSession>; items: Map<string, ReconcileItem[]> }
type Executor = Pick<Db, 'execute'>;
type Applied = 'resolved' | 'released' | 'none';

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
const toDate = (v: Timestamp): Date => (v instanceof Date ? v : new Date(v));
const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}`), sql`, `);
const itemKey = (sessionId: string, recordId: string): string => `${sessionId}|${recordId}`;

async function loadClaimed(db: Db, batch: number): Promise<ClaimedRow[]> {
  return rowsOf<ClaimedRow>(await db.execute(sql`
    select t.id as touch_id, t.enrollment_id, t.dialer_session_id as session_id, t.claimed_at, r.sf_record_id
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id
    join crm_records r on r.id = e.crm_record_id
    where t.status = 'dialing' and t.channel = 'rep_call'
    order by t.claimed_at nulls first, t.id
    limit ${batch}`));
}

async function loadRuns(db: Db, sessionIds: readonly string[]): Promise<Runs> {
  const runs: Runs = { sessions: new Map(), items: new Map() };
  if (sessionIds.length === 0) return runs;
  const sessions = rowsOf<SessionRow>(await db.execute(sql`
    select id, status, created_at, updated_at from dialer_sessions where id in (${idList(sessionIds)})`));
  for (const s of sessions) runs.sessions.set(s.id, { status: s.status, createdAt: toDate(s.created_at), updatedAt: toDate(s.updated_at) });
  const items = rowsOf<ItemRow>(await db.execute(sql`
    select session_id, record_id, status, outcome, attempt, ordinal
    from dialer_queue_items where session_id in (${idList(sessionIds)})`));
  for (const i of items) {
    const key = itemKey(i.session_id, i.record_id);
    runs.items.set(key, [...(runs.items.get(key) ?? []), { status: i.status, outcome: i.outcome, attempt: i.attempt, ordinal: i.ordinal }]);
  }
  return runs;
}

function resolutionFor(row: ClaimedRow, runs: Runs, now: Date): Resolution {
  const session = row.session_id ? runs.sessions.get(row.session_id) ?? null : null;
  const items = row.session_id ? runs.items.get(itemKey(row.session_id, row.sf_record_id)) ?? [] : [];
  const claimedAt = row.claimed_at === null ? null : toDate(row.claimed_at);
  return resolveCampaignTouch({ sessionId: row.session_id, claimedAt, session, items, now });
}

/** A run nobody started: stop it while it is still `ready` (never once the rep has pressed Start). */
async function stopAbandonedRun(db: Db, sessionId: string, now: Date, log: RunnerLogger): Promise<boolean> {
  const stopped = rowsOf<{ id: string }>(await db.execute(sql`
    update dialer_sessions set status = 'stopped', updated_at = ${now}
    where id = ${sessionId} and status = 'ready'
    returning id`));
  if (stopped.length > 0) log.warn({ sessionId }, 'calls.reconcile: stopped a campaign run that was never started');
  return stopped.length > 0;
}

/** Count the touch without moving the sequence (its enrollment is no longer `active`). Same once-per-touch guard as advanceAfterTouch. */
async function bumpTouchesDone(tx: Executor, touchId: string, now: Date): Promise<void> {
  await tx.execute(sql`
    update campaign_enrollments e set touches_done = e.touches_done + 1, updated_at = ${now}
    from touches t
    where t.id = ${touchId} and e.id = t.enrollment_id and e.touches_done < t.seq`);
}

/** Settle a claimed touch (compare-and-swap on `dialing` + its run), then move its enrollment on. */
async function settleTouch(db: Db, row: ClaimedRow, end: Exclude<Resolution, { kind: 'release' | 'abandon' | 'wait' }>, now: Date): Promise<Applied> {
  const status = end.kind === 'skipped' ? 'skipped' : 'sent';
  const outcome = end.kind === 'connected' ? 'connected' : end.kind === 'sent' ? end.outcome : null;
  const skipReason = end.kind === 'skipped' ? end.reason : null;
  return db.transaction(async (tx) => {
    const updated = rowsOf<{ id: string }>(await tx.execute(sql`
      update touches set status = ${status}, outcome = ${outcome}, skip_reason = ${skipReason},
        sent_at = ${status === 'sent' ? now : null}, updated_at = ${now}
      where id = ${row.touch_id} and status = 'dialing' and dialer_session_id = ${row.session_id}
      returning id`));
    if (updated.length === 0) return 'none';
    const [enrollment] = rowsOf<{ status: string }>(await tx.execute(sql`
      select status from campaign_enrollments where id = ${row.enrollment_id} for update`));
    if (end.kind === 'connected') {
      // A connect is a reply (spec §10.1): the rep owns the conversation now.
      await tx.execute(sql`
        update campaign_enrollments e set
          status = case when e.status = 'active' then 'conversing' else e.status end,
          next_touch_at = case when e.status = 'active' then null else e.next_touch_at end,
          touches_done = case when e.touches_done < t.seq then e.touches_done + 1 else e.touches_done end,
          updated_at = ${now}
        from touches t
        where t.id = ${row.touch_id} and e.id = t.enrollment_id`);
    } else if (enrollment?.status === 'active') {
      await advanceAfterTouch(tx as unknown as Db, row.touch_id, now);
    } else {
      await bumpTouchesDone(tx, row.touch_id, now);
    }
    return 'resolved';
  });
}

/**
 * Hand a claimed touch back: `queued` for the next run while its enrollment is
 * still active, else `skipped` with the enrollment's exit reason (an exit while
 * the call was claimed left this touch behind — `exitEnrollment` cancels only
 * `planned|held|queued`).
 */
async function releaseTouch(db: Db, row: ClaimedRow, now: Date): Promise<Applied> {
  return db.transaction(async (tx) => {
    const [touch] = rowsOf<{ status: 'queued' | 'skipped' }>(await tx.execute(sql`
      update touches t set
        status = case when e.status = 'active' then 'queued' else 'skipped' end,
        skip_reason = case when e.status = 'active' then t.skip_reason else coalesce(e.exit_reason, e.status) end,
        dialer_session_id = null, claimed_at = null, updated_at = ${now}
      from campaign_enrollments e
      where t.id = ${row.touch_id} and e.id = t.enrollment_id and t.status = 'dialing'
        and t.dialer_session_id is not distinct from ${row.session_id}::uuid
      returning t.status`));
    if (!touch) return 'none';
    if (touch.status === 'queued') return 'released';
    await bumpTouchesDone(tx, row.touch_id, now);
    return 'resolved';
  });
}

async function apply(db: Db, row: ClaimedRow, r: Resolution, now: Date): Promise<Applied> {
  switch (r.kind) {
    case 'connected':
    case 'sent':
    case 'skipped':
      return settleTouch(db, row, r, now);
    case 'release':
      return releaseTouch(db, row, now);
    default:
      return 'none';
  }
}

export async function reconcileCampaignCalls(deps: { db: Db; now: Date; log: RunnerLogger; batch?: number }): Promise<{ resolved: number; released: number }> {
  const { db, now, log } = deps;
  const claimed = await loadClaimed(db, deps.batch ?? RECONCILE_BATCH);
  const sessionIds = [...new Set(claimed.flatMap((c) => (c.session_id ? [c.session_id] : [])))];
  const runs = await loadRuns(db, sessionIds);
  const abandoned = new Map<string, boolean>();
  const counts = { resolved: 0, released: 0 };
  for (const row of claimed) {
    try {
      let r = resolutionFor(row, runs, now);
      if (r.kind === 'abandon' && row.session_id) {
        if (!abandoned.has(row.session_id)) abandoned.set(row.session_id, await stopAbandonedRun(db, row.session_id, now, log));
        r = abandoned.get(row.session_id) ? { kind: 'release' } : { kind: 'wait' };
      }
      const applied = await apply(db, row, r, now);
      if (applied !== 'none') counts[applied] += 1;
    } catch (err) {
      log.error({ err: (err as Error).message, touchId: row.touch_id }, 'calls.reconcile: could not settle a campaign call touch');
    }
  }
  if (counts.resolved > 0 || counts.released > 0) log.info(counts, 'calls.reconcile');
  return counts;
}
```

- [ ] **Step 5: Declare the queue and its schedule**

In `services/outreach-api/src/jobs/queues.ts`, add this as the last `QUEUES` entry, after B2's `'sf.write'` line:
```ts
  { name: 'calls.reconcile', options: TICK_QUEUE_OPTIONS },
```
In `services/outreach-api/src/jobs/schedules.ts`, add this as the last `SCHEDULES` entry, after `'sf.write'`:
```ts
  { queue: 'calls.reconcile', cron: '* * * * *' },
```
In `services/outreach-api/src/jobs/schedules.test.ts`, A8's test "schedules refresh every 5 minutes and triage and planning every minute" pins the exact list. B2 extended it with `sf.write`. Add the new entry as the last element of its `toEqual([...])` array:
```ts
      { queue: 'calls.reconcile', cron: '* * * * *' },
```

- [ ] **Step 6: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/campaigns/reconcile.test.ts src/jobs 2>&1 | tail -5
```
Expected: no failures. `reconcile.test.ts` reports 31 tests (29 decisions and 2 wiring checks).
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "reconcile|Test Files|Tests "
```
Expected: `✓ src/campaigns/reconcile.pg.test.ts (19 tests)` and `✓ src/campaigns/reconcile.test.ts (31 tests)`. The suite's `Test Files` line shows no failures.

- [ ] **Step 7: Wire the handler in `server.ts`**

Add the import next to the other `./campaigns/…` imports:
```ts
import { reconcileCampaignCalls } from './campaigns/reconcile.js';
```
In `main()`'s `handlers` object, add this entry after A10's `'touch.plan'` entry and B2's `'sf.write'` entry. It is unconditional because it needs neither Salesforce nor AI: it only reads the dialer's tables and writes ours.
```ts
    // Settle claimed campaign call touches from the dialer runs that carried them (src/campaigns/reconcile.ts).
    'calls.reconcile': async () => {
      await reconcileCampaignCalls({ db, now: new Date(), log: console });
    },
```
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```
Expected: the typecheck is clean, and the suite passes with the `pgLane` suites skipped.

- [ ] **Step 8: Commit**
```bash
git add services/outreach-api/src/campaigns/reconcile.ts services/outreach-api/src/campaigns/reconcile.test.ts services/outreach-api/src/campaigns/reconcile.pg.test.ts services/outreach-api/src/jobs/queues.ts services/outreach-api/src/jobs/schedules.ts services/outreach-api/src/jobs/schedules.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): calls.reconcile settles campaign call touches from dialer runs"
```

---

### Task 7: Kill switch, automatic pause alerts, AI-budget resume, `GET /status`, banner [B7]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> - B5 ran in full against apps/cti-web at fa78987, with B4's contracts shimmed. The cti-web suite went from 57 files / 912 tests to 59 / 928, and the typecheck was clean.
> - B6 ran on Postgres 17 with a stand-in for the A3 tables. That covers reconcile.ts and both reconcile test files.
> - B7 ran the same way for config, alerts, pause.ts, pause.pg.test.ts, kill-switch.pg.test.ts, routes/status.ts and the outreach-web banner.
> - B7 code that edits files A8/A9/A10/B2/B4 have not produced yet was written against their drafts and was not run: pause-alerts.pg.test.ts, kill-switch.test.ts, the cti-api kill-switch test, and every server.ts and refresh/triage/outbox edit.
> - B8's railway.ts edit was typechecked. The .env.example test ran against the pre-A5 config. -->
>

`OUTREACH_KILL_SWITCH` (`on|off`, default `off`) is one switch that stops outreach from reaching anyone. Both services read the same variable:
- **outreach-api:** `promoteQueuedCalls` queues nothing, and the Salesforce write outbox holds its rows.
- **cti-api:** the Campaign calls picker lists nothing, and a start claims nothing.

Planning, refresh, triage and reconcile keep running, so the plan stays current and a run in progress still settles. The app shows a banner.

Automatic pauses (A8's `crm_broken`, A9's `ai_budget`) now alert exactly once per pause. `ai_budget` pauses end on their own: each `touch.plan` tick first resumes every `ai_budget`-paused campaign whose tenant is under its budget for the current UTC day. In practice that happens at 00:00 UTC, or earlier when an admin raises the budget. Each campaign goes back to its `paused_from` (a dry-run campaign is never made live), and `paused_from` and `pause_reason` are cleared. `crm_broken` pauses never resume on their own.

The task has five parts, each with its own commit:
1. kill switch, outreach-api
2. kill switch, cti-api
3. pause alerts and the AI-budget resume
4. `GET /status`
5. the banner

**Files:**
- outreach-api (`services/outreach-api/`):
  - Modify `src/config.ts` (one key at the end of `schema`) and `src/config.test.ts` (append).
  - Modify A10's `src/planner/run.ts`: `PlanDeps`, `promoteQueuedCalls` and `planTick`.
  - Modify B2's `src/crm/outbox.ts`: `DrainDeps` and `drainOutbox`.
  - Create `src/kill-switch.test.ts` and `src/kill-switch.pg.test.ts`.
  - Modify `src/alerts.ts`: one `kind` member, plus `OrgAlert` and `campaignsPausedAlert` appended, in the shape B2's `sfWriteAlert` uses. Create `src/alerts.test.ts`.
  - Replace A8's `src/campaigns/pause.ts`, keeping all its exports. Create `src/campaigns/pause.test.ts`, `src/campaigns/pause.pg.test.ts` and `src/campaigns/pause-alerts.pg.test.ts`.
  - Modify A8's `src/campaigns/refresh.ts`: `RefreshDeps`, `pauseForBrokenCrm` and its two call sites.
  - Modify A9's `src/triage/run.ts`: `TriageDeps` and `pauseForBudget`.
  - Create `src/routes/status.ts` and `src/routes/status.test.ts`.
  - Modify `src/server.ts`: imports, the start of `main()`, the `campaign.refresh`, `record.triage`, `touch.plan` and `sf.write` handlers, and `apiRoutes`.
- contracts:
  - Create `packages/contracts/src/status.ts` and `packages/contracts/src/status.test.ts`.
  - Modify `packages/contracts/src/index.ts`: one export line.
- cti-api (`services/cti-api/`):
  - Modify `src/config.ts`: insert after line 183, `DIALER_TIME_TASKS`.
  - Modify `src/config.test.ts`: append after line 103, the end of the file.
  - Modify B4's `src/dialer/campaign-calls.ts`: `dueCampaignCalls`, `StartCampaignCallsDeps` and `startCampaignCalls`.
  - Modify B4's two routes in `src/routes/dialer.ts`.
  - Create `src/dialer/campaign-calls.kill-switch.test.ts`.
- outreach-web (`apps/outreach-web/`):
  - Modify `src/lib/outreach-api.ts` (A12): the contracts import, `outreachKeys` and one new function.
  - Modify `src/lib/outreach-words.ts` (A12): the `ai_budget` row and one new constant.
  - Modify `src/lib/outreach-words.test.ts` and `src/components/campaign-detail.test.tsx` (A12/A13): the `ai_budget` row in each.
  - Modify `src/components/app-shell.tsx`: one import and `<main>`.
  - Create `src/components/kill-switch-banner.tsx` and `src/components/kill-switch-banner.test.tsx`.

No migration: `campaigns.paused_from` comes from A3/A8 (A8 plan outline correction 1).

**Interfaces:**
- **Consumes:**
  - A3: `schema.campaigns` (`status`, `pauseReason`, `pausedFrom: 'dry_run' | 'active' | null`, `updatedAt`), `schema.organizations.settings`, `schema.aiUsageDays`, `schema.touches`, `schema.crmRecords`, `schema.campaignEnrollments`.
  - A8:
    - `pause.ts`: `AutoPauseReason`, `RUNNING_CAMPAIGN_STATUSES`, and `pauseOrgCampaigns(db, orgId, reason): Promise<number>`, which sets `paused_from = status`.
    - `refresh.ts`: `type RefreshDeps`, `pauseForBrokenCrm(db, log, orgId, err)`, `refreshDueCampaigns(deps: RefreshDeps)`.
    - `RunnerLogger`, plus the `handlers` object in `server.ts`.
  - A9:
    - `TriageDeps`, `pauseForBudget(deps, orgId, spent, budget)`, `triageDueRecords(deps)`.
    - `spentTodayMicros(db, orgId, now)` and `budgetMicros(settings)` from `src/ai/budget.ts`.
    - `TriageModel` from `src/ai/model.ts`.
  - A10: `outreachSettings(org)`, `PlanDeps`, `promoteQueuedCalls(db, now)`, and `planTick(deps)` (plan, then promote).
  - A5:
    - `CrmNotConnectedError` and `SalesforceClientFactory` from `src/crm/client-factory.ts`.
    - `cfg.salesforceEnabled`.
  - B2:
    - `DrainDeps`, `drainOutbox(deps): Promise<{ done; failed }>`, `outboxJob(deps)`.
    - `sfWriteAlert` (B2 already alerts `sf_write_failing` once per row after 24 h).
  - B4: `dueCampaignCalls(db, orgId, now)`, `StartCampaignCallsDeps { db; now; build }`, `startCampaignCalls(deps, args)` returning `{ kind: 'started' | 'nothing_due' | 'build_failed' }`, and the two routes.
  - Shared: `requireContext` from `src/tenancy/scope.ts`; `buildApp`, `fakeDb` and `testConfig` from the test harness.
  - outreach-web (A12): `api(path, schema)`, `outreachKeys`, `PAUSE_REASON_WORDS`, `pauseReasonWords`, `renderWithProviders`, `stubApi` and `respond`.
- **Produces:**
  - outreach-api `AppConfig.OUTREACH_KILL_SWITCH: 'on' | 'off'`, and the same key on cti-api's `AppConfig`.
  - Kill-switch parameters:
    - `promoteQueuedCalls(db, now, opts?: { killSwitch?: boolean })`
    - `PlanDeps.killSwitch?: boolean`
    - `DrainDeps.killSwitch?: boolean`
    - `dueCampaignCalls(db, orgId, now, opts?: { killSwitch?: boolean })`
    - `StartCampaignCallsDeps.killSwitch?: boolean`
  - `alerts.ts`:
    - the kind `'campaigns_paused'`
    - `type OrgAlert = (orgId: string, message: string) => Promise<void>`, the shape of B2's `sfWriteAlert` and of `DrainDeps.alert`
    - `campaignsPausedAlert(logger): OrgAlert`
  - `pause.ts`:
    - `pauseAlertText(reason, paused: ReadonlyArray<{ id; name }>): string`
    - `pauseOrgCampaigns(db, orgId, reason, alert?: OrgAlert): Promise<number>`
    - `resumeBudgetPausedCampaigns(deps: { db; now; log }): Promise<number>`
  - `RefreshDeps.alert?: OrgAlert` and `TriageDeps.alert?: OrgAlert`.
  - Contracts: `OutreachStatus = z.object({ killSwitch: z.boolean() })`.
  - `registerStatusRoutes(app, { db, cfg })` serves `GET /api/status` → `OutreachStatus`. It requires a session.
  - outreach-web:
    - `getStatus()` and `outreachKeys.status`
    - `KILL_SWITCH_WORDS`
    - `KillSwitchBanner`, rendered by `AppShell` above every signed-in page

#### Part 1: the kill switch in outreach-api

- [ ] **Step 1: Write the failing tests**

Append to `services/outreach-api/src/config.test.ts`:
```ts

describe('OUTREACH_KILL_SWITCH', () => {
  it('defaults to off, and an empty value (a deploy UI\'s placeholder) is off too', () => {
    expect(parseConfig(base).OUTREACH_KILL_SWITCH).toBe('off');
    expect(parseConfig({ ...base, OUTREACH_KILL_SWITCH: '' }).OUTREACH_KILL_SWITCH).toBe('off');
  });
  it('on turns it on', () => {
    expect(parseConfig({ ...base, OUTREACH_KILL_SWITCH: 'on' }).OUTREACH_KILL_SWITCH).toBe('on');
  });
  it('anything else fails the boot rather than guessing what "true" or "1" meant', () => {
    expect(() => parseConfig({ ...base, OUTREACH_KILL_SWITCH: 'true' })).toThrow(/OUTREACH_KILL_SWITCH/);
  });
});
```

Create `services/outreach-api/src/kill-switch.test.ts`:
```ts
/**
 * OUTREACH_KILL_SWITCH (plan 1B task B7) in outreach-api, without a database:
 * with the switch on, promotion and the Salesforce outbox return before they
 * touch the database or build a Salesforce client. The database half is in
 * kill-switch.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import type { SalesforceClientFactory } from './crm/client-factory.js';
import { drainOutbox } from './crm/outbox.js';
import { promoteQueuedCalls } from './planner/run.js';

const untouchable = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`the kill switch must not touch the database (read db.${String(prop)})`);
  },
}) as unknown as Db;
const NOW = new Date('2026-10-05T18:00:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('OUTREACH_KILL_SWITCH=on', () => {
  it('promoteQueuedCalls queues no campaign call', async () => {
    await expect(promoteQueuedCalls(untouchable, NOW, { killSwitch: true })).resolves.toBe(0);
  });

  it('drainOutbox sends nothing: no outbox read, no Salesforce client, no alert', async () => {
    const clients = vi.fn<SalesforceClientFactory>(async () => { throw new Error('no client while switched off'); });
    const alert = vi.fn(async () => {});
    await expect(drainOutbox({ db: untouchable, clients, now: NOW, log, alert, killSwitch: true })).resolves.toEqual({ done: 0, failed: 0 });
    expect(clients).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });
});
```

Create `services/outreach-api/src/kill-switch.pg.test.ts`. The enrollment's `next_touch_at` is a day ahead, so the planner leaves it alone and only promotion acts on its touch:
```ts
/**
 * OUTREACH_KILL_SWITCH against real Postgres (plan 1B task B7): a planned
 * campaign call that is due stays `planned` while the switch is on — through
 * the `touch.plan` tick and through promoteQueuedCalls itself — and is queued
 * for the dialer on the first tick after it is turned off. Skipped unless
 * TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import { planTick, promoteQueuedCalls } from './planner/run.js';
import { createTestDb, pgLane, type TestDb } from './test/pg.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const DAY_MS = 86_400_000;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe.skipIf(!pgLane)('kill switch and campaign call promotion (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  it('queues nothing while on, and the same touch once off', async () => {
    const slug = `kill-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Kill ${slug}`, slug }).returning();
    const orgId = org!.id;
    const [campaign] = await t.db.insert(schema.campaigns)
      .values({ orgId, name: 'Spring sellers', sfObject: 'Lead', sourceKind: 'soql', soql: 'SELECT Id FROM Lead', status: 'active' }).returning();
    const [record] = await t.db.insert(schema.crmRecords).values({ orgId, sfObject: 'Lead', sfRecordId: `00Q0000${randomBytes(4).toString('hex')}AAA` }).returning();
    const [enrollment] = await t.db.insert(schema.campaignEnrollments)
      .values({ orgId, campaignId: campaign!.id, crmRecordId: record!.id, nextTouchAt: new Date(NOW.getTime() + DAY_MS) }).returning();
    const [touch] = await t.db.insert(schema.touches)
      .values({ orgId, enrollmentId: enrollment!.id, seq: 1, channel: 'rep_call', status: 'planned', dueAt: new Date(NOW.getTime() - 60_000) }).returning();
    const statusOf = async () => (await t.db.select({ status: schema.touches.status }).from(schema.touches).where(eq(schema.touches.id, touch!.id)))[0]?.status;

    expect((await planTick({ db: t.db, now: NOW, log, killSwitch: true })).promoted).toBe(0);
    expect(await statusOf()).toBe('planned');
    expect(await promoteQueuedCalls(t.db, NOW, { killSwitch: true })).toBe(0);
    expect(await statusOf()).toBe('planned');

    expect((await planTick({ db: t.db, now: NOW, log })).promoted).toBeGreaterThanOrEqual(1);
    expect(await statusOf()).toBe('queued');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/config.test.ts src/kill-switch.test.ts 2>&1 | tail -15
```
Expected failures:
- In `config.test.ts`, 3 tests fail: `expected undefined to be 'off'`, `expected undefined to be 'on'`, and `expected [Function] to throw an error`.
- In `kill-switch.test.ts`, both tests fail. The switch is not there yet, so each function reads the proxy and rejects with `the kill switch must not touch the database (read db.execute)` (for the outbox, the read named is whatever B2's store touches first).
- `npm -w services/outreach-api run typecheck` reports `'killSwitch' does not exist in type` errors for the new arguments.

- [ ] **Step 3: Implement**

In `services/outreach-api/src/config.ts`, add this as the last key of the `schema` object:
```ts
  /**
   * Global kill switch for outreach sends (spec §12). `on` = no campaign call is
   * promoted to the dialer's queue, cti-api claims none (it reads the same
   * variable), and the Salesforce write outbox holds its rows; the app shows a
   * banner. Planning, triage, refresh, and reconcile keep running. Default
   * `off`. A strict enum like cti-api's switches: `true` / `1` fail the boot
   * instead of being read as "off".
   */
  OUTREACH_KILL_SWITCH: z.enum(['on', 'off']).default('off'),
```

In A10's `services/outreach-api/src/planner/run.ts`, add this as the last member of `export interface PlanDeps`:
```ts
  /** OUTREACH_KILL_SWITCH is on: plan as usual, but queue nothing for the dialer. */
  killSwitch?: boolean;
```
Replace the first two lines of `promoteQueuedCalls`:
```ts
/** In ACTIVE campaigns, due `planned` rep calls join the call queue. Dry-run touches stay `planned`. */
export async function promoteQueuedCalls(db: Db, now: Date): Promise<number> {
```
with:
```ts
/**
 * In ACTIVE campaigns, due `planned` rep calls join the call queue. Dry-run touches stay `planned`.
 * With OUTREACH_KILL_SWITCH on, nothing is queued: due touches stay `planned` and are queued
 * on the first tick after the switch is turned off.
 */
export async function promoteQueuedCalls(db: Db, now: Date, opts: { killSwitch?: boolean } = {}): Promise<number> {
  if (opts.killSwitch) return 0;
```
In `planTick`, change:
```ts
  const promoted = await promoteQueuedCalls(deps.db, deps.now);
```
to:
```ts
  const promoted = await promoteQueuedCalls(deps.db, deps.now, { killSwitch: deps.killSwitch });
```
The gate lives in `promoteQueuedCalls`, the function the plan names. `planTick` only passes it through, so planning keeps running while the switch is on.

In B2's `services/outreach-api/src/crm/outbox.ts`, add this as the last member of `export interface DrainDeps`:
```ts
  /** OUTREACH_KILL_SWITCH is on: hold every row (nothing is lost; they send after it is turned off). */
  killSwitch?: boolean;
```
Make this the first statement of `drainOutbox`:
```ts
  if (deps.killSwitch) return { done: 0, failed: 0 };
```
`outboxJob(deps: Omit<DrainDeps, 'now'>)` passes `killSwitch` through unchanged.

In `services/outreach-api/src/server.ts`, insert directly after `const db = getDb();` in `main()`:
```ts
  // OUTREACH_KILL_SWITCH (plan 1B B7): no campaign call reaches the dialer's queue and no
  // Salesforce write is sent. cti-api reads the same variable for its half.
  const killSwitch = cfg.OUTREACH_KILL_SWITCH === 'on';
  if (killSwitch) console.warn('[outreach] OUTREACH_KILL_SWITCH is on: campaign calls are not queued and Salesforce writes are held');
```
In the `'touch.plan'` handler, change `await planTick({ db, now: new Date(), log: console });` to:
```ts
        await planTick({ db, now: new Date(), log: console, killSwitch });
```
In the `'sf.write'` handler, add `killSwitch` to the object B2 passes to `outboxJob`. With B2's entry as drafted, it becomes:
```ts
    'sf.write': outboxJob({ db, clients, log: console, alert: sfWriteAlert(console), killSwitch }),
```

- [ ] **Step 4: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test -- src/config.test.ts src/kill-switch.test.ts 2>&1 | tail -5
```
Expected: the typecheck is clean and there are no failures. `kill-switch.test.ts` passes 2 tests.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "kill-switch|planner/run|Test Files|Tests "
```
Expected: `✓ src/kill-switch.pg.test.ts (1 test)`. A10's `planner/run.test.ts` still passes, because `promoteQueuedCalls(db, now)` without `opts` behaves exactly as before.

- [ ] **Step 5: Commit**
```bash
git add services/outreach-api/src/config.ts services/outreach-api/src/config.test.ts services/outreach-api/src/planner/run.ts services/outreach-api/src/crm/outbox.ts services/outreach-api/src/kill-switch.test.ts services/outreach-api/src/kill-switch.pg.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): OUTREACH_KILL_SWITCH holds campaign calls and Salesforce writes"
```

#### Part 2: the kill switch in cti-api

cti-api is live and edited by another session. Keep this diff to the lines below.

- [ ] **Step 6: Write the failing tests**

Append to `services/cti-api/src/config.test.ts`, after line 103:
```ts

describe('OUTREACH_KILL_SWITCH — outreach campaign calls (plan 1B)', () => {
  const saved = { ...process.env };
  beforeEach(() => { delete process.env.OUTREACH_KILL_SWITCH; });
  afterEach(() => { process.env = { ...saved }; });

  it('defaults to OFF', async () => {
    expect((await loadWith({ OUTREACH_KILL_SWITCH: undefined })).OUTREACH_KILL_SWITCH).toBe('off');
  });
  it('an empty value is treated as unset → off', async () => {
    expect((await loadWith({ OUTREACH_KILL_SWITCH: '' })).OUTREACH_KILL_SWITCH).toBe('off');
  });
  it('on turns it on', async () => {
    expect((await loadWith({ OUTREACH_KILL_SWITCH: 'on' })).OUTREACH_KILL_SWITCH).toBe('on');
  });
  it('anything else fails the boot loudly', async () => {
    await expect(loadWith({ OUTREACH_KILL_SWITCH: 'true' })).rejects.toThrow(/OUTREACH_KILL_SWITCH/);
  });
});
```

Create `services/cti-api/src/dialer/campaign-calls.kill-switch.test.ts`:
```ts
/**
 * OUTREACH_KILL_SWITCH in cti-api (outreach plan 1B task B7): with the switch
 * on, the Campaign calls picker lists nothing and a start claims nothing —
 * neither reads the database or builds a run. With it off (B4's own tests),
 * both behave as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { dueCampaignCalls, startCampaignCalls } from './campaign-calls.js';

type Executor = Parameters<typeof dueCampaignCalls>[0];
const untouchable = new Proxy({}, {
  get(_target, prop) {
    throw new Error(`the kill switch must not touch the database (read db.${String(prop)})`);
  },
}) as unknown as Executor;
const NOW = new Date('2026-10-05T18:00:00Z');
const CAMPAIGN_ID = '11111111-1111-4111-8111-111111111111';

describe('OUTREACH_KILL_SWITCH=on', () => {
  it('dueCampaignCalls lists no campaign', async () => {
    await expect(dueCampaignCalls(untouchable, 'O1', NOW, { killSwitch: true })).resolves.toEqual({ campaigns: [] });
  });

  it('startCampaignCalls claims nothing and builds no run', async () => {
    const build = vi.fn(async () => ({ sessionId: 'S1', total: 1 }));
    await expect(startCampaignCalls({ db: untouchable, now: NOW, build, killSwitch: true }, { orgId: 'O1', campaignId: CAMPAIGN_ID }))
      .resolves.toEqual({ kind: 'nothing_due' });
    expect(build).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run test -- src/config.test.ts src/dialer/campaign-calls.kill-switch.test.ts 2>&1 | tail -12
```
Expected failures:
- In `config.test.ts`, 3 of the new tests fail: `expected undefined to be 'off'` twice, and `expected undefined to be 'on'`. The fourth test fails because the promise resolved instead of rejecting.
- In the kill-switch file, both tests reject with `the kill switch must not touch the database (read db.execute)`.

- [ ] **Step 8: Implement**

In `services/cti-api/src/config.ts`, after line 183 (`  DIALER_TIME_TASKS: z.enum(['on', 'off']).default('on'),`), insert:
```ts

  /**
   * Outreach's global kill switch (outreach plan 1B, spec §12) — the SAME
   * variable outreach-api reads. `on` = GET /dialer/campaigns lists nothing and
   * POST /dialer/sessions/from-campaign claims nothing (404), so no campaign
   * touch reaches a power-dial run. The rep's own list-view runs are
   * untouched. Default `off`; strict enum like NO_ANSWER_CHATTER.
   */
  OUTREACH_KILL_SWITCH: z.enum(['on', 'off']).default('off'),
```

In B4's `services/cti-api/src/dialer/campaign-calls.ts`, give `dueCampaignCalls` a fourth parameter and an early return. Its body otherwise stays as B4 wrote it:
```ts
export async function dueCampaignCalls(
  db: SqlExecutor,
  orgId: string,
  now: Date,
  opts: { killSwitch?: boolean } = {},
): Promise<CampaignCallsResponse> {
  // OUTREACH_KILL_SWITCH: the Campaign calls picker lists nothing.
  if (opts.killSwitch) return { campaigns: [] };
  return { campaigns: await dueCampaignCallRows(db, orgId, now) };
}
```
Add this as the last member of `export interface StartCampaignCallsDeps`:
```ts
  /** OUTREACH_KILL_SWITCH is on: claim nothing (the route answers 404, as for "nothing due"). */
  killSwitch?: boolean;
```
Make this the first statement of `startCampaignCalls`, before `claimCampaignTouches`:
```ts
  if (deps.killSwitch) return { kind: 'nothing_due' };
```

In `services/cti-api/src/routes/dialer.ts`, `registerDialerRoutes` already has `const cfg = loadConfig();` (line 297). In B4's `GET /dialer/campaigns` handler, change:
```ts
    return dueCampaignCalls(getDb(), authed.orgId, new Date());
```
to:
```ts
    return dueCampaignCalls(getDb(), authed.orgId, new Date(), { killSwitch: cfg.OUTREACH_KILL_SWITCH === 'on' });
```
In B4's `POST /dialer/sessions/from-campaign` handler, add this line to the deps object passed to `startCampaignCalls`, right after its `now:` line:
```ts
        killSwitch: cfg.OUTREACH_KILL_SWITCH === 'on',
```

- [ ] **Step 9: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/cti-api run typecheck && npm -w services/cti-api run test 2>&1 | tail -5
```
Expected: the typecheck is clean, and the whole cti-api suite passes. That includes the 4 new config tests, the 2 kill-switch tests, and B4's route tests, which run with the switch off by default.

- [ ] **Step 10: Commit**
```bash
git add services/cti-api/src/config.ts services/cti-api/src/config.test.ts services/cti-api/src/dialer/campaign-calls.ts services/cti-api/src/dialer/campaign-calls.kill-switch.test.ts services/cti-api/src/routes/dialer.ts
git commit -m "feat(cti-api): OUTREACH_KILL_SWITCH hides and refuses campaign calls"
```

#### Part 3: one alert per automatic pause, and the AI-budget resume

- [ ] **Step 11: Write the failing tests**

Create `services/outreach-api/src/alerts.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { campaignsPausedAlert } from './alerts.js';

describe('campaignsPausedAlert', () => {
  it('logs a campaigns_paused warning for the tenant and never throws', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(campaignsPausedAlert(logger)('O1', 'Paused 1 campaign')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith({ alert: 'campaigns_paused', orgId: 'O1' }, 'alert: Paused 1 campaign');
  });
});
```

Create `services/outreach-api/src/campaigns/pause.test.ts`:
```ts
/** The one alert line an automatic pause sends (plan 1B task B7) — pure. */
import { describe, expect, it } from 'vitest';
import { pauseAlertText } from './pause.js';

describe('pauseAlertText', () => {
  it('a broken Salesforce connection asks for action, names the campaigns, and says how to recover', () => {
    expect(pauseAlertText('crm_broken', [{ id: 'C1', name: 'Spring sellers' }, { id: 'C2', name: 'Probate' }])).toBe(
      'Action needed: paused 2 campaigns (Spring sellers, Probate) because the Salesforce connection is broken. Reconnect it in Settings → Connections, then resume each campaign.',
    );
  });

  it('a spent AI budget says when the campaigns resume', () => {
    expect(pauseAlertText('ai_budget', [{ id: 'C1', name: 'Spring sellers' }])).toBe(
      "Paused 1 campaign (Spring sellers) because today's AI budget is used up. Paused campaigns resume on their own at 00:00 UTC.",
    );
  });
});
```

Create `services/outreach-api/src/campaigns/pause.pg.test.ts`. The tests share one database, so they assert on each tenant's own rows, not on global counts:
```ts
/**
 * Automatic pauses against real Postgres (plan 1B task B7): one alert per
 * pause, `paused_from` kept, and the AI-budget resume — next UTC day yes,
 * Salesforce-broken pauses never. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { schema } from '@cti/db';
import type { OrgAlert } from '../alerts.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { pauseOrgCampaigns, resumeBudgetPausedCampaigns } from './pause.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const PAUSE_DAY = new Date('2026-10-05T22:30:00Z');
const SAME_DAY = new Date('2026-10-05T23:59:00Z');
const NEXT_DAY = new Date('2026-10-06T00:01:00Z');

describe.skipIf(!pgLane)('automatic campaign pauses (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  async function tenant(statuses: Array<'draft' | 'dry_run' | 'active'>) {
    const slug = `pause-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Pause ${slug}`, slug }).returning();
    const rows = await t.db
      .insert(schema.campaigns)
      .values(statuses.map((status, i) => ({ orgId: org!.id, name: `C${i} ${status}`, sfObject: 'Lead' as const, sourceKind: 'soql' as const, soql: 'SELECT Id FROM Lead', status })))
      .returning();
    return { orgId: org!.id, ids: rows.map((r) => r.id) };
  }
  const campaignsOf = (ids: string[]) =>
    t.db.select({ id: schema.campaigns.id, status: schema.campaigns.status, pauseReason: schema.campaigns.pauseReason, pausedFrom: schema.campaigns.pausedFrom })
      .from(schema.campaigns).where(inArray(schema.campaigns.id, ids));

  it.each(['crm_broken', 'ai_budget'] as const)('a %s pause alerts exactly once, however many ticks hit it', async (reason) => {
    const { orgId, ids } = await tenant(['dry_run', 'active', 'draft']);
    const alert = vi.fn<OrgAlert>(async () => {});
    expect(await pauseOrgCampaigns(t.db, orgId, reason, alert)).toBe(2);
    expect(await pauseOrgCampaigns(t.db, orgId, reason, alert)).toBe(0);
    expect(alert).toHaveBeenCalledTimes(1);
    const [alertedOrg, text] = alert.mock.calls[0]!;
    expect(alertedOrg).toBe(orgId);
    expect(text).toContain(reason === 'crm_broken' ? 'the Salesforce connection is broken' : "today's AI budget is used up");
    expect(text).toContain('C0 dry_run');
    expect(text).toContain('C1 active');
    expect(text).not.toContain('C2 draft');
    const rows = new Map((await campaignsOf(ids)).map((r) => [r.id, r]));
    expect(rows.get(ids[0]!)).toMatchObject({ status: 'paused', pauseReason: reason, pausedFrom: 'dry_run' });
    expect(rows.get(ids[1]!)).toMatchObject({ status: 'paused', pauseReason: reason, pausedFrom: 'active' });
    expect(rows.get(ids[2]!)).toMatchObject({ status: 'draft', pauseReason: null });
  });

  it('pauses without alerting when no alerter is passed (1A callers)', async () => {
    const { orgId } = await tenant(['active']);
    expect(await pauseOrgCampaigns(t.db, orgId, 'crm_broken')).toBe(1);
  });

  it('ai_budget campaigns resume to their own state at the next UTC day; crm_broken ones do not', async () => {
    const budget = await tenant(['dry_run', 'active']);
    const broken = await tenant(['active']);
    await pauseOrgCampaigns(t.db, budget.orgId, 'ai_budget');
    await pauseOrgCampaigns(t.db, broken.orgId, 'crm_broken');
    // Today's spend is over the $25 default.
    await t.db.insert(schema.aiUsageDays).values({ orgId: budget.orgId, day: '2026-10-05', costMicros: 26_000_000 });

    // Other tests in this file share the database: assert on this tenant's rows, not on the returned count.
    await resumeBudgetPausedCampaigns({ db: t.db, now: SAME_DAY, log });
    expect((await campaignsOf(budget.ids)).every((c) => c.status === 'paused')).toBe(true);

    expect(await resumeBudgetPausedCampaigns({ db: t.db, now: NEXT_DAY, log })).toBeGreaterThanOrEqual(2);
    const resumed = new Map((await campaignsOf(budget.ids)).map((r) => [r.id, r]));
    expect(resumed.get(budget.ids[0]!)).toMatchObject({ status: 'dry_run', pauseReason: null, pausedFrom: null });
    expect(resumed.get(budget.ids[1]!)).toMatchObject({ status: 'active', pauseReason: null, pausedFrom: null });
    expect(await campaignsOf(broken.ids)).toEqual([expect.objectContaining({ status: 'paused', pauseReason: 'crm_broken' })]);
  });

  it('a raised budget resumes the same day; a manual pause never auto-resumes', async () => {
    const { orgId, ids } = await tenant(['active']);
    await pauseOrgCampaigns(t.db, orgId, 'ai_budget');
    await t.db.insert(schema.aiUsageDays).values({ orgId, day: '2026-10-05', costMicros: 26_000_000 });
    await t.db.update(schema.organizations).set({ settings: { aiDailyBudgetUsd: 50 } }).where(eq(schema.organizations.id, orgId));
    const manual = await tenant(['active']);
    await t.db.update(schema.campaigns).set({ status: 'paused', pauseReason: 'manual' }).where(eq(schema.campaigns.orgId, manual.orgId));

    await resumeBudgetPausedCampaigns({ db: t.db, now: PAUSE_DAY, log });
    expect(await campaignsOf(ids)).toEqual([expect.objectContaining({ status: 'active', pauseReason: null })]);
    expect(await campaignsOf(manual.ids)).toEqual([expect.objectContaining({ status: 'paused', pauseReason: 'manual' })]);
  });
});
```

Create `services/outreach-api/src/campaigns/pause-alerts.pg.test.ts`. It pins the call sites: each tick that pauses campaigns passes its alerter through, and a second tick stays quiet:
```ts
/**
 * The two ticks that pause campaigns alert exactly once per pause (plan 1B
 * task B7): campaign.refresh on an unusable Salesforce connection, and
 * record.triage on a spent AI budget. Each tick runs twice; the second finds
 * nothing running and stays quiet. Skipped unless TEST_DATABASE_URL is set.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';
import { schema } from '@cti/db';
import type { TriageModel } from '../ai/model.js';
import type { OrgAlert } from '../alerts.js';
import { CrmNotConnectedError, type SalesforceClientFactory } from '../crm/client-factory.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';
import { triageDueRecords } from '../triage/run.js';
import { refreshDueCampaigns } from './refresh.js';

const NOW = new Date('2026-10-05T18:00:00Z');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const notConnected: SalesforceClientFactory = async () => { throw new CrmNotConnectedError(); };
const unusedModel: TriageModel = { triage: async () => { throw new Error('the budget check runs before the model'); } };

describe.skipIf(!pgLane)('automatic pause alerts from the ticks (real Postgres)', () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 120_000);
  afterAll(async () => { await t?.drop(); });

  /** A tenant with a dry-run and a live campaign, and one record waiting for triage in the live one. */
  async function tenant(): Promise<string> {
    const slug = `alerts-${randomBytes(3).toString('hex')}`;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Alerts ${slug}`, slug }).returning();
    const orgId = org!.id;
    const [, live] = await t.db
      .insert(schema.campaigns)
      .values((['dry_run', 'active'] as const).map((status) => ({ orgId, name: `Spring ${status}`, sfObject: 'Lead' as const, sourceKind: 'soql' as const, soql: 'SELECT Id FROM Lead', status })))
      .returning();
    const [record] = await t.db.insert(schema.crmRecords).values({ orgId, sfObject: 'Lead', sfRecordId: `00Q0000${randomBytes(4).toString('hex')}AAA` }).returning();
    await t.db.insert(schema.campaignEnrollments).values({ orgId, campaignId: live!.id, crmRecordId: record!.id });
    return orgId;
  }

  /** The alert lines sent for one tenant (other tests' tenants share the database). */
  const sentTo = (alert: Mock<OrgAlert>, orgId: string): string[] =>
    alert.mock.calls.filter(([alertedOrg]) => alertedOrg === orgId).map(([, text]) => text);

  it('campaign.refresh: an unusable Salesforce connection pauses the tenant once and alerts once', async () => {
    const orgId = await tenant();
    const alert = vi.fn<OrgAlert>(async () => {});
    for (let tick = 0; tick < 2; tick += 1) await refreshDueCampaigns({ db: t.db, clients: notConnected, now: NOW, log, alert });
    const lines = sentTo(alert, orgId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Action needed: paused 2 campaigns \(.*\) because the Salesforce connection is broken\./);
  });

  it('record.triage: a spent AI budget pauses the tenant once and alerts once', async () => {
    const orgId = await tenant();
    await t.db.insert(schema.aiUsageDays).values({ orgId, day: '2026-10-05', costMicros: 30_000_000 });
    const alert = vi.fn<OrgAlert>(async () => {});
    for (let tick = 0; tick < 2; tick += 1) {
      await triageDueRecords({ db: t.db, clients: notConnected, model: unusedModel, now: NOW, log, alert });
    }
    const lines = sentTo(alert, orgId);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Paused 2 campaigns \(.*\) because today's AI budget is used up\./);
  });
});
```

- [ ] **Step 12: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/alerts.test.ts src/campaigns/pause.test.ts 2>&1 | tail -12
```
Expected failures:
- `alerts.test.ts`: `TypeError: … campaignsPausedAlert is not a function`.
- `pause.test.ts`: `TypeError: … pauseAlertText is not a function`.
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "pause|Test Files|Tests "
```
Expected failures:
- `pause.pg.test.ts`: the two `alerts exactly once` cases fail with `expected "spy" to be called 1 times, but got 0 times`. The resume cases fail with `TypeError: … resumeBudgetPausedCampaigns is not a function`.
- `pause-alerts.pg.test.ts`: both cases fail with `expected [] to have a length of 1 but got +0`.

- [ ] **Step 13: Implement**

In `services/outreach-api/src/alerts.ts`, add this as the last member of `AlertEvent['kind']`, after B2's `| 'sf_write_failing'`:
```ts
    /** A tenant's running campaigns were paused automatically (crm_broken, ai_budget). One alert per pause. */
    | 'campaigns_paused';
```
Move the `;` that ended B2's `| 'sf_write_failing';` line so it ends the new last member instead. Then append to the end of the file:
```ts

/**
 * What a tick takes to alert about one tenant: the shape of `DrainDeps.alert`
 * and of `sfWriteAlert`'s result (B2). Must not throw — dispatchAlert never does.
 */
export type OrgAlert = (orgId: string, message: string) => Promise<void>;

/**
 * Automatic campaign pauses (src/campaigns/pause.ts), as a warning through the
 * same log + webhook path as every other alert. A broken Salesforce connection
 * says "Action needed:" in the message itself.
 */
export function campaignsPausedAlert(logger: AlertLogger): OrgAlert {
  return (orgId, message) => dispatchAlert(logger, { kind: 'campaigns_paused', severity: 'warning', orgId, message });
}
```

Replace all of `services/outreach-api/src/campaigns/pause.ts`. A8's exports stay, with the same names and behavior. `pauseOrgCampaigns` gains an optional fourth parameter, so A8's and A9's existing calls still compile:
```ts
/**
 * Automatic campaign pauses (spec §6.4, §12). The system pauses every running
 * (`dry_run` or `active`) campaign of a tenant when its Salesforce connection
 * breaks (`crm_broken`, A8) or its daily AI budget is spent (`ai_budget`, A9).
 * `paused_from` remembers which state each campaign was in, so a resume puts a
 * dry-run campaign back in dry run instead of making it live.
 *
 * Plan 1B task B7 adds:
 *  - one alert per pause: the UPDATE returns only campaigns that were running,
 *    so a tenant whose campaigns are already paused alerts nothing, however
 *    many ticks hit the same failure;
 *  - the `ai_budget` resume, run on every `touch.plan` tick: a tenant's
 *    budget-paused campaigns go back to `paused_from` once the tenant's spend
 *    for the current UTC day is under its budget — at 00:00 UTC, when the day's
 *    spend starts from zero, or earlier if an admin raises the budget.
 *    `crm_broken` pauses never resume on their own: an admin reconnects
 *    Salesforce and resumes the campaigns.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { budgetMicros, spentTodayMicros } from '../ai/budget.js';
import type { OrgAlert } from '../alerts.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { outreachSettings } from '../settings.js';

export type AutoPauseReason = 'crm_broken' | 'ai_budget';
export const RUNNING_CAMPAIGN_STATUSES = ['dry_run', 'active'] as const;

const PAUSE_WORDS: Record<AutoPauseReason, { lead: string; why: string }> = {
  crm_broken: {
    lead: 'Action needed: paused',
    why: 'the Salesforce connection is broken. Reconnect it in Settings → Connections, then resume each campaign',
  },
  ai_budget: {
    lead: 'Paused',
    why: "today's AI budget is used up. Paused campaigns resume on their own at 00:00 UTC",
  },
};

/** Pure: the one alert line a pause sends. */
export function pauseAlertText(reason: AutoPauseReason, paused: ReadonlyArray<{ id: string; name: string }>): string {
  const { lead, why } = PAUSE_WORDS[reason];
  const noun = paused.length === 1 ? 'campaign' : 'campaigns';
  return `${lead} ${paused.length} ${noun} (${paused.map((p) => p.name).join(', ')}) because ${why}.`;
}

/** Returns the number of campaigns paused (0 when none was running); alerts once when it paused any. */
export async function pauseOrgCampaigns(db: Db, orgId: string, reason: AutoPauseReason, alert?: OrgAlert): Promise<number> {
  const rows = await db
    .update(schema.campaigns)
    // `status` on the right-hand side is the value before this UPDATE.
    .set({ status: 'paused', pauseReason: reason, pausedFrom: sql.raw('status'), updatedAt: sql`now()` })
    .where(and(eq(schema.campaigns.orgId, orgId), inArray(schema.campaigns.status, [...RUNNING_CAMPAIGN_STATUSES])))
    .returning({ id: schema.campaigns.id, name: schema.campaigns.name });
  if (rows.length > 0 && alert) await alert(orgId, pauseAlertText(reason, rows));
  return rows.length;
}

/** Resume every `ai_budget` pause whose tenant is under budget for the current UTC day. Returns how many resumed. */
export async function resumeBudgetPausedCampaigns(deps: { db: Db; now: Date; log: RunnerLogger }): Promise<number> {
  const { db, now, log } = deps;
  const orgs = await db
    .selectDistinct({ id: schema.organizations.id, settings: schema.organizations.settings })
    .from(schema.campaigns)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.campaigns.orgId))
    .where(and(eq(schema.campaigns.status, 'paused'), eq(schema.campaigns.pauseReason, 'ai_budget')));
  let resumed = 0;
  for (const org of orgs) {
    if ((await spentTodayMicros(db, org.id, now)) >= budgetMicros(outreachSettings(org))) continue;
    const rows = await db
      .update(schema.campaigns)
      // Back to the state it was paused from; a pause from before `paused_from` existed resumes to dry run, never live.
      .set({ status: sql`coalesce(${schema.campaigns.pausedFrom}, 'dry_run')`, pauseReason: null, pausedFrom: null, updatedAt: now })
      .where(and(eq(schema.campaigns.orgId, org.id), eq(schema.campaigns.status, 'paused'), eq(schema.campaigns.pauseReason, 'ai_budget')))
      .returning({ id: schema.campaigns.id });
    if (rows.length > 0) log.info({ orgId: org.id, campaignIds: rows.map((r) => r.id) }, 'resumed campaigns paused for the AI budget');
    resumed += rows.length;
  }
  return resumed;
}
```

In A8's `services/outreach-api/src/campaigns/refresh.ts`:
- Add `import type { OrgAlert } from '../alerts.js';` to the imports.
- Change `type RefreshDeps = { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger };` to:
```ts
type RefreshDeps = { db: Db; clients: SalesforceClientFactory; now: Date; log: RunnerLogger; alert?: OrgAlert };
```
- Replace `pauseForBrokenCrm` with:
```ts
async function pauseForBrokenCrm(db: Db, log: RunnerLogger, orgId: string, err: unknown, alert?: OrgAlert): Promise<void> {
  const paused = await pauseOrgCampaigns(db, orgId, 'crm_broken', alert);
  log.warn({ orgId, paused, err: errorMessage(err) }, 'salesforce connection unusable; paused the tenant campaigns');
}
```
- In `refreshOrg`, there are two lines that read `if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err);`. The first is in the client `catch`, the second in the per-campaign `catch`. Change both to the line below, keeping each line's indentation:
```ts
    if (isConnectionFailure(err)) return pauseForBrokenCrm(db, log, orgId, err, deps.alert);
```

In A9's `services/outreach-api/src/triage/run.ts`:
- Add `import type { OrgAlert } from '../alerts.js';` to the imports.
- Add this as the last member of `export interface TriageDeps`:
```ts
  /** Alerts once when this tick pauses the tenant's campaigns for the AI budget (plan 1B B7). */
  alert?: OrgAlert;
```
- In `pauseForBudget`, change `const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget');` to:
```ts
  const paused = await pauseOrgCampaigns(deps.db, orgId, 'ai_budget', deps.alert);
```

In `services/outreach-api/src/server.ts`:
- B2 imports `sfWriteAlert` from `./alerts.js`. Make that import `import { campaignsPausedAlert, sfWriteAlert } from './alerts.js';`.
- Add `import { resumeBudgetPausedCampaigns } from './campaigns/pause.js';` next to the other `./campaigns/…` imports.
- After the `killSwitch` lines from Step 3, insert:
```ts
  // Automatic-pause alerts (src/campaigns/pause.ts): log always, ALERT_WEBHOOK_URL when set.
  const pauseAlert = campaignsPausedAlert(console);
```
- In the `'campaign.refresh'` handler, change `await refreshDueCampaigns({ db, clients, now: new Date(), log: console });` to:
```ts
            await refreshDueCampaigns({ db, clients, now: new Date(), log: console, alert: pauseAlert });
```
- In the `'record.triage'` handler, change `await triageDueRecords({ db, clients, model: triageModel, now: new Date(), log: console });` to:
```ts
            await triageDueRecords({ db, clients, model: triageModel, now: new Date(), log: console, alert: pauseAlert });
```
- Replace the `'touch.plan'` entry with:
```ts
      // End AI-budget pauses whose tenant is under budget for today (UTC), then plan due
      // enrollments and queue due rep calls of ACTIVE campaigns (src/planner/run.ts).
      'touch.plan': async () => {
        const now = new Date();
        await resumeBudgetPausedCampaigns({ db, now, log: console });
        await planTick({ db, now, log: console, killSwitch });
      },
```
The resume runs on `touch.plan`, which is unconditional, not on `record.triage`, which runs only when Salesforce and AI are configured. That way a tenant whose AI key was removed still resumes.

- [ ] **Step 14: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test -- src/alerts.test.ts src/campaigns/pause.test.ts 2>&1 | tail -5
```
Expected: the typecheck is clean, and 3 tests pass (1 alerts and 2 pause).
```bash
cd "$(git rev-parse --show-toplevel)" && npm run test:pg 2>&1 | grep -E "pause|refresh|triage/run|Test Files|Tests "
```
Expected:
- `✓ src/campaigns/pause.pg.test.ts (5 tests)` and `✓ src/campaigns/pause-alerts.pg.test.ts (2 tests)`.
- A8's `refresh.test.ts` and A9's `triage/run.test.ts` still pass. They call without `alert`, and their `pausedFrom` expectations are unchanged.
- The `Test Files` line shows no failures.

- [ ] **Step 15: Commit**
```bash
git add services/outreach-api/src/alerts.ts services/outreach-api/src/alerts.test.ts services/outreach-api/src/campaigns/pause.ts services/outreach-api/src/campaigns/pause.test.ts services/outreach-api/src/campaigns/pause.pg.test.ts services/outreach-api/src/campaigns/pause-alerts.pg.test.ts services/outreach-api/src/campaigns/refresh.ts services/outreach-api/src/triage/run.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): alert once per automatic pause; resume AI-budget pauses at the next UTC day"
```

#### Part 4: `GET /api/status`

- [ ] **Step 16: Write the failing tests**

Create `packages/contracts/src/status.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { OutreachStatus } from './status.js';

describe('OutreachStatus', () => {
  it('carries the kill switch as a boolean, and nothing else passes', () => {
    expect(OutreachStatus.parse({ killSwitch: true })).toEqual({ killSwitch: true });
    expect(OutreachStatus.safeParse({}).success).toBe(false);
    expect(OutreachStatus.safeParse({ killSwitch: 'on' }).success).toBe(false);
  });
});
```

Create `services/outreach-api/src/routes/status.test.ts`. Its `vi.mock('@cti/auth')` spreads `importOriginal()`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerStatusRoutes } from './status.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const org = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: 'org_gg' };
const member = { userId: 'U2', orgId: 'O1', email: 'rep@gg.co', isAdmin: false, powerDialerEnabled: true, kind: 'human', isSuperAdmin: false };
const auth = { authorization: 'Bearer t' };
let app: FastifyInstance | undefined;

async function build(killSwitch: 'on' | 'off'): Promise<FastifyInstance> {
  const cfg = testConfig({ OUTREACH_KILL_SWITCH: killSwitch });
  const { db } = fakeDb({ organizations: [org] });
  app = await buildApp({ cfg, readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerStatusRoutes(scope, { db, cfg })] });
  return app;
}

afterEach(async () => { await app?.close(); app = undefined; });

describe('GET /api/status', () => {
  it.each([['on', true], ['off', false]] as const)('OUTREACH_KILL_SWITCH=%s → killSwitch %s, for any member', async (value, expected) => {
    state.session = member;
    const res = await (await build(value)).inject({ method: 'GET', url: '/api/status', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ killSwitch: expected });
  });

  it('requires a session', async () => {
    state.session = null;
    const res = await (await build('on')).inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 17: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w packages/contracts run test -- src/status.test.ts 2>&1 | tail -6; npm -w services/outreach-api run test -- src/routes/status.test.ts 2>&1 | tail -6
```
Expected: both fail to load, with `Failed to load url ./status.js` (contracts) and `Failed to load url ./status.js` (routes).

- [ ] **Step 18: Implement**

Create `packages/contracts/src/status.ts`:
```ts
import { z } from 'zod';

/** GET /api/status (outreach-api, plan 1B B7): server-wide switches the app shows as banners. */
export const OutreachStatus = z.object({ killSwitch: z.boolean() });
export type OutreachStatus = z.infer<typeof OutreachStatus>;
```
In `packages/contracts/src/index.ts`, add this after `export * from './session.js';`:
```ts
export * from './status.js';
```

Create `services/outreach-api/src/routes/status.ts`:
```ts
/**
 * GET /api/status — server-wide switches the app shows as banners (plan 1B
 * task B7). Any signed-in member may read it.
 */
import type { FastifyInstance } from 'fastify';
import type { OutreachStatus } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { AppConfig } from '../config.js';
import { requireContext } from '../tenancy/scope.js';

export async function registerStatusRoutes(app: FastifyInstance, deps: { db: Db; cfg: Pick<AppConfig, 'OUTREACH_KILL_SWITCH'> }): Promise<void> {
  app.get('/status', async (req, reply) => {
    const ctx = await requireContext(deps.db, req, reply);
    if (!ctx) return;
    return { killSwitch: deps.cfg.OUTREACH_KILL_SWITCH === 'on' } satisfies OutreachStatus;
  });
}
```
In `services/outreach-api/src/server.ts`, add `import { registerStatusRoutes } from './routes/status.js';` with the other `./routes/…` imports. Add this as the last entry of `apiRoutes`:
```ts
      (scope) => registerStatusRoutes(scope, { db, cfg }),
```

- [ ] **Step 19: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm run build:packages >/dev/null && npm -w packages/contracts run test -- src/status.test.ts 2>&1 | tail -4 && npm -w services/outreach-api run typecheck && npm -w services/outreach-api run test 2>&1 | tail -4
```
Expected: the contracts test passes (1 test), and the outreach-api typecheck is clean. The outreach-api suite passes, with `routes/status.test.ts` at 3 tests and the `pgLane` suites skipped.
```bash
cd "$(git rev-parse --show-toplevel)" && grep -n "killSwitch\|pauseAlert\|resumeBudgetPausedCampaigns\|registerStatusRoutes\|'calls.reconcile'" services/outreach-api/src/server.ts
```
Expected lines:
- the three imports (`campaignsPausedAlert`, `resumeBudgetPausedCampaigns`, `registerStatusRoutes`)
- `const killSwitch` and its `if (killSwitch)` warn
- `const pauseAlert = campaignsPausedAlert(console);`, and `alert: pauseAlert` in the `campaign.refresh` and `record.triage` handlers
- `killSwitch` in the `touch.plan` and `sf.write` handlers
- `resumeBudgetPausedCampaigns(` in `touch.plan`
- the `'calls.reconcile'` entry (B6)
- the `registerStatusRoutes(` route entry

- [ ] **Step 20: Commit**
```bash
git add packages/contracts/src/status.ts packages/contracts/src/status.test.ts packages/contracts/src/index.ts services/outreach-api/src/routes/status.ts services/outreach-api/src/routes/status.test.ts services/outreach-api/src/server.ts
git commit -m "feat(outreach-api): GET /api/status reports the outreach kill switch"
```

#### Part 5: the banner

A12/A13 already show a paused campaign's reason in words, on the campaigns list (`pauseReasonWords`) and in the campaign page's `CampaignBanners`. B7 reuses them. It adds only the kill-switch banner and corrects the `ai_budget` words: the resume happens at 00:00 UTC, which is the same afternoon for a Pacific-time tenant, so "resumes tomorrow" was wrong.

- [ ] **Step 21: Write the failing tests**

Create `apps/outreach-web/src/components/kill-switch-banner.test.tsx`:
```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test/render';
import { respond, stubApi } from '../test/stub-api';
import { KillSwitchBanner } from './kill-switch-banner';

afterEach(() => vi.unstubAllGlobals());

describe('KillSwitchBanner', () => {
  it('shows the banner while the kill switch is on', async () => {
    stubApi({ 'GET /api/status': { killSwitch: true } });
    renderWithProviders(<KillSwitchBanner />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Outreach is switched off.');
  });

  it('renders nothing while the switch is off', async () => {
    const calls = stubApi({ 'GET /api/status': { killSwitch: false } });
    const { container } = renderWithProviders(<KillSwitchBanner />);
    await waitFor(() => expect(calls.map((c) => c.url)).toContain('/api/status'));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the status cannot be read (the banner is information, never a gate)', async () => {
    const calls = stubApi({ 'GET /api/status': respond(500, { error: 'boom', code: 'INTERNAL_ERROR' }) });
    const { container } = renderWithProviders(<KillSwitchBanner />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
```
In `apps/outreach-web/src/lib/outreach-words.test.ts` and in `apps/outreach-web/src/components/campaign-detail.test.tsx`, replace the row:
```ts
    ['ai_budget', "Paused: today's AI budget is used up — resumes tomorrow"],
```
with:
```ts
    ['ai_budget', "Paused: today's AI budget is used up — resumes at 00:00 UTC"],
```

- [ ] **Step 22: Run them to verify they fail**
```bash
cd "$(git rev-parse --show-toplevel)" && npm run build:packages >/dev/null && npm -w apps/outreach-web run test -- src/components/kill-switch-banner.test.tsx src/lib/outreach-words.test.ts src/components/campaign-detail.test.tsx 2>&1 | tail -12
```
Expected failures:
- `kill-switch-banner.test.tsx` fails to load: `Failed to resolve import "./kill-switch-banner"`.
- The `ai_budget` row fails in each of the other two files: `expected 'Paused: today\'s AI budget is used up — resumes tomorrow' to be …` and `Expected element to have text content`.

- [ ] **Step 23: Implement**

In `apps/outreach-web/src/lib/outreach-words.ts`, replace the line:
```ts
  ai_budget: "Paused: today's AI budget is used up — resumes tomorrow",
```
with:
```ts
  ai_budget: "Paused: today's AI budget is used up — resumes at 00:00 UTC",
```
and add this after `pauseReasonWords`:
```ts

/** Every signed-in page shows this while OUTREACH_KILL_SWITCH is on (plan 1B B7). */
export const KILL_SWITCH_WORDS =
  'Outreach is switched off. No campaign calls reach the dialer and nothing is written to Salesforce until an operator turns it back on. Planning continues.';
```

In `apps/outreach-web/src/lib/outreach-api.ts`, make these edits:
- Add `OutreachStatus,` to the value imports from `@cti/contracts`, between `NeedsReviewResponse,` and `StartConnectionResponse,`.
- Add `status: ['status'] as const,` as the last member of `outreachKeys`.
- Append:
```ts

/** Server-wide switches (plan 1B B7): today, the global kill switch. */
export function getStatus(): Promise<OutreachStatus> {
  return api('/api/status', OutreachStatus);
}
```

Create `apps/outreach-web/src/components/kill-switch-banner.tsx`:
```tsx
import { useQuery } from '@tanstack/react-query';
import { getStatus, outreachKeys } from '@/lib/outreach-api';
import { KILL_SWITCH_WORDS } from '@/lib/outreach-words';

/**
 * Shown on every signed-in page while OUTREACH_KILL_SWITCH is on (plan 1B task
 * B7). Renders nothing while loading, when the switch is off, and when the
 * status cannot be read — the banner is information, never a gate.
 */
export function KillSwitchBanner() {
  const status = useQuery({ queryKey: outreachKeys.status, queryFn: getStatus, staleTime: 60_000, refetchInterval: 60_000 });
  if (!status.data?.killSwitch) return null;
  return (
    <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {KILL_SWITCH_WORDS}
    </div>
  );
}
```

In `apps/outreach-web/src/components/app-shell.tsx`, add `import { KillSwitchBanner } from './kill-switch-banner';` after `import { TenantSwitcher } from './tenant-switcher';`. Replace:
```tsx
      <main className="mx-auto max-w-5xl p-6">{children}</main>
```
with:
```tsx
      <main className="mx-auto max-w-5xl p-6">
        <KillSwitchBanner />
        {children}
      </main>
```

- [ ] **Step 24: Run the tests to verify they pass**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w apps/outreach-web run test 2>&1 | tail -5 && npm -w apps/outreach-web run typecheck
```
Expected: no failures, and `kill-switch-banner.test.tsx` passes 3 tests. The route tests in `-routes.test.tsx` render the shell. Their fetch stubs answer 404 for `/api/status`, so the banner stays hidden and none of their assertions change. The typecheck is clean.

- [ ] **Step 25: Commit, then run the root verification**
```bash
git add apps/outreach-web/src/lib/outreach-words.ts apps/outreach-web/src/lib/outreach-words.test.ts apps/outreach-web/src/lib/outreach-api.ts apps/outreach-web/src/components/kill-switch-banner.tsx apps/outreach-web/src/components/kill-switch-banner.test.tsx apps/outreach-web/src/components/app-shell.tsx apps/outreach-web/src/components/campaign-detail.test.tsx
git commit -m "feat(outreach-web): kill switch banner; AI-budget pauses resume at 00:00 UTC"
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test 2>&1 | tail -6 && npm run test:pg 2>&1 | tail -4
```
Expected: the typecheck is clean, every workspace's tests pass, and `test:pg` passes with no failures.

---

### Task 8: Deploy — IaC variables, `.env.example`, runbook, README, follow-ups [B8]

> **Before you start** (shared with the other tasks drafted alongside this one):
>
> - B5 ran in full against apps/cti-web at fa78987, with B4's contracts shimmed. The cti-web suite went from 57 files / 912 tests to 59 / 928, and the typecheck was clean.
> - B6 ran on Postgres 17 with a stand-in for the A3 tables. That covers reconcile.ts and both reconcile test files.
> - B7 ran the same way for config, alerts, pause.ts, pause.pg.test.ts, kill-switch.pg.test.ts, routes/status.ts and the outreach-web banner.
> - B7 code that edits files A8/A9/A10/B2/B4 have not produced yet was written against their drafts and was not run: pause-alerts.pg.test.ts, kill-switch.test.ts, the cti-api kill-switch test, and every server.ts and refresh/triage/outbox edit.
> - B8's railway.ts edit was typechecked. The .env.example test ran against the pre-A5 config. -->
>

**Files:**
- Modify `.railway/railway.ts`:
  - line 31 (the `_ctiapi` env object, one line)
  - insert after line 58 (`WORKOS_REDIRECT_URI: preserve(),` in `outreachApi`)
- Replace `services/outreach-api/.env.example`.
- Modify `services/outreach-api/src/config.test.ts`: three imports at the top, plus one `describe` appended.
- Modify `docs/runbooks/outreach-sf-campaigns.md`, which B1 created. Append the sections below after B1's last section.
- Modify `README.md`: insert after the paragraph that starts `**Deploy:**`, which ends `(runbook §5, before 2026-12-01).`.
- Modify `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`: append one section.

Dockerfiles are not touched. A1 already copies `packages/salesforce/package.json` in the root and outreach-api Dockerfiles.

**Interfaces:**
- **Consumes:**
  - Every variable the 1A/1B config reads:
    - A5: `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`, `SALESFORCE_REDIRECT_URI`, `SALESFORCE_LOGIN_URL`, `SALESFORCE_API_VERSION` (default `v60.0`), `ANTHROPIC_API_KEY`
    - existing: `ALERT_WEBHOOK_URL`
    - B7: `OUTREACH_KILL_SWITCH`, on both services
  - `parseConfig` with `workosEnabled`, `salesforceEnabled` and `aiEnabled`.
  - Root `test:pg` = `npm run build:packages && sh services/outreach-api/scripts/test-pg.sh`.
- **Produces:** the IaC declarations, a `.env.example` that boots as written, the runbook sections, a README pointer and the follow-up entries.

`railway config apply` deletes any Railway variable that `.railway/railway.ts` does not declare. Every variable an operator sets by hand must therefore be declared with `preserve()`. That covers the kill switch on **both** services and `ALERT_WEBHOOK_URL` on outreach-api; without it, the B7 pause alerts would reach only the log.

- [ ] **Step 1: Write the failing test**

In `services/outreach-api/src/config.test.ts`, add these three imports at the top, above the `vitest` import:
```ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```
Append to the file:
```ts

describe('.env.example', () => {
  it('boots as written (with real secrets filled in), every optional integration off and the kill switch off', () => {
    const env: Record<string, string> = {};
    const file = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../.env.example'), 'utf8');
    for (const line of file.split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) env[m[1]!] = m[2]!;
    }
    const cfg = parseConfig({ ...env, TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SESSION_SECRET: 's'.repeat(32) });
    expect(cfg.OUTREACH_KILL_SWITCH).toBe('off');
    expect(cfg.workosEnabled).toBe(false);
    expect(cfg.salesforceEnabled).toBe(false);
    expect(cfg.aiEnabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/config.test.ts 2>&1 | tail -8
```
Expected: `1 failed`, with `Error: Invalid environment configuration:` and `- WorkOS: set all three or none; missing WORKOS_API_KEY, WORKOS_CLIENT_ID`. Today's `.env.example` ships `WORKOS_REDIRECT_URI` filled in with an empty key and client id, so a fresh copy of it does not boot.

- [ ] **Step 3: Replace `services/outreach-api/.env.example`**
```dotenv
NODE_ENV=development
API_PORT=4100
API_PUBLIC_URL=http://localhost:4100
# Where the SPA lives for redirects after sign-in (Vite dev server in dev; the API's own origin in prod).
APP_PUBLIC_URL=http://localhost:5175
# Same values as services/cti-api so sessions and encrypted tokens interoperate.
TOKEN_ENCRYPTION_KEY=replace_me_with_64_hex_chars
SESSION_SECRET=replace_me_with_long_random_string
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cti_dev
# WorkOS AuthKit (dashboard -> API Keys / Configuration). Set all three or none;
# unset = the sign-in routes answer 503. Locally the redirect URI is
# http://localhost:4100/api/auth/workos/callback
WORKOS_API_KEY=
WORKOS_CLIENT_ID=
WORKOS_REDIRECT_URI=
# Salesforce Connected App for the company-wide Integration-user connection
# (docs/runbooks/outreach-sf-campaigns.md). Set CLIENT_ID and REDIRECT_URI
# together or neither; unset = the connection routes answer 503 SALESFORCE_DISABLED.
# Locally the redirect URI is http://localhost:4100/api/connections/salesforce/callback
SALESFORCE_CLIENT_ID=
# Only when the Connected App requires a secret for the web server flow.
SALESFORCE_CLIENT_SECRET=
SALESFORCE_REDIRECT_URI=
# https://test.salesforce.com for a sandbox.
SALESFORCE_LOGIN_URL=https://login.salesforce.com
SALESFORCE_API_VERSION=v60.0
# Claude (note triage). Unset = triage is off.
ANTHROPIC_API_KEY=
# pg-boss schema in the shared Postgres.
PGBOSS_SCHEMA=pgboss
# Slack-compatible webhook for automatic-pause and outbox alerts. Unset = alerts go to the log only.
ALERT_WEBHOOK_URL=
CORS_ALLOWED_ORIGINS=
# Global kill switch, on | off. on = no campaign call reaches the dialer and no
# Salesforce write is sent. services/cti-api reads the same variable.
OUTREACH_KILL_SWITCH=off
```

- [ ] **Step 4: Run it to verify it passes**
```bash
cd "$(git rev-parse --show-toplevel)" && npm -w services/outreach-api run test -- src/config.test.ts 2>&1 | tail -4
```
Expected: no failures.

- [ ] **Step 5: Commit**
```bash
git add services/outreach-api/.env.example services/outreach-api/src/config.test.ts
git commit -m "fix(outreach-api): .env.example boots as written and lists the 1B variables"
```

- [ ] **Step 6: Declare the variables in `.railway/railway.ts`**

On line 31, the one-line `_ctiapi` `env` object, insert `OUTREACH_KILL_SWITCH: preserve(), ` between `NUMBERVERIFIER_VERIFY_KEY: preserve(), ` and `PORT: preserve(), `. The keys stay alphabetical. Nothing else on the line changes.

In the `outreachApi` `env` object, after line 58 (`      WORKOS_REDIRECT_URI: preserve(),`), insert:
```ts
      // Salesforce campaigns (docs/runbooks/outreach-sf-campaigns.md). Set in the
      // dashboard; preserve() keeps `railway config apply` from deleting them.
      SALESFORCE_CLIENT_ID: preserve(),
      SALESFORCE_CLIENT_SECRET: preserve(),
      SALESFORCE_REDIRECT_URI: preserve(),
      SALESFORCE_LOGIN_URL: preserve(),
      ANTHROPIC_API_KEY: preserve(),
      ALERT_WEBHOOK_URL: preserve(),
      // Must match @cti/api's value (the runbook's Kill switch section).
      OUTREACH_KILL_SWITCH: preserve(),
```
Check that the file still compiles:
```bash
cd "$(git rev-parse --show-toplevel)" && ./node_modules/.bin/tsc --noEmit --module esnext --moduleResolution bundler --target es2022 --skipLibCheck .railway/railway.ts; echo "exit $?"
```
Expected: `exit 0`.

If the Railway CLI is linked to `endearing-comfort`, run the plan. It is read-only. **Never run `railway config apply`**; that is an operator step, described in the runbook below.
```bash
cd "$(git rev-parse --show-toplevel)" && railway config plan
```
Expected: the summary line says `0 to destroy`, and there is no `- Delete variable` line on either service. The add count is `1 to add` while the outreach-api service does not exist yet, and `0 to add` once it does. If the plan shows any `- Delete variable` line, stop and report it. A variable set in Railway but missing from `railway.ts` must be declared with `preserve()` first. If the CLI is not linked, skip this check; the runbook makes it the operator's first deploy step.

- [ ] **Step 7: Commit**
```bash
git add .railway/railway.ts
git commit -m "chore(railway): preserve the outreach 1B variables and the kill switch on both services"
```

- [ ] **Step 8: Append the deploy sections to the runbook**

Append to `docs/runbooks/outreach-sf-campaigns.md`, after B1's last section:
````markdown
## Variables

`.railway/railway.ts` declares every variable below with `preserve()`. The infrastructure-as-code never sets a value, and `railway config apply` never deletes one. A variable that is **not** declared there is deleted by the next apply, so declare a new variable in `railway.ts` before you set it in the dashboard.

**outreach-api → Variables**

| Variable | Value | Unset means |
|---|---|---|
| `SALESFORCE_CLIENT_ID` | Consumer Key of the Connected App (Salesforce setup, above) | The Salesforce routes answer 503 `SALESFORCE_DISABLED`; no refresh or triage tick runs |
| `SALESFORCE_CLIENT_SECRET` | Consumer Secret, only if the Connected App requires a secret for the web server flow | The token exchange sends no secret |
| `SALESFORCE_REDIRECT_URI` | `https://<outreach-api domain>/api/connections/salesforce/callback`. It must equal the Connected App's callback URL exactly | Same as `SALESFORCE_CLIENT_ID`: set both or neither, or the boot fails |
| `SALESFORCE_LOGIN_URL` | `https://login.salesforce.com` (`https://test.salesforce.com` for a sandbox) | `https://login.salesforce.com` |
| `ANTHROPIC_API_KEY` | The Anthropic API key used for note triage | No triage tick; no AI spend |
| `ALERT_WEBHOOK_URL` | A Slack-compatible incoming webhook | Alerts go to the deploy log only |
| `OUTREACH_KILL_SWITCH` | `off` | `off` |

**@cti/api → Variables**

| Variable | Value | Unset means |
|---|---|---|
| `OUTREACH_KILL_SWITCH` | `off`, and always the same value as outreach-api's | `off` |

## Plan the infrastructure (read-only)

From the repo root on `main`, with the CLI linked to project `endearing-comfort`:

```bash
railway config plan
```

Read the whole output before doing anything else.

- The summary line must say `0 to destroy`.
- **Stop on any `- Delete variable` line**, on either service. It means a variable is set in Railway but not declared in `.railway/railway.ts`, and the apply would delete it. Declare it with `preserve()` in `railway.ts`, merge that, and plan again.
- The add count depends on what exists already. It is `1 to add` while the outreach-api service has not been created yet (`docs/runbooks/outreach-api-deploy.md` §1), and `0 to add` after that.

`railway config apply` is an operator step. A person runs it after reading the plan. An agent or script working through this runbook stops at the plan and reports what it showed.

## Deploy

1. Merge to `main`. outreach-api, @cti/api and the softphone (@cti/web) all deploy from `main`. outreach-api's pre-deploy migrate applies the campaign migrations.
2. Plan (above). If the plan is clean and something must be created or changed, the operator runs `railway config apply`.
3. Set the outreach-api variables (table above) in the dashboard, then redeploy outreach-api: **Deployments → ⋯ on the latest deployment → Redeploy**.
4. Check `/healthz` → 200 and `/readyz` → `{ ok: true, dbOk: true, jobsOk: true }`. The deploy log must **not** contain `OUTREACH_KILL_SWITCH is on`.
5. Nothing changes in the softphone until a campaign is Live and has rep calls due. Until then, the Campaign calls picker stays hidden.

## Go-live checklist (first tenant)

Do these in order. Each step says what you should see before you go on.

1. [ ] **Salesforce fields and permission set** are deployed and assigned (Salesforce setup, above). On a Lead in Salesforce, the three AI Call Consent fields are visible to the Integration user.
2. [ ] **Connect Salesforce.** Sign in to the outreach app as a tenant admin, go to **Settings → Connections → Connect Salesforce**, and sign in as the Integration user. The page shows the connection as connected, with the Salesforce org and user.
3. [ ] **Consent settings.** On the same page, turn on **Consent from web forms** only if every web form feeding this org carries consent language for calls and texts. Turn on **Consent from inbound calls** if the tenant wants it. Press **Backfill** and write down the two counts.
4. [ ] **First campaign, in dry run.** Go to **Campaigns → New campaign**. Pick a small list view or query (tens of records, not thousands), press Preview, then Create. Set the campaign to **Dry run**.
5. [ ] **Review the plan.** Within 5 minutes the campaign refreshes: the member count and "last refreshed" fill in. A few minutes later the plan fills in. Open the gate audit on several rows: every skipped person must show the reason you expect (consent, Do Not Call, Skip on Dialer, quiet hours). Work through **Needs review**.
6. [ ] **Activate.** Set the campaign to **Live**. On the next `touch.plan` tick (every minute), due rep calls move to the dialer queue.
7. [ ] **A rep starts Campaign calls.** In the softphone's Power dial tab, under the list picker, the rep sees **Campaign calls** with the campaign and its due count. The rep presses **Dial campaign calls**, then works the usual confirm block and **Start dialing**.
8. [ ] **Verify reconcile.** A minute after the run ends, every touch it carried has left `dialing`. Copy the campaign's id from the campaign page's URL and run this read-only query (`railway connect Postgres`):

   ```sql
   \set campaign_id '<paste the campaign id>'
   select t.status, t.outcome, t.skip_reason, count(*)
     from touches t
     join campaign_enrollments e on e.id = t.enrollment_id
    where e.campaign_id = :'campaign_id'
      and t.channel = 'rep_call'
    group by 1, 2, 3
    order by 1, 2, 3;
   ```

   Expect these rows:
   - `sent | connected` for the people the rep spoke to. They show as Conversing in the campaign's plan.
   - `sent | <miss reason>` for misses.
   - `skipped | | <reason>` for people the dialer skipped at build or dial time.
   - `queued` for records a stopped or limited run never reached. They go to the next run.
   - No `dialing` rows more than 10 minutes after the run ended.

## Kill switch

`OUTREACH_KILL_SWITCH=on` stops outreach from reaching anyone. It changes no campaign settings.

- **outreach-api:** no planned rep call is moved to the dialer queue. The Salesforce write outbox holds every row; nothing is lost, and the rows send after the switch is turned off.
- **@cti/api:** the softphone's Campaign calls picker lists nothing, and a start claims nothing.
- **Outreach app:** every page shows a red banner within a minute.

Planning, refresh, triage and reconcile keep running, so the plan stays current and a run already in progress still settles. The switch does **not** stop a power-dial run that is already dialing. If calls must stop now, the rep presses Stop in the softphone.

**Turn it on:** set `OUTREACH_KILL_SWITCH=on` on **both** outreach-api and @cti/api, then deploy both. Railway stages the variable change; deploy it, or use Redeploy. One service alone is not enough. With only outreach-api switched, @cti/api still hands out touches that were already queued. With only @cti/api switched, outreach-api keeps queueing new ones and keeps writing to Salesforce. Confirm in the outreach-api deploy log: `OUTREACH_KILL_SWITCH is on`.

**Turn it off:** set both back to `off` and deploy both. Held touches queue on the next `touch.plan` tick, and held Salesforce writes send on the next `sf.write` tick.

Any value other than `on` or `off` (for example `true` or `1`) fails the boot on purpose.

## Automatic pauses and alerts

Every alert is logged as `alert: …`. It is also posted to `ALERT_WEBHOOK_URL` when that is set.

| What | When | Alert | How it ends |
|---|---|---|---|
| Pause `crm_broken` | The refresh tick finds the tenant's Salesforce connection unusable: none, marked broken, or a token refresh refused (400/401). A Salesforce outage (5xx) does **not** pause. | One critical `campaigns_paused` alert per pause, naming the campaigns | Never on its own. Reconnect Salesforce in Settings → Connections, then resume each campaign from its page. |
| Pause `ai_budget` | Today's (UTC) AI triage spend reached the tenant's daily budget (default $25) | One warning `campaigns_paused` alert per pause | On its own at the first `touch.plan` tick after 00:00 UTC (4–5 pm Pacific). Each campaign goes back to the state it was paused from, so a dry-run campaign stays in dry run. It ends sooner if an admin raises the budget. |
| Salesforce writes failing (no pause) | A queued Salesforce write has failed for 24 hours | One warning `sf_write_failing` alert per row | The row keeps retrying every 6 hours. Fix the cause (field-level security, a validation rule) and it sends on the next try. |

A pause alerts once. Later ticks find the campaigns already paused and stay quiet. If the same tenant pauses again after a resume, that is a new alert.

## Tests against a real database

The reconcile, pause, kill-switch, planner, refresh and triage suites run only against Postgres:

```bash
npm run test:pg
```

That is `npm run build:packages && sh services/outreach-api/scripts/test-pg.sh`, which runs the outreach-api suite with `TEST_DATABASE_URL` set. Plain `npm test` skips those suites, and so does CI today.

## Rollback

- **Fastest:** the kill switch (above). It stops all outreach within one deploy of each service and loses nothing.
- **One tenant or one campaign:** pause its campaigns from their pages.
- **Code:** revert the merge on `main` and let the services redeploy. The campaign migrations only add tables and columns, so leave them in place. Touches left in `dialing` are settled by `calls.reconcile` once the code is redeployed.
````

- [ ] **Step 9: Add the README pointer**

In `README.md`, after the paragraph that starts `**Deploy:** \`docs/runbooks/outreach-api-deploy.md\`` (it ends `(runbook §5, before 2026-12-01).`), insert a blank line and then:
```markdown
**Salesforce campaigns:** `docs/runbooks/outreach-sf-campaigns.md` — Salesforce
fields and permission set, variables, the read-only IaC plan, the go-live
checklist, the kill switch (`OUTREACH_KILL_SWITCH`, set on both outreach-api
and @cti/api), and automatic pauses and alerts.
```

- [ ] **Step 10: Append the follow-ups**

Append to `docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md`:
```markdown

## Salesforce campaigns (plans 1A and 1B) — follow-ups

- **CTI client convergence.** cti-api calls Salesforce through its own per-rep client. outreach-api uses `@cti/salesforce` on the company-wide Integration-user connection. Move cti-api onto `@cti/salesforce` the next time its Salesforce code is reworked, so there is one client, one error split (auth vs outage) and one retry policy.
- **Real-Postgres lane in CI.** The reconcile, pause, kill-switch, planner, refresh and triage suites run only under `npm run test:pg` on a developer machine; CI skips them. Add a CI job with a Postgres service and `TEST_DATABASE_URL`.
- **Texting hours in phase 2.** Phase 1 plans `sms` touches but never sends them. The phase 2 sender must check the recipient's local texting hours at send time, not only at plan time: a held or deferred touch can come due outside them.
- **Paused runs hold touches.** `calls.reconcile` waits while a campaign run is `active` or `paused`. A run a rep pauses and never resumes keeps its touches in `dialing` indefinitely. Add an idle cutoff, for example release after a paused run has been idle for 4 hours, the way abandoned `ready` runs are stopped after 2 hours.
- **Transient skips consume a touch.** A dial-time skip such as `out_of_hours`, `cooldown` or `daily_cap` settles the touch as `skipped` and advances the sequence. Consider releasing transient skips back to `queued`, so the person is called in the next run instead of losing that day's touch.
- **Two-service kill switch.** `OUTREACH_KILL_SWITCH` must be flipped on outreach-api and @cti/api together. Move it to one database row that both services read, settable from the admin UI, so one action stops everything without a deploy.
- **Stale claim vs. a long run build.** `calls.reconcile` releases a claim that has no run after 10 minutes. If B4's build is still running at that point, its later `attachSession` can stamp a touch another rep has re-claimed, and its `releaseTouches` on failure can release one. Make both match the touch's own claim: `dialer_session_id is null` and `claimed_at` equal to this claim's time.
- **Touch status vocabulary vs spec §9.** The spec lists `claimed` and `awaiting_approval`. The A3 CHECK uses `dialing` for a claimed call and `held`. A connected call is recorded as `sent` with outcome `connected`. Align the spec's §9 list with the CHECK values.
```

- [ ] **Step 11: Run the root verification and commit**
```bash
cd "$(git rev-parse --show-toplevel)" && npm run typecheck && npm test 2>&1 | tail -6
```
Expected: the typecheck is clean and every workspace passes.
```bash
git add docs/runbooks/outreach-sf-campaigns.md README.md docs/superpowers/plans/2026-09-03-outreach-foundation-1-followups.md
git commit -m "docs(outreach): Salesforce campaigns runbook — variables, IaC plan, go-live, kill switch, pauses"
```

---

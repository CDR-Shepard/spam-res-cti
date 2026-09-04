# AI Outreach — Sub-project 1: Foundation — Design Spec

**Date:** 2026-09-03
**Status:** Approved design, pending implementation plan
**Program context:** [2026-09-03-ai-outreach-program-design.md](./2026-09-03-ai-outreach-program-design.md)

---

## 1. Summary

Foundation turns `spam-res-cti` from a single-org Salesforce CTI into the base of a multi-tenant outreach platform without changing anything the reps see. It extracts the shared substrate (database, firewall, phone, auth) into packages; makes `organizations` a real tenant boundary with a hosted auth provider; adds a product-owned lead store with an import pipeline that dedupes and scrubs; makes the firewall channel- and actor-aware; and builds the CRM delivery outbox with a signed webhook and a Salesforce adapter. A new `outreach-api` service and `outreach-web` app expose all of it to admins.

**Success criteria:** our team signs into `outreach-web`, imports a real owner list, reads the scrub report, marks one contact qualified, and a Lead appears in our Salesforce with the full payload. Throughout, the softphone, power dialer, and iOS app work exactly as before, and the existing CTI test suite passes unchanged after the extraction.

---

## 2. Goals and non-goals

**Goals**
1. Pure-refactor extraction of `db`, `firewall`, `phone`, `auth` (with `crypto`) into `packages/*`, with the firewall split into one file per gate; `salesforce` extracted later in the rollout when delivery needs it.
2. Real tenancy: per-tenant email uniqueness, service users, a provisioning function, WorkOS AuthKit sign-in that issues the existing session token.
3. A lead store the AI and every channel can reason from: properties, persons, contact points, lists, memberships.
4. An import pipeline that normalizes, dedupes, scrubs (fail-closed), and reports.
5. A litigator suppression table and firewall gate.
6. `channel` and `actor` on the firewall; gate applicability by channel; `ai_voice_consent` gate; cross-channel attempt view.
7. CRM delivery: qualifications, connections, outbox, worker, signed webhook v1, Salesforce adapter, manual qualify.
8. `outreach-api` and `outreach-web` deployed as new Railway services with no change to the softphone.

**Non-goals (deferred to later sub-projects)**
- Campaigns, sequences, sending on any channel, threads, inbox, AI conversation.
- Skip tracing, geocoding, property enrichment.
- Billing, per-seat limits, SCIM, a role table.
- Moving `cti-api`'s interval loops onto pg-boss.

---

## 3. Architecture

### 3.1 Packages (new, extracted)

| Package | Contents | Source today |
|---|---|---|
| `packages/db` | Drizzle schema, `getDb`/`getPool`, `migrate.ts` (advisory-locked), `migrations/` | `services/cti-api/src/db/*`, `services/cti-api/migrations/*` |
| `packages/firewall` | `evaluate`, aggregator, one module per gate, `state-calling-rules`, `warmup`, `tz`, `rotation`, `reputation/signals` (pure parts) | `services/cti-api/src/firewall/*`, `rotation.ts`, `reputation/signals.ts` |
| `packages/phone` | `normalize`, formatting, libphonenumber wrapper | `services/cti-api/src/phone.ts` |
| `packages/auth` | `issueSession`, `resolveSession`, `revokeSession`, WorkOS exchange, `crypto.ts` (AES-256-GCM, `sha256`, `randomToken`) | `services/cti-api/src/auth/session.ts`, `services/cti-api/src/crypto.ts` |
| `packages/salesforce` | REST client, OAuth (PKCE) helpers, `SalesforceUnauthorizedError` refresh path. Sync and follow-up workers stay in `cti-api`. Extracted in rollout step 6, when the delivery adapter first needs it. | `services/cti-api/src/salesforce/{client,oauth}.ts` |
| `packages/contracts` | zod schemas and TS types shared by `outreach-api` and `outreach-web`, and the webhook payload schema | new |

Rules for the extraction:
- **No behavior change.** Commit boundaries: one package per commit; `cti-api` switches imports in the same commit; typecheck and the full CTI test suite green at each commit.
- **Firewall split.** `firewall/index.ts` (1,350 lines) becomes `gates/<name>.ts` (one gate each, exporting `{ name, channels, run }`), `aggregate.ts`, `evaluate.ts`, `reasons.ts`, `types.ts`. Existing exported functions (`evaluate`, `aggregate`, `tallyAttempts`, `velocityGateCheck`, `callingHoursGateCheck`, etc.) keep their names and signatures via the package index.
- **Migrations path.** `packages/db/migrations/` becomes the single migrations directory. `cti_schema_migrations` tracking table is unchanged so already-applied files are recognized. Both services' `railway.json` `preDeployCommand` becomes `npm --workspace packages/db run migrate`.
- **Advisory lock.** The runner wraps its run in `pg_advisory_lock(<constant>)` so two services deploying from one push serialize; the second run finds nothing to apply.
- **Dockerfiles.** `cti-api` keeps the root Dockerfile (updated to copy `packages/*/package.json` for the install layer). `services/outreach-api/Dockerfile` builds `outreach-web` and `outreach-api`. Railway service settings point each service at its Dockerfile and `railway.json`.

### 3.2 Deployables

- **`services/cti-api`** — unchanged role. Imports packages instead of local modules. Twilio webhooks, Salesforce sync, power dialer, softphone hosting all stay here.
- **`services/outreach-api`** — new Fastify service. Same conventions as `cti-api`: zod-validated env in `config.ts`, `trustProxy: 1`, global rate limit with webhook allow-list, CORS allow-list, pino redaction, `unhandledRejection` guard. Serves `apps/outreach-web/dist` at `/`. Hosts the pg-boss handlers for Foundation jobs (import, scrub, lookup, delivery). A separate worker service arrives in sub-project 2.
- **Shared env**: `DATABASE_URL`, `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (identical values across services so sessions and encrypted tokens interoperate). `outreach-api` adds `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`, `ANTHROPIC_API_KEY`, `STORAGE_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY`, `TWILIO_ACCOUNT_SID/AUTH_TOKEN` (Lookup), `ALERT_WEBHOOK_URL`, `API_PUBLIC_URL`, `CORS_ALLOWED_ORIGINS`.

### 3.3 Jobs

pg-boss, schema `pgboss` in the shared database, started by `outreach-api`. Queues in Foundation: `import.parse`, `import.normalize`, `import.dedupe`, `import.scrub`, `import.lookup`, `import.report`, `delivery.send`. Every job carries `orgId` and a `requestId`. Defaults: 3 retries with exponential backoff for pipeline steps; delivery has its own schedule (§8.4). Failed jobs after retries are visible in the admin UI's Jobs panel and raise an alert.

### 3.4 Web

`apps/outreach-web`: React 18, Vite, TypeScript strict, TanStack Router and Query, Tailwind, shadcn/ui, vitest with Testing Library (matching `cti-web`). API client generated from `packages/contracts` schemas. Bearer session in memory plus a refresh on load via a short-lived cookie set by the exchange route. No Next.js.

### 3.5 Tenant scoping

Every product table has `org_id`. Every repository function in `outreach-api` takes `orgId` as its first argument and includes it in the `where`. A CI check greps `outreach-api/src` for Drizzle queries on product tables lacking an `orgId` predicate and fails the build. Integration tests seed two tenants and assert isolation on every list endpoint.

---

## 4. Tenancy and auth

### 4.1 Schema changes

`organizations` (existing) gains:
- `slug text unique not null` (generated from name on migration for the existing row),
- `timezone text not null default 'America/Los_Angeles'`,
- `settings jsonb not null default '{}'` (per-tenant toggles; Foundation reads none, later sub-projects add `smsMode`, `dialRatio`, `botDisclosure`),
- `status text not null default 'active'` (`active` | `suspended`),
- `workos_org_id text unique` (nullable until the tenant is linked).

`users` (existing) changes:
- drop `users_email_unique`; add `unique (org_id, email)`,
- `kind text not null default 'human'` (`human` | `service`),
- `external_auth_id text unique` (WorkOS user id; null for Salesforce-only reps and service users),
- `is_super_admin boolean not null default false` (our staff; may switch tenants).

`resolveSession` returns `kind` and `isSuperAdmin` in addition to today's fields. Service users cannot hold sessions; `issueSession` refuses them.

### 4.2 AI Agent service user

Provisioning creates one `users` row per tenant: `kind = 'service'`, `display_name = 'AI Agent'`, `email = 'ai-agent@<slug>.internal'`. Every AI-initiated firewall evaluation, message, or call in later sub-projects uses this `userId`, so `pre_call_audits`, `calls`, and future tables always name the actor.

### 4.3 Sign-in flow (WorkOS AuthKit)

1. `outreach-web` redirects to AuthKit (hosted UI; email + password, magic link, Google; SSO available per tenant later).
2. AuthKit redirects to `outreach-api` `GET /auth/workos/callback?code=…`.
3. The route exchanges the code with the WorkOS SDK, receives the WorkOS user and organization membership.
4. Resolve tenant by `organizations.workos_org_id`. If the user has no membership, reject with a clear message (we invite users from the team page; no self-serve tenant creation in Foundation).
5. Find-or-create the `users` row by `(org_id, email)`; set `external_auth_id`; first user of a tenant becomes admin when the invite said so.
6. `issueSession(userId)`; set a 60-second, httpOnly, same-site cookie carrying the token and redirect to the app. The SPA calls `GET /auth/session` once; that route reads the cookie, returns the bearer token in the JSON body, and clears the cookie. The SPA keeps the bearer in memory afterwards and re-authenticates through AuthKit when it expires.

Reps keep signing into the softphone with Salesforce exactly as today. A rep who is also invited to `outreach-web` gets one `users` row (matched by email within the tenant) with both `external_auth_id` and a `salesforce_connections` row.

### 4.4 Roles

`is_admin` (existing) governs lists, suppression, numbers, CRM connections, team. Everyone else is an agent. Capability flags (`power_dialer_enabled`) stay as they are. Super admins see a tenant switcher; all their requests carry an explicit `X-Org-Id` that the API validates against `is_super_admin`.

### 4.5 Provisioning

One function, `provisionTenant({ name, slug, timezone, adminEmail })`:
create org → create AI Agent service user → create default `campaign_configs` row → create the WorkOS organization and store its id → send the admin invite through WorkOS. No `state_calling_rules` rows are created: the packaged rules apply to every tenant by default and that table holds per-tenant overrides only. Exposed as `POST /admin/tenants` (super admin) and `services/outreach-api/scripts/provision-tenant.ts` (same pattern as the fleet scripts). The migration that adds these columns also backfills GG Homes: slug, timezone, AI Agent user.

---

## 5. Lead store data model

All tables are tenant-scoped (`org_id uuid not null references organizations(id) on delete cascade`) with `created_at`/`updated_at timestamptz`. Ids are `uuid default gen_random_uuid()`. Migrations follow the existing idempotent `create table if not exists` style.

| Table | Purpose | Key columns |
|---|---|---|
| `properties` | One real property | `address_line1`, `address_line2`, `city`, `state`, `zip5`, `zip4`, `county`, `apn`, `normalized_key` (see §6.2), `attributes jsonb` (equity, est. value, last sale, occupancy, whatever the vendor supplies), `source_list_id`. Unique `(org_id, normalized_key)`. Index on `(org_id, apn)` where apn not null. |
| `persons` | Owner or decision-maker | `first_name`, `last_name`, `full_name_normalized`, `mailing_line1..zip5`, `mailing_key not null`, `timezone` (derived from mailing state or phone area code), `is_entity boolean`, `is_deceased boolean`, `attributes jsonb`. Unique `(org_id, full_name_normalized, mailing_key)`. When a row supplies no mailing address, `mailing_key` is set to the situs property's `normalized_key` (owner-occupied assumption), so uniqueness always applies and two different owners with the same name at different properties stay separate. |
| `property_persons` | Link with role | `property_id`, `person_id`, `role` (`owner` \| `heir` \| `executor` \| `trustee` \| `unknown`). Unique `(property_id, person_id)`. |
| `contact_points` | One phone or email | `person_id`, `kind` (`phone` \| `email`), `value` (E.164 or lowercased email), `line_type` (`mobile` \| `landline` \| `voip` \| `unknown`), `line_type_checked_at`, `source_list_id`, `status` (`active` \| `bad` \| `suppressed` \| `pending_scrub`), `status_reason` (`opted_out` \| `blocked` \| `dnc` \| `litigator` \| `invalid` \| `scrub_failed` \| null), `scrubbed_at`, `attributes jsonb`. Unique `(org_id, person_id, kind, value)`. Index `(org_id, kind, value)`. |
| `lists` | A named set from a vendor | `name`, `kind` (`preforeclosure` \| `absentee` \| `probate` \| `tax_delinquent` \| `code_violation` \| `vacant` \| `other`), `source_vendor` (`propstream` \| `batchleads` \| `csv` \| `api` \| `other`), `created_by_user_id`, `counts jsonb` (persons, properties, contact_points, suppressed). |
| `list_imports` | One file run against a list | `list_id`, `file_key` (object storage), `original_filename`, `mapping jsonb`, `mapping_template_id`, `status` (`uploaded` \| `mapping` \| `running` \| `done` \| `failed`), `row_count`, `stats jsonb` (new/merged/suppressed-by-reason/held/invalid), `error_log_key`, `started_at`, `finished_at`, `created_by_user_id`. |
| `import_mapping_templates` | Saved mappings per vendor | `name`, `source_vendor`, `header_signature` (sorted headers hash), `mapping jsonb`. Unique `(org_id, header_signature)`. |
| `list_memberships` | Person/property pair on a list | `list_id`, `person_id`, `property_id`, `import_id`, `raw_row jsonb`. Unique `(list_id, person_id, property_id)`. |
| `merge_log` | Non-destructive dedupe record | `entity` (`person` \| `property`), `kept_id`, `merged_from jsonb` (the raw row and candidate values), `import_id`, `rule`. |

**Suppression truth stays org-wide by value** in the existing `opt_outs`, `blocked_numbers`, and `federal_dnc_entries`, plus the new `litigator_entries` (§7). `contact_points.status` is a cached projection refreshed by the scrub job and by an opt-out event; it is never the source of truth. The firewall keeps reading the truth tables.

---

## 6. Import pipeline

One upload creates a `list_imports` row and enqueues `import.parse`. Each step is a pg-boss job that reads its input from the previous step's persisted output, so a crash resumes at the step, not the file.

### 6.1 Parse and mapping

- Accept CSV (UTF-8 or Latin-1, auto-detected) and XLSX. Limits: 50 MB, 500,000 rows. Files go to S3-compatible object storage (Railway bucket) under `imports/<org_id>/<import_id>/source`.
- Read headers plus the first 25 rows. If a `import_mapping_templates` row matches the header signature, propose it. Otherwise ask a small Claude model (Haiku 4.5) for a mapping from headers and sample values to the canonical fields (owner names, mailing address parts, situs address parts, APN, county, up to 10 phone columns and 5 email columns with per-column line-type hints, and pass-through attributes). The proposal is shown to the admin, who confirms or edits. Confirmation saves a template.
- Canonical field set is defined in `packages/contracts` so the web form and the pipeline agree.

### 6.2 Normalize

- **Phones:** `packages/phone` `normalize` to E.164; invalid → `status = bad`, `status_reason = invalid`.
- **Emails:** lowercase, trim, syntax-validate; invalid → `bad`.
- **Addresses:** a deterministic US normalizer (a parser library plus USPS abbreviation tables): uppercase, strip punctuation, standardize directionals and suffixes, normalize unit designators. `normalized_key = <line1 normalized>|<zip5>`. If APN and county are present, property identity prefers `(county, apn)`, and the address key is still stored.
- **Names:** split "LAST, FIRST" and "FIRST LAST" forms; strip suffixes (JR, SR, III) into an attribute; detect entities by keywords (LLC, TRUST, INC, ESTATE OF) → `is_entity = true`; "ESTATE OF" also sets `is_deceased = true` and the linked role to `heir`/`executor` where the row carries a separate contact name.
- **Timezone:** from mailing state (packaged state → IANA map, existing `tz.ts`), falling back to the first phone's area code.

### 6.3 Dedupe

Rules, in order, all within the tenant:
1. **Property** by `(county, apn)` when both present, else by `normalized_key`.
2. **Person** by `(full_name_normalized, mailing_key)`. Same name at a different mailing address is a different person (conservative). Entities dedupe by name plus mailing key as well.
3. **Contact point** by `(person_id, kind, value)`.

A match updates `attributes` by merging new keys without overwriting existing non-null values, adds the list membership, and writes a `merge_log` row. Nothing is deleted. Batch inserts use `insert … on conflict` in chunks of 1,000.

### 6.4 Scrub (fail closed)

For every contact point touched by the import, check, in the same order the firewall uses:
`opt_outs` → `blocked_numbers` → `federal_dnc_entries` → `litigator_entries` (global rows plus this tenant's rows).
- First hit sets `status = suppressed`, `status_reason` to the match, `scrubbed_at = now()`.
- No hit sets `status = active`.
- If the scrub query fails for a chunk, those rows are set to `pending_scrub` with `status_reason = scrub_failed`, the job retries, and after final failure the import finishes as `done` with a warning count and an alert. **Held rows are never contactable.** This is deliberately the opposite of the dialer's fail-open `blockedTargetsSafe`: nothing depends on an import finishing to keep reps working.
- Emails are scrubbed against `opt_outs` (which gains a `kind` column: `phone` | `email`, default `phone`) so a prior unsubscribe suppresses.

### 6.5 Line-type lookup

Interface `LineTypeLookup { lookup(e164): Promise<{ lineType, carrier? }> }` in `outreach-api/src/lookup/`. First implementation: Twilio Lookup v2 `line_type_intelligence`. Runs as `import.lookup` in batches of 100 with a per-tenant setting `lookupOnImport` (default off; cost is per number). Results write `line_type` and `line_type_checked_at`. Later sub-projects require `mobile` before texting.

### 6.6 Report

`import.report` writes `list_imports.stats` and `lists.counts`, uploads the per-row error log (CSV of row number, reason) to object storage, sets `status = done`, and posts a summary to the alert webhook if any rows were held or the import failed.

---

## 7. Suppression additions

- **`litigator_entries`**: `org_id uuid null` (null = platform-global), `e164 text`, `source text`, `loaded_at timestamptz`. Unique index on `(coalesce(org_id, '00000000-0000-0000-0000-000000000000'::uuid), e164)`. Loaded by an admin upload in the web app (tenant rows) or `scripts/load-litigators.ts` (global rows). Vendor formats are CSV of numbers; loader normalizes to E.164.
- **`opt_outs`** gains `kind text not null default 'phone'` and `channel_source text` (`voice` | `sms` | `email` | `manual`), so an unsubscribe by email and a STOP by text are recorded with provenance. Existing readers are unaffected (they filter on `e164`).
- Web app: view, search, add, and bulk-load for opt-outs, blocks, DNC, and litigator files; every manual change writes an audit row (`suppression_audit`: who, what, when, reason).

---

## 8. Firewall changes

### 8.1 Input and applicability

`FirewallInput` gains:
- `channel: 'voice' | 'sms' | 'email'` (default `'voice'`),
- `actor: 'human' | 'ai'` (default `'human'`).

Defaults keep every existing `cti-api` caller unchanged. Each gate module declares `channels: ReadonlySet<Channel>`; the aggregator runs only applicable gates and records skipped gates as `severity: 'info'` with reason `NOT_APPLICABLE_FOR_CHANNEL` so the audit shows what was not evaluated. Applicability in Foundation:

| Gate | voice | sms | email |
|---|---|---|---|
| phone_parse, opt_out, blocklist, litigator, federal_dnc, rnd, campaign, attempt_limit, customer_limit, calling_hours, state_rules, state_registration, consent_record | ✓ | ✓ | opt_out, blocklist, campaign, attempt_limit only |
| outbound_number, warmup, velocity, neighbor_spoof, attestation, answer_rate, engagement, recording_consent | ✓ | outbound_number, warmup, velocity | — |
| ai_voice_consent | ✓ (actor = ai) | — | — |

Email-specific and SMS-specific gates (10DLC registered, mobile line type, texting quiet hours, per-number daily send cap, domain health) are defined in their sub-projects; the structure above is what they plug into.

### 8.2 New gates

- **`litigator`** — BLOCK, reason `LITIGATOR_LISTED`, when the destination matches `litigator_entries` (global or tenant rows). All channels.
- **`ai_voice_consent`** — when `channel = 'voice'` and `actor = 'ai'`: BLOCK, reason `AI_VOICE_CONSENT_REQUIRED`, unless a non-revoked `consent_records` row exists for the destination in this tenant. This is the program's legal decision expressed in code; it cannot be disabled by campaign config.

### 8.3 Cross-channel attempt view

A SQL view `contact_attempts (org_id, to_e164, from_e164, channel, actor_user_id, campaign_key, attempted_at)` defined over `calls` (outbound) in Foundation, extended by `union all` in sub-projects 2 and 5. `tallyAttempts` and `customerAttemptCounts` read the view instead of `calls`. Unit tests for the two functions are unchanged in intent; integration tests prove the view's rows.

### 8.4 Audit

`pre_call_audits` gains `channel` and `actor` columns (defaults `voice`, `human`) so historical rows remain valid.

---

## 9. CRM delivery

### 9.1 Tables

| Table | Key columns |
|---|---|
| `lead_qualifications` | `person_id`, `property_id`, `contact_point_id` (primary reach), `score int` 0–100, `rubric jsonb`, `summary text`, `qualified_by_user_id` (human or AI Agent), `source` (`manual` \| `ai`), `qualified_at`. |
| `crm_connections` | `kind` (`webhook` \| `salesforce`), `name`, `config_enc text` (AES-256-GCM via `packages/auth` `crypto.ts`: webhook URL and secret, or Salesforce instance URL and refresh token), `field_mapping jsonb`, `status` (`active` \| `paused` \| `error`), `last_success_at`, `last_error`. |
| `crm_deliveries` | `qualification_id`, `connection_id`, `status` (`pending` \| `in_flight` \| `succeeded` \| `failed` \| `dead`), `attempts int`, `next_attempt_at`, `external_id`, `last_error`, `payload_version text` (`lead.qualified.v1`), `delivered_at`. Unique `(qualification_id, connection_id)`. |

### 9.2 Trigger

Creating a `lead_qualifications` row (in Foundation: `POST /contacts/:personId/qualify` from the web app's rubric form) inserts one `crm_deliveries` row per active connection in the same transaction and enqueues `delivery.send` for each. Later sub-projects insert qualifications from the AI; the delivery path does not change.

### 9.3 Rubric (Foundation default)

`motivation` (category + free text), `timeline` (`asap` | `1_3_months` | `3_6_months` | `6_plus` | `unknown`), `condition` 1–5, `asking_price` (nullable), `owner_confirmed` boolean, `decision_maker` boolean, `notes`. Score is a documented heuristic in `packages/contracts` (so web and API agree); AI scoring replaces it later without changing the payload.

### 9.4 Worker

`delivery.send` handler: load delivery + connection, mark `in_flight`, build the payload, dispatch by `kind`, on success mark `succeeded` with `external_id`, on failure increment `attempts`, set `next_attempt_at` per the schedule, and re-enqueue. Schedule: 1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h (8 attempts). After the last failure: `status = dead`, alert webhook, visible in the Outbox screen with a "retry now" action. Idempotent: the unique index plus the `in_flight` claim (`update … where status in ('pending','failed') returning`) prevents double sends.

### 9.5 Webhook contract — `lead.qualified` v1

- `POST` to the connection URL, JSON body, 10-second timeout, success on any 2xx.
- Headers: `Content-Type: application/json`, `X-Outreach-Event: lead.qualified`, `X-Outreach-Delivery-Id`, `X-Outreach-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the connection secret>`. Receivers reject when `|now − t| > 300s`.
- Body: `{ version: "lead.qualified.v1", deliveryId, tenant: { id, slug }, qualification: { id, score, rubric, summary, qualifiedAt, qualifiedBy: { kind: "human"|"ai", name } }, person: { id, firstName, lastName, isEntity, mailingAddress, timezone }, property: { id, address, apn, county, attributes }, contactPoints: [{ id, kind, value, lineType, status }], consent: [{ type, capturedAt, source }], lists: [{ id, name, kind }], links: { person: <outreach-web URL> } }`.
- Optional response body `{ "externalId": "…" }` is stored on the delivery.
- Schema lives in `packages/contracts/lead-qualified.v1.schema.json` with a contract test that the builder's output validates.

### 9.6 Salesforce adapter

- Connection setup: an admin runs an OAuth flow (`packages/salesforce` OAuth helpers with a `crm_connections` storage target) as the tenant's integration user. Tokens are encrypted at rest as today.
- Default object: **Lead**. Field mapping (editable in `field_mapping`): `FirstName`, `LastName` (entity name → `Company`, else `Company = "Individual"`), `Phone`/`MobilePhone` (by line type), `Email`, `Street`/`City`/`State`/`PostalCode` (property situs by default; mailing selectable), `LeadSource` = list kind, `Description` = summary + rubric. Custom fields written when present in the org and folded into `Description` when absent — the same graceful pattern the CTI's Salesforce client uses for Task fields: property address fields, `Consent_Source__c`, `Consent_Timestamp__c`, `DNC_Status__c`, and `Outreach_Qualification_Id__c`.
- Idempotency: if `Outreach_Qualification_Id__c` exists in the org, query it before create; else rely on the outbox.
- Tenant may set `field_mapping.object = 'Opportunity'`; then create the Opportunity plus a Contact with a primary Contact Role, mirroring how the dialer resolves numbers today.
- Uses `packages/salesforce` for HTTP, retries, and the `SalesforceUnauthorizedError` refresh path.

---

## 10. Web app scope

Routes in `outreach-web`, all behind the session guard; admin-only routes marked.

- `/sign-in` → AuthKit redirect; `/auth/callback` completes the session.
- `/` dashboard: counts per list, recent imports, delivery health, jobs with failures (admin).
- `/lists` (admin): create list, upload file, mapping confirmation screen with the proposal and sample rows, import progress (polling `GET /imports/:id`), report with download of the error log.
- `/contacts`: search persons and properties; person page with linked properties, contact points with status and reason, list memberships, timeline (imports, scrub events, qualifications, deliveries), and the **Mark qualified** rubric form.
- `/suppression` (admin): tabs for opt-outs, blocks, DNC, litigators; search, add, bulk upload, audit list.
- `/connections` (admin): add webhook (shows secret once), connect Salesforce (OAuth), test delivery button (sends a synthetic `lead.qualified` flagged `test: true`), outbox table with status, attempts, last error, retry.
- `/team` (admin): members, invite by email (through WorkOS), toggle admin.
- Tenant switcher in the header for super admins.

Design system: Tailwind + shadcn/ui, dark and light following system. Not shared with the softphone (different surface).

---

## 11. Error handling

- **Fail closed on compliance.** A scrub that cannot complete holds rows. A firewall evaluation that throws returns `BLOCK` with reason `FIREWALL_ERROR` and still writes an audit row. A lookup failure leaves `line_type = unknown` and never marks a number contactable by text.
- **Jobs.** Every handler is idempotent on its input row; retries are safe. Final failures alert (existing `alerts.ts` → `ALERT_WEBHOOK_URL`) and appear in the Jobs panel with the error and a retry action.
- **Deliveries.** Retry schedule and dead-letter per §9.4. Connection `status = error` after three consecutive dead deliveries; admins see it on the Connections page.
- **API.** Zod on every request body and query. 400 with field errors, 401/403 for auth, 404 scoped to tenant (never reveal another tenant's ids), 409 on conflicts, 429 from the rate limiter. Error bodies are `{ error, code, requestId }`; stack traces never leave the server.
- **Logging.** pino, structured, every log line carries `orgId` and `requestId`; redaction list extends to `x-outreach-signature`, WorkOS codes, and connection secrets.
- **User-facing.** Import and delivery failures explain the cause and the next action in plain language.

---

## 12. Testing

Conventions match `cti-api` (vitest, fake-DB injection via `vi.mock`, TS strict) plus a real-database lane.

- **Unit (fake DB):** each firewall gate module; applicability filtering and `NOT_APPLICABLE_FOR_CHANNEL` recording; `ai_voice_consent` and `litigator` gates; phone/email/address/name normalizers; dedupe rule functions; score heuristic; webhook payload builder and HMAC signing; mapping proposer prompt parsing (Claude mocked); WorkOS exchange (SDK mocked); session refusal for service users.
- **Integration (real Postgres, `DATABASE_URL_TEST`, throwaway DB in CI):** migration runner incl. concurrent-run serialization; the full import pipeline on fixture files (PropStream and BatchLeads shaped CSVs, an XLSX, a Latin-1 file, a file with duplicates across lists); dedupe merges and `merge_log`; scrub outcomes incl. forced failure → `pending_scrub`; `contact_attempts` view; outbox claim under concurrency (two workers, one send); tenant isolation across every list endpoint with two seeded tenants; provisioning.
- **Contract:** `lead.qualified.v1` builder output validates against the JSON schema; a fixture receiver verifies the signature.
- **Web:** component tests for the mapping screen, rubric form, outbox table; a smoke test that routes render behind the guard.
- **Regression:** the existing ~10,000 lines of CTI tests must pass unchanged after each extraction commit. `npm run typecheck` and `npm test` at the root run every workspace.
- **Coverage:** 80% floor on `packages/*` and `services/outreach-api` via vitest v8 coverage; CI fails below it.

---

## 13. Rollout

Order is chosen so the reps never notice. Foundation is one spec but several implementation plans; the natural plan boundaries are steps 1–2 (extraction and tenancy), steps 3–4 (product skeleton, lead store, import), and steps 5–6 (firewall and delivery), with step 7 closing the last plan.

1. **Extraction** — `packages/db`, `packages/phone`, `packages/auth`, `packages/firewall` (split), `packages/contracts` (empty shell). Pure refactor; CTI tests green; deploy `cti-api` alone and observe a full business day.
2. **Tenancy migration** — organizations/users columns, per-tenant email uniqueness, GG Homes backfill (slug, timezone, AI Agent user). Deploy `cti-api`. No visible change.
3. **`outreach-api` + `outreach-web` skeleton** — health, WorkOS sign-in, team page, tenant switcher. New Railway service with its own domain. Invite our team.
4. **Lead store + import pipeline + suppression** — tables, jobs, object storage, lists/contacts/suppression screens, litigator loader.
5. **Firewall channel/actor** — inputs, applicability, `litigator` and `ai_voice_consent` gates, `contact_attempts` view, audit columns. Deploy both services.
6. **CRM delivery** — extract `packages/salesforce`; tables, worker, webhook, Salesforce adapter, connections and outbox screens, manual qualify.
7. **Acceptance run** — import a real list, review the report, qualify one contact, confirm the Lead in Salesforce and a webhook delivery to a test receiver. Softphone smoke test.

---

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Extraction regressions in the reps' dialer | One package per commit, full suite green each commit, deploy extraction alone first, one business day of observation before step 2. |
| Two services running migrations on one push | Advisory lock in the runner; idempotent SQL; `preDeployCommand` in both services. |
| WorkOS as a hard dependency for product sign-in | Softphone sign-in is unaffected. Sessions are ours, so an AuthKit outage blocks new sign-ins only. |
| Import performance at 500k rows | Streamed parsing, chunked `on conflict` inserts, per-step jobs; measured in the integration lane with a 100k fixture. |
| Address normalization quality creating duplicate properties | APN-first identity where present; `merge_log` makes later re-dedupe possible; conservative person matching avoids false merges. |
| Salesforce API limits during bulk qualification | Outbox is rate-limited per connection (configurable, default 60/min); backoff on `REQUEST_LIMIT_EXCEEDED`. |
| Litigator and DNC feeds licensed per tenant | Tenant rows stay tenant-scoped; only our own licensed global set is platform-wide. |

---

## 15. Out of scope (deferred)

Campaigns, sequences, any sending, threads, inbox, AI conversation, SMS number pool, 10DLC registration, agent presence, dialer changes, email domains, skip tracing, geocoding, billing, role table, SCIM, moving `cti-api` loops to pg-boss.

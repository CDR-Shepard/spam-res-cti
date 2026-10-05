-- =============================================================================
-- 0051_outreach_campaigns.sql — AI outreach from Salesforce campaigns, phase 1
-- (design: docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md §9;
-- plans: docs/superpowers/plans/2026-10-04-sf-campaigns-1a-dry-run.md, -1b-live-calls.md).
--
-- Every table carries org_id (FK organizations, ON DELETE CASCADE). Foreign
-- keys live HERE ONLY: the Drizzle mirror (packages/db/src/schema-outreach.ts)
-- declares none, so it never imports schema.ts (no ESM import cycle).
-- Status-like columns are text + a named CHECK, house style (0043, 0044); the
-- allowed values are pinned against the schema-outreach.ts constants by
-- migration-0051.test.ts.
--
-- crm_connections      One company-wide Salesforce connection per tenant
--                      (Integration user). Tokens encrypted with
--                      TOKEN_ENCRYPTION_KEY (@cti/auth encryptString).
--   status             connected | broken (a refresh failed; campaigns pause).
--   field_map          FieldMap (@cti/contracts crm.ts): notes, phone, email,
--                      and suppression fields per object.
--   (org_id, provider) FULL unique index — the connect upserts ON CONFLICT.
-- crm_oauth_states     PKCE state for the connect flow. 10-minute TTL enforced
--                      in code; the callback deletes its row.
-- campaigns            A list view or pasted SOQL of Leads or Opportunities.
--   soql               The membership query: pasted text, or the list view's
--                      described SOQL (re-described on every refresh).
--   status             draft → dry_run → active ⇄ paused → archived.
--   pause_reason       manual | crm_broken | ai_budget | kill_switch. No CHECK:
--                      later phases add reasons (carrier filtering).
--   touch_days         Days after enrollment of each touch; default 6 touches
--                      over 14 days.
--   approvals_remaining  AI-written messages an admin still approves (phase 2).
-- crm_records          One row per Salesforce record per tenant. Notes text is
--                      never stored — triage fetches and discards it.
--   phones             [{ field, e164 }] in field-map order.
--   triage_needed      Set when the record is new or changed; the triage tick
--                      clears it. Partial index: the tick scans only these.
--   triage_attempted_at  When the triage tick last claimed the record. The tick
--                      claims rows by setting it and skips rows claimed in the last
--                      30 minutes, so a record that keeps failing cannot hog every
--                      batch. A sync that changes the record resets it to NULL.
--   (org_id, sf_record_id) FULL unique index — upserts ON CONFLICT.
-- record_triage        One row per model call: the notes fingerprint, model,
--                      zod-validated TriageResult, and token counts.
-- campaign_enrollments One person in one campaign.
--   status             active | conversing | needs_review | handed_off |
--                      completed | exited.
--   review_*/flagged_at  The AI's do-not-contact flag awaiting the owner.
--   (campaign_id, crm_record_id) FULL unique index.
-- enrollment_contact_keys  Every E.164 and lowercased email of an enrollment.
--   enrollment_contact_keys_active_unique  PARTIAL unique (org_id, key) WHERE
--                      active: one active campaign per person. Exiting an
--                      enrollment sets active = false, freeing the person.
--                      An ON CONFLICT ("org_id", "key") target must repeat
--                      WHERE active (else 42P10); enrollRecords catches the
--                      unique violation (23505) instead.
-- touches              One planned/sent touch of an enrollment.
--   status             planned | held | queued | dialing | sent | failed | skipped.
--   dialer_session_id  The CTI power-dial run a rep_call touch went into (no
--                      FK: dialer cleanup must not cascade into touch history).
--   gate_audit         [GateStep] — every planner rule's verdict.
--   (enrollment_id, seq) FULL unique index — the planner inserts ON CONFLICT
--                      DO NOTHING.
-- sf_writes            Salesforce write outbox (drained in plan 1B).
--   kind               task | consent | do_not_contact.
--   status             pending | done | failed.
-- ai_usage_days        AI spend per tenant per UTC day, in micro-dollars.
--   day                YYYY-MM-DD (UTC), CHECKed like dialer_time_tasks.day.
--
-- dialer_sessions.campaign_id  The campaign a power-dial run was built from
--                      (plan 1B). Nullable, no FK: a run outlives its campaign.
-- =============================================================================

-- organizations, users and dialer_sessions are hot tables (FKs and the ALTER
-- lock them): fail fast rather than queue behind a conflicting lock (0045's
-- rule; migrate-runner wraps each file in one transaction).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "crm_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "provider" text NOT NULL DEFAULT 'salesforce',
  "instance_url" text NOT NULL,
  "sf_org_id" text NOT NULL,
  "sf_user_id" text NOT NULL,
  "sf_username" text,
  "access_token_enc" text NOT NULL,
  "refresh_token_enc" text,
  "status" text NOT NULL DEFAULT 'connected',
  "last_error" text,
  "field_map" jsonb,
  "connected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "connected_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "crm_connections_provider_check" CHECK ("provider" IN ('salesforce')),
  CONSTRAINT "crm_connections_status_check" CHECK ("status" IN ('connected','broken'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_connections_org_provider_unique" ON "crm_connections" ("org_id", "provider");

CREATE TABLE IF NOT EXISTS "crm_oauth_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL,
  "state" text NOT NULL,
  "code_verifier" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_oauth_states_state_unique" ON "crm_oauth_states" ("state");

CREATE TABLE IF NOT EXISTS "campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "sf_object" text NOT NULL,
  "source_kind" text NOT NULL,
  "list_view_id" text,
  "soql" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "pause_reason" text,
  "paused_from" text,
  "refresh_minutes" integer NOT NULL DEFAULT 240,
  "touch_days" integer[] NOT NULL DEFAULT '{0,1,3,6,10,14}',
  "approvals_remaining" integer NOT NULL DEFAULT 50,
  "playbook" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "member_count" integer NOT NULL DEFAULT 0,
  "last_refreshed_at" timestamptz,
  "last_refresh_error" text,
  "refresh_started_at" timestamptz,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "campaigns_sf_object_check" CHECK ("sf_object" IN ('Lead','Opportunity')),
  CONSTRAINT "campaigns_source_kind_check" CHECK ("source_kind" IN ('list_view','soql')),
  CONSTRAINT "campaigns_status_check" CHECK ("status" IN ('draft','dry_run','active','paused','archived')),
  CONSTRAINT "campaigns_paused_from_check" CHECK ("paused_from" IN ('dry_run','active'))
);

CREATE INDEX IF NOT EXISTS "campaigns_org_status_idx" ON "campaigns" ("org_id", "status");

CREATE TABLE IF NOT EXISTS "crm_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sf_object" text NOT NULL,
  "sf_record_id" text NOT NULL,
  "name" text,
  "owner_sf_user_id" text,
  "owner_name" text,
  "lead_manager_sf_user_id" text,
  "phones" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "email" text,
  "state" text,
  "web_form_source" text,
  "consent_ai_call" boolean NOT NULL DEFAULT false,
  "consent_source" text,
  "consent_at" timestamptz,
  "sf_do_not_call" boolean NOT NULL DEFAULT false,
  "sf_email_opt_out" boolean NOT NULL DEFAULT false,
  "skip_on_dialer" boolean NOT NULL DEFAULT false,
  "is_closed" boolean NOT NULL DEFAULT false,
  "notes_hash" text,
  "triage_needed" boolean NOT NULL DEFAULT true,
  "triage_attempted_at" timestamptz,
  "sf_last_modified_at" timestamptz,
  "synced_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "crm_records_org_record_unique" ON "crm_records" ("org_id", "sf_record_id");

-- The triage tick's scan: only records still owed a triage, oldest sync first per tenant.
CREATE INDEX IF NOT EXISTS "crm_records_triage_needed_idx" ON "crm_records" ("org_id", "synced_at") WHERE "triage_needed";

CREATE TABLE IF NOT EXISTS "record_triage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE,
  "notes_hash" text NOT NULL,
  "model" text NOT NULL,
  "result" jsonb NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- Latest triage per record.
CREATE INDEX IF NOT EXISTS "record_triage_record_created_idx" ON "record_triage" ("crm_record_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "campaign_enrollments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'active',
  "exit_reason" text,
  "review_category" text,
  "review_quote" text,
  "flagged_at" timestamptz,
  "next_touch_at" timestamptz,
  "touches_done" integer NOT NULL DEFAULT 0,
  "enrolled_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_enrollments_status_check" CHECK ("status" IN ('active','conversing','needs_review','handed_off','completed','exited'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "campaign_enrollments_campaign_record_unique" ON "campaign_enrollments" ("campaign_id", "crm_record_id");

-- The planner's scan: active enrollments whose next touch is due.
CREATE INDEX IF NOT EXISTS "campaign_enrollments_org_status_next_idx" ON "campaign_enrollments" ("org_id", "status", "next_touch_at");

CREATE TABLE IF NOT EXISTS "enrollment_contact_keys" (
  "enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  CONSTRAINT "enrollment_contact_keys_pkey" PRIMARY KEY ("enrollment_id", "key")
);

-- One active campaign per person. PARTIAL on purpose: an exited or completed
-- enrollment's keys go inactive and stop blocking. An ON CONFLICT target on it
-- must repeat WHERE active (else 42P10); enrollRecords catches the 23505.
CREATE UNIQUE INDEX IF NOT EXISTS "enrollment_contact_keys_active_unique" ON "enrollment_contact_keys" ("org_id", "key") WHERE "active";

CREATE TABLE IF NOT EXISTS "touches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE,
  "seq" integer NOT NULL,
  "channel" text NOT NULL,
  "status" text NOT NULL,
  "due_at" timestamptz NOT NULL,
  "sent_at" timestamptz,
  "dialer_session_id" uuid,
  "claimed_at" timestamptz,
  "outcome" text,
  "provider_ref" text,
  "body" text,
  "gate_audit" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "skip_reason" text,
  "counted_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "touches_channel_check" CHECK ("channel" IN ('ai_call','rep_call','sms','email')),
  CONSTRAINT "touches_status_check" CHECK ("status" IN ('planned','held','queued','dialing','sent','failed','skipped'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "touches_enrollment_seq_unique" ON "touches" ("enrollment_id", "seq");

-- Due-touch scans (promote queued calls, campaign call queue).
CREATE INDEX IF NOT EXISTS "touches_org_status_due_idx" ON "touches" ("org_id", "status", "due_at");

-- Reconciliation: a dialer run's touches.
CREATE INDEX IF NOT EXISTS "touches_dialer_session_idx" ON "touches" ("dialer_session_id") WHERE "dialer_session_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "sf_writes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "sf_object" text NOT NULL,
  "sf_record_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "first_failed_at" timestamptz,
  "alerted_at" timestamptz,
  "done_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sf_writes_kind_check" CHECK ("kind" IN ('task','consent','do_not_contact')),
  CONSTRAINT "sf_writes_status_check" CHECK ("status" IN ('pending','done','failed'))
);

-- The outbox drain's scan: pending rows whose next_attempt_at has passed.
CREATE INDEX IF NOT EXISTS "sf_writes_status_next_idx" ON "sf_writes" ("status", "next_attempt_at");

CREATE TABLE IF NOT EXISTS "ai_usage_days" (
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "day" text NOT NULL,
  "cost_micros" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_usage_days_pkey" PRIMARY KEY ("org_id", "day"),
  CONSTRAINT "ai_usage_days_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

ALTER TABLE "dialer_sessions" ADD COLUMN IF NOT EXISTS "campaign_id" uuid;

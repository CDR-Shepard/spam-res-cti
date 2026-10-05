-- =============================================================================
-- 0052_ai_call_campaigns.sql — AI call campaigns (plan 1C:
-- docs/superpowers/plans/2026-10-05-ai-call-campaigns-1c.md).
--
-- campaigns.mode            sequence (plan 1A: triage + touch planner) | ai_call
--                           (selected leads, research, call plan, human approval,
--                           AI voice call through @cti/api). Fixed at creation.
-- campaign_selections       The Salesforce Ids an admin ticked in the lead picker.
--                           An ai_call campaign enrolls ONLY selected members.
-- campaign_enrollments
--   call_stage              NULL for sequence campaigns. research → review →
--                           approved → queued → done.
--   call_prepare_attempted_at  Claim of the call.prepare tick; 30-minute backoff.
--   call_prepare_error      Last research/plan failure, shown on the card.
-- call_research             One row per research run (versioned per enrollment):
--                           the capped Salesforce snapshot and a per-source status.
-- call_plans                One row per plan version. At most one current plan
--                           (proposed | approved) per enrollment (partial unique).
--   source                  model (Claude) | edit (a person's edit).
--   dnc_flagged             The model raised do-not-contact: the person was held
--                           in Needs Review (record_triage row, 1A dnc-hold).
-- touches (channel ai_call)
--   ai_call_id              The ai_calls row (0050) of the placed call.
--   call_plan_id            The approved plan the call carries.
--   requested_by            users.id passed to @cti/api as the requesting user.
--   attempts                Triggers sent to @cti/api for this touch.
--   trigger_key             Idempotency key of the trigger in flight; kept across
--                           transport failures so a resend is the SAME request.
--   last_block_reason       Why the last trigger was refused or failed.
-- =============================================================================

-- The ALTERs below lock campaigns, campaign_enrollments and touches, and the new foreign
-- keys lock their targets (organizations, users, campaigns, campaign_enrollments,
-- crm_records, ai_calls): fail fast rather than queue behind a conflicting lock (0045's
-- rule; migrate-runner wraps each file in one transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'sequence' CONSTRAINT "campaigns_mode_check" CHECK ("mode" IN ('sequence', 'ai_call'));

CREATE TABLE IF NOT EXISTS "campaign_selections" (
  "campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "sf_record_id" text NOT NULL,
  "selected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "selected_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_selections_pkey" PRIMARY KEY ("campaign_id", "sf_record_id")
);

ALTER TABLE "campaign_enrollments"
  ADD COLUMN IF NOT EXISTS "call_stage" text CONSTRAINT "campaign_enrollments_call_stage_check" CHECK ("call_stage" IN ('research', 'review', 'approved', 'queued', 'done')),
  ADD COLUMN IF NOT EXISTS "call_prepare_attempted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "call_prepare_error" text;

CREATE INDEX IF NOT EXISTS "campaign_enrollments_call_stage_idx" ON "campaign_enrollments" ("call_stage", "org_id") WHERE "call_stage" IN ('research', 'approved');

CREATE TABLE IF NOT EXISTS "call_research" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE,
  "crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "snapshot" jsonb NOT NULL,
  "sources" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "size_chars" integer NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_research_enrollment_version_unique" ON "call_research" ("enrollment_id", "version");

CREATE TABLE IF NOT EXISTS "call_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE,
  "research_id" uuid NOT NULL REFERENCES "call_research"("id") ON DELETE CASCADE,
  "version" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "source" text NOT NULL,
  "model" text,
  "plan" jsonb NOT NULL,
  "dnc_flagged" boolean NOT NULL DEFAULT false,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "call_plans_status_check" CHECK ("status" IN ('proposed', 'approved', 'rejected', 'superseded')),
  CONSTRAINT "call_plans_source_check" CHECK ("source" IN ('model', 'edit'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "call_plans_enrollment_version_unique" ON "call_plans" ("enrollment_id", "version");

-- PARTIAL: one current plan per enrollment. Writers supersede the old row and
-- insert the new one in ONE transaction (call-plans/store.ts).
CREATE UNIQUE INDEX IF NOT EXISTS "call_plans_current_unique" ON "call_plans" ("enrollment_id") WHERE "status" IN ('proposed', 'approved');

ALTER TABLE "touches"
  ADD COLUMN IF NOT EXISTS "ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "call_plan_id" uuid REFERENCES "call_plans"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "trigger_key" text,
  ADD COLUMN IF NOT EXISTS "last_block_reason" text;

CREATE INDEX IF NOT EXISTS "touches_ai_call_idx" ON "touches" ("ai_call_id") WHERE "ai_call_id" IS NOT NULL;

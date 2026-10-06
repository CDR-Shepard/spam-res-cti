-- =============================================================================
-- 0058_ai_record_tests.sql — Test a record (plan 1E:
-- docs/superpowers/plans/2026-10-06-ai-call-1e.md, spec
-- docs/superpowers/specs/2026-10-06-ai-call-test-a-record-design.md §6).
--
-- ai_record_tests       One row per preview: an admin pasted a Salesforce Lead
--                       or Opportunity Id and outreach-api ran research → call
--                       plan → agent text → appointment times for it. Admin-only.
--                       Nothing here is a campaign: no enrollment, no touch, no
--                       call_plans or crm_records row, and never a Salesforce write.
--   status              running → ready | failed. A row left running (the process
--                       restarted mid-preview) READS as failed: interrupted after
--                       6 minutes; nothing rewrites it.
--   error               A short code (not_found, salesforce_error, not_connected,
--                       plan_failed, timeout).
--   plan_text           The exact text the voice agent would get; null when the
--                       plan text check refused it (plan_text_issues says why).
-- ai_record_test_calls  One row per test call run from a preview. Never a touch.
--                       The mode CHECK keeps a phone call's number and a browser
--                       call's client identity apart: exactly one is set.
-- =============================================================================

-- The foreign keys lock organizations, users and ai_calls: fail fast rather than
-- queue behind a conflicting lock (0045's rule; migrate-runner wraps each file in
-- one transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ai_record_tests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "sf_object" text NOT NULL,
  "sf_record_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "error" text,
  "name" text,
  "research" jsonb,
  "plan" jsonb,
  "plan_text" text,
  "plan_text_issues" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "slots" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "offer_note" text,
  "owner_sf_user_id" text,
  "model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "cost_micros" bigint NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "ai_record_tests_sf_object_check" CHECK ("sf_object" IN ('Lead', 'Opportunity')),
  CONSTRAINT "ai_record_tests_status_check" CHECK ("status" IN ('running', 'ready', 'failed'))
);
CREATE INDEX IF NOT EXISTS "ai_record_tests_org_created_idx" ON "ai_record_tests" ("org_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ai_record_tests_requester_idx" ON "ai_record_tests" ("requested_by", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "ai_record_test_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "record_test_id" uuid NOT NULL REFERENCES "ai_record_tests"("id") ON DELETE CASCADE,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "mode" text NOT NULL,
  "to_e164" text,
  "client_identity" text,
  "idempotency_key" text NOT NULL,
  "ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL,
  "result" jsonb,
  "dry_run" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_record_test_calls_mode_check" CHECK (
    ("mode" = 'phone' AND "to_e164" IS NOT NULL AND "client_identity" IS NULL)
    OR ("mode" = 'browser' AND "client_identity" IS NOT NULL AND "to_e164" IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS "ai_record_test_calls_key_unique" ON "ai_record_test_calls" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "ai_record_test_calls_test_idx" ON "ai_record_test_calls" ("record_test_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "ai_record_test_calls_requester_idx" ON "ai_record_test_calls" ("requested_by", "created_at" DESC);

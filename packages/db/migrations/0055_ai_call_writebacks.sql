-- =============================================================================
-- 0055_ai_call_writebacks.sql — Salesforce write-back after AI calls, and
-- practice calls (plan 1D:
-- docs/superpowers/plans/2026-10-06-ai-call-context-booking-writeback-1d.md).
--
-- ai_call_writebacks   One row per real (non-test) finished AI call: the
--                      multi-step job outreach-api runs to write the call's
--                      results back to Salesforce through the tenant's
--                      integration connection. Unique per ai_call_id.
--   sf_object / sf_record_id   ALWAYS the record the call was about (Lead or
--                      Opportunity), never rewritten.
--   converted_opportunity_id / converted_account_id / converted_contact_id
--                      Set the moment Salesforce answers a Lead conversion
--                      (SOAP convertLead). Once set, every later step (plan,
--                      Event, fields, Task, Chatter) targets
--                      converted_opportunity_id, and the Lead is never
--                      converted twice.
--   status             pending → running → done | partial | failed | skipped.
--   attempts / next_attempt_at / locked_until   The tick's claim and backoff.
--   plan               The write plan, frozen the first time it is computed so
--                      a retry never re-decides against values the write-back
--                      itself wrote.
--   steps              Per-step state ({ convert, event, fields, task, chatter }).
--   sf_event_id / sf_task_id / sf_feed_item_id   What the write-back created.
--   model / input_tokens / output_tokens   The mapping model's spend.
-- ai_practice_calls    One row per practice call: an admin rings their own test
--                      number with a lead's real record and current plan. Never
--                      books, converts or writes to Salesforce.
-- =============================================================================

-- The foreign keys lock organizations, users, ai_calls, touches, campaigns,
-- campaign_enrollments and call_plans: fail fast rather than queue behind a
-- conflicting lock (0045's rule; migrate-runner wraps each file in one
-- transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ai_call_writebacks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "ai_call_id" uuid NOT NULL REFERENCES "ai_calls"("id") ON DELETE CASCADE,
  "touch_id" uuid REFERENCES "touches"("id") ON DELETE SET NULL,
  "enrollment_id" uuid REFERENCES "campaign_enrollments"("id") ON DELETE SET NULL,
  "sf_object" text NOT NULL,
  "sf_record_id" text NOT NULL,
  "outcome" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "locked_until" timestamptz,
  "plan" jsonb,
  "steps" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sf_event_id" text,
  "sf_task_id" text,
  "sf_feed_item_id" text,
  "converted_opportunity_id" text,
  "converted_account_id" text,
  "converted_contact_id" text,
  "model" text,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "ai_call_writebacks_sf_object_check" CHECK ("sf_object" IN ('Lead', 'Opportunity')),
  CONSTRAINT "ai_call_writebacks_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'partial', 'failed', 'skipped'))
);

-- One write-back per AI call: enqueueing is idempotent (ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX IF NOT EXISTS "ai_call_writebacks_ai_call_unique" ON "ai_call_writebacks" ("ai_call_id");

-- The ai_call.writeback tick's scan: due rows still to run (or whose lease expired).
CREATE INDEX IF NOT EXISTS "ai_call_writebacks_due_idx" ON "ai_call_writebacks" ("next_attempt_at") WHERE "status" IN ('pending', 'running');

-- CF-1: the created Event/Task ids per record, so the pre-trigger check ignores them.
CREATE INDEX IF NOT EXISTS "ai_call_writebacks_record_idx" ON "ai_call_writebacks" ("org_id", "sf_record_id");

CREATE TABLE IF NOT EXISTS "ai_practice_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE,
  "enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE,
  "call_plan_id" uuid REFERENCES "call_plans"("id") ON DELETE SET NULL,
  "plan_version" integer NOT NULL,
  "ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "to_e164" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

-- The campaign's practice list (latest 20, newest first).
CREATE INDEX IF NOT EXISTS "ai_practice_calls_campaign_idx" ON "ai_practice_calls" ("campaign_id", "created_at" DESC);

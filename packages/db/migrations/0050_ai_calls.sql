-- =============================================================================
-- 0050_ai_calls.sql — AI voice calls (services/cti-api/src/ai-voice).
--
-- ai_calls   One row per outbound AI phone call: who started it, the Salesforce
--            record it targets, the state machine (status), how it ended
--            (outcome), the structured qualification the agent collected, and
--            the text transcript. No call audio is stored.
--   started_by       The rep/admin who pressed the button.
--   handoff_user_id  Who a transfer rings (record owner if mapped, else started_by).
--   sf_object        Lead | Opportunity | Contact; NULL for a test call.
--   status           queued -> ringing -> in_progress -> transferring ->
--                    transferred | completed | failed | blocked.
--   outcome          qualified_transferred, qualified_callback, not_interested,
--                    do_not_call, voicemail, no_answer, busy, failed,
--                    wrong_number, hung_up, transfer_failed, blocked.
--   call_sid         Twilio CallSid; NULL until placed. PARTIAL unique index so
--                    only non-null values collide.
--   transcript       Array of { role: 'agent'|'caller'|'system', text, at }.
--   cti_call_id      The calls row this call produced.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "ai_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "started_by" uuid NOT NULL REFERENCES "users"("id"),
  "handoff_user_id" uuid REFERENCES "users"("id"),
  "sf_object" text,
  "sf_record_id" text,
  "to_e164" text NOT NULL,
  "from_e164" text,
  "is_test" boolean NOT NULL DEFAULT false,
  "status" text NOT NULL DEFAULT 'queued',
  "outcome" text,
  "block_reason" text,
  "call_sid" text,
  "answered_by" text,
  "qualification" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "transcript" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "summary" text,
  "callback_at" timestamptz,
  "sf_task_id" text,
  "cti_call_id" uuid,
  "duration_seconds" integer,
  "started_at" timestamptz,
  "ended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_calls_status_check" CHECK ("status" IN ('queued', 'ringing', 'in_progress', 'transferring', 'transferred', 'completed', 'failed', 'blocked'))
);

CREATE INDEX IF NOT EXISTS "ai_calls_org_created_idx" ON "ai_calls" ("org_id", "created_at" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_calls_call_sid_unique" ON "ai_calls" ("call_sid") WHERE "call_sid" IS NOT NULL;

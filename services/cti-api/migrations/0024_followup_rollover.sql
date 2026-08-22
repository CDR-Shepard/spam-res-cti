-- Follow-up rollover v2: two attempts per record per day, a per-rep daily cap on
-- Follow-up tasks, and queued (retrying, idempotent) task creation.
--
-- dialer_queue_items: one row = one dial attempt. `attempt` is 1 or 2; a retry is
-- a NEW row for the same record. `primary_number`/`secondary_number` are the
-- record's Mobile/Phone as resolved at creation and are never mutated (the
-- fallback overwrites to_number/fallback_number, so a retry needs these to
-- restore "Mobile first, Phone fallback"). `retry_not_before` is the 5-minute
-- floor on attempt-2 rows.
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 1;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "primary_number" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "secondary_number" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "retry_not_before" timestamptz;

-- Per-org daily cap on Follow-up tasks per rep (counted live in Salesforce).
ALTER TABLE "campaign_configs" ADD COLUMN IF NOT EXISTS "followup_daily_cap" integer NOT NULL DEFAULT 100;

-- Rollover jobs: mirrors salesforce_sync_jobs. Drained single-flight by
-- salesforce/followup-worker.ts. UNIQUE(user_id, record_id, from_date) makes a
-- duplicated Twilio webhook's second enqueue a no-op.
CREATE TABLE IF NOT EXISTS "followup_rollover_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "sf_owner_id" text NOT NULL,
  "session_id" uuid REFERENCES "dialer_sessions"("id") ON DELETE SET NULL,
  "record_id" text NOT NULL,
  "object_type" text NOT NULL,
  "from_date" text NOT NULL,
  "status" "sync_status" NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  "completed_task_id" text,
  "created_task_id" text,
  "target_date" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "followup_rollover_unique" ON "followup_rollover_jobs" ("user_id", "record_id", "from_date");
CREATE INDEX IF NOT EXISTS "followup_rollover_status_idx" ON "followup_rollover_jobs" ("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "followup_rollover_session_idx" ON "followup_rollover_jobs" ("session_id");

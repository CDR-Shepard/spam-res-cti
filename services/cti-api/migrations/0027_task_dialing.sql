-- Task dialing: a power-dial run can be built from a Task list view.
-- dialer_queue_items.record_id stays the PERSON/RECORD dialed (Lead, Contact,
-- or Opportunity id); task_id is the Task the item came from (null on Lead/Opp
-- runs). followup_eligible is decided once at creation from the shared
-- follow-up subject rule — only eligible items roll over on a second miss.
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "task_id" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "followup_eligible" boolean NOT NULL DEFAULT true;
-- The exact task to roll (Task runs); null = search the record (Lead/Opp runs).
ALTER TABLE "followup_rollover_jobs" ADD COLUMN IF NOT EXISTS "source_task_id" text;

-- With source_task_id the rolled unit is the TASK, not the record. A Task run
-- can hold two follow-up tasks for the SAME person; both miss twice on the same
-- day and both enqueue. The old UNIQUE(user_id, record_id, from_date) made the
-- second insert a no-op (the enqueue is ON CONFLICT DO NOTHING), so that task
-- was never rolled and never errored — silently left open past its due date.
-- COALESCE keeps the duplicate-webhook backstop on BOTH paths: adding
-- source_task_id as a plain 4th column would make every Lead/Opp row (NULL)
-- distinct from every other, since a unique index treats NULLs as distinct.
-- Widening only — every pair unique under the old key is unique under this one.
CREATE UNIQUE INDEX IF NOT EXISTS "followup_rollover_source_unique"
  ON "followup_rollover_jobs" ("user_id", (COALESCE("source_task_id", "record_id")), "from_date");
DROP INDEX IF EXISTS "followup_rollover_unique";

-- The dialer half of the shared per-customer attempt count
-- (firewall/index.ts customerAttemptCounts). It CANNOT be counted off
-- dialer_queue_items: the no-answer -> fallback path rewrites to_number /
-- from_number on the very same row (engine.ts handleDialOutcome), so the mobile
-- dial silently disappears from the tally the moment the Phone is tried. One
-- append-only row per successful originate instead — nothing here is ever
-- updated, so an attempt cannot be erased by a later dial of the same item.
--
-- No FK to dialer_sessions/dialer_queue_items on purpose: those rows cascade on
-- session delete, and a compliance tally must outlive the run it came from.
CREATE TABLE IF NOT EXISTS "dialer_dial_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "to_number" text NOT NULL,
  "from_number" text NOT NULL,
  "dialed_at" timestamptz NOT NULL DEFAULT now()
);
-- The count's exact access path: this org, this recipient, inside the window.
CREATE INDEX IF NOT EXISTS "dialer_dial_attempts_target_idx"
  ON "dialer_dial_attempts" ("org_id", "to_number", "dialed_at");

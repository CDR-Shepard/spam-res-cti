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
-- (firewall/index.ts customerAttemptCounts): power-dial contacts to one
-- recipient inside the campaign window. Partial — only a row that was actually
-- originated carries a from_number, and only those count as attempts.
CREATE INDEX IF NOT EXISTS "dialer_queue_items_dialed_target_idx"
  ON "dialer_queue_items" ("to_number", "updated_at")
  WHERE "from_number" IS NOT NULL;

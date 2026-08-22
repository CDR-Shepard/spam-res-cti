-- Task dialing: a power-dial run can be built from a Task list view.
-- dialer_queue_items.record_id stays the PERSON/RECORD dialed (Lead, Contact,
-- or Opportunity id); task_id is the Task the item came from (null on Lead/Opp
-- runs). followup_eligible is decided once at creation from the shared
-- follow-up subject rule — only eligible items roll over on a second miss.
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "task_id" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "followup_eligible" boolean NOT NULL DEFAULT true;
-- The exact task to roll (Task runs); null = search the record (Lead/Opp runs).
ALTER TABLE "followup_rollover_jobs" ADD COLUMN IF NOT EXISTS "source_task_id" text;

-- The dialer half of the shared per-customer attempt count
-- (firewall/index.ts customerAttemptCounts): power-dial contacts to one
-- recipient inside the campaign window. Partial — only a row that was actually
-- originated carries a from_number, and only those count as attempts.
CREATE INDEX IF NOT EXISTS "dialer_queue_items_dialed_target_idx"
  ON "dialer_queue_items" ("to_number", "updated_at")
  WHERE "from_number" IS NOT NULL;

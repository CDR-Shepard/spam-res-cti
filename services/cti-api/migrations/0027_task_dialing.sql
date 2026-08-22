-- Task dialing: a power-dial run can be built from a Task list view.
-- dialer_queue_items.record_id stays the PERSON/RECORD dialed (Lead, Contact,
-- or Opportunity id); task_id is the Task the item came from (null on Lead/Opp
-- runs). followup_eligible is decided once at creation from the shared
-- follow-up subject rule — only eligible items roll over on a second miss.
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "task_id" text;
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "followup_eligible" boolean NOT NULL DEFAULT true;
-- The task the copy is templated from (Task runs); null = search the record
-- (Lead/Opp runs). NOT part of the job key: the rule is ONE rollover per person
-- per day. 0024's UNIQUE(user_id, record_id, from_date) stays the key, so a Task
-- run holding two follow-ups for the SAME person enqueues ONE job (the first
-- miss's source_task_id wins and names the template) — and the worker clears
-- every same-day follow-up on that person while creating exactly one copy.
ALTER TABLE "followup_rollover_jobs" ADD COLUMN IF NOT EXISTS "source_task_id" text;
-- Every task the worker completed for this job: the template plus its same-day
-- siblings. completed_task_id stays the PRIMARY (template) id — rows written by
-- the previous deploy have only that, and the retry path falls back to it.
ALTER TABLE "followup_rollover_jobs" ADD COLUMN IF NOT EXISTS "completed_task_ids" text[];

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

-- Carry the trailing window over. Without this the per-customer ceiling forgets
-- every power-dial contact made before this deploy and a recipient could be
-- rung past the cap on day one. One row per already-dialed item is all that
-- survives there anyway (the fallback path overwrote the rest — the very loss
-- this table fixes), so this is no worse than what the old count could see.
-- Idempotent via NOT EXISTS: re-running cannot double-count an item.
INSERT INTO "dialer_dial_attempts" ("org_id", "user_id", "session_id", "item_id", "to_number", "from_number", "dialed_at")
SELECT s."org_id", s."user_id", i."session_id", i."id", i."to_number", i."from_number", i."updated_at"
  FROM "dialer_queue_items" i
  JOIN "dialer_sessions" s ON s."id" = i."session_id"
 WHERE i."from_number" IS NOT NULL
   AND i."to_number" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "dialer_dial_attempts" a WHERE a."item_id" = i."id");

-- =============================================================================
-- 0049_dialer_time_tasks.sql — power-dialer time in Salesforce
-- (design: docs/superpowers/specs/2026-10-02-dialer-time-tasks-design.md).
--
-- dialer_time_tasks   One row per (rep, Pacific day): the "Power Dialer Time"
--                     Task salesforce/dialer-time-worker.ts keeps in Salesforce
--                     for that day, and the seconds last written to it. The
--                     number itself is computed from dialer_rep_legs on every
--                     tick; this table only remembers what Salesforce has.
--                     FK-FREE like dialer_rep_legs.
--   day               YYYY-MM-DD, the org's Pacific day.
--   salesforce_task_id NULL until the Task is created or adopted; cleared when
--                     Salesforce says it was deleted, so the next tick recreates it.
--   synced_seconds    The CallDurationInSeconds last written; NULL until then.
--   attempts / next_attempt_at / last_error
--                     Backoff bookkeeping for failed writes (never gives up).
--   (user_id, day)    FULL unique index: the store inserts with a bare
--                     ON CONFLICT DO NOTHING, which a PARTIAL index cannot
--                     arbitrate (42P10).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "dialer_time_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "day" text NOT NULL,
  "salesforce_task_id" text,
  "synced_seconds" integer,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_time_tasks_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_time_tasks_user_day_unique" ON "dialer_time_tasks" ("user_id", "day");

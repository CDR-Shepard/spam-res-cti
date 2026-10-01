-- =============================================================================
-- 0048_talk_time.sql — the talk-time report
-- (design: docs/superpowers/specs/2026-10-01-talk-time-report-design.md).
--
-- calls.talk_seconds  TRUE talk time of a regular call: the customer's
--                     connected line only — the <Dial action>'s
--                     DialCallDuration, or the dialed leg's own CallDuration,
--                     and 0 when it was never answered. Written by
--                     telephony/talk-seconds.ts. calls.duration_seconds is left
--                     exactly as it was: the reputation engine (answer-rate
--                     floor, auto-pause) reads it. NULL on every older row.
--
-- dialer_rep_legs     One row per rep conference leg of the power dialer: how
--                     long the rep's line sat on the dialer (dialing, hold
--                     music and talking all count). Written by
--                     dialer/rep-legs.ts — the join (the voice route), the end
--                     (the leg's status callback, the rejoin route, the run's
--                     end, a newer leg replacing it) — and closed by
--                     dialer/rep-leg-reconcile.ts when every end was missed.
--                     FK-FREE like dialer_connects: report history outlives a
--                     run's cleanup.
--   call_sid          The rep leg. FULL unique index: the join inserts with a
--                     bare ON CONFLICT DO NOTHING, which a PARTIAL index
--                     cannot arbitrate (42P10).
--   ended_at          NULL while the leg is open; stamped once.
--   end_source        rep_left | run_end | replaced | reconciled | fallback.
-- =============================================================================

ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "talk_seconds" integer;

CREATE TABLE IF NOT EXISTS "dialer_rep_legs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "session_id" uuid NOT NULL,
  "call_sid" text NOT NULL,
  "joined_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "end_source" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_rep_legs_end_source_check" CHECK ("end_source" IS NULL OR "end_source" IN ('rep_left','run_end','replaced','reconciled','fallback'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_rep_legs_call_sid_unique" ON "dialer_rep_legs" ("call_sid");
CREATE INDEX IF NOT EXISTS "dialer_rep_legs_org_joined_idx" ON "dialer_rep_legs" ("org_id", "joined_at");

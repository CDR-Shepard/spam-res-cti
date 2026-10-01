-- =============================================================================
-- 0047_dialer_connects.sql — one row per power-dial call bridged to a rep
-- (design: docs/superpowers/specs/2026-10-01-power-dialer-recording-design.md).
--
-- Written by dialer/connect-log.ts right after the engine bridges a human into
-- the rep's room, BEFORE the recording starts, so the recording callback always
-- finds its row. Read by salesforce/dialer-connect-worker.ts, which logs ONE
-- completed Call Task per row and then attaches the public recording link.
--
-- FK-FREE ON PURPOSE (like dialer_dial_attempts): a recording link lives in a
-- Salesforce Task for good, so the row behind it must outlive any run, item,
-- or user cleanup.
--
-- call_sid          The prospect's leg. UNIQUE with a FULL index: a re-delivered
--                   AMD "human" inserts ON CONFLICT DO NOTHING, and a PARTIAL
--                   unique index cannot arbitrate that (42P10).
-- sf_user_id        The rep's Salesforce user id (dialer_sessions.sf_owner_id)
--                   — the ownership gate's caller, without a /users/me call.
-- bridged_at        When the prospect joined the rep. talk_seconds is measured
--                   from here, so the AMD screening seconds are not counted.
-- ended_at          Stamped from the prospect leg's `completed` status callback.
-- recording_state   pending (row written) -> requested | start_failed |
--                   skipped_consent (two-party org, or the lookup failed) |
--                   skipped_switch (TWILIO_RECORD_CALLS / DIALER_RECORDING off).
-- recording_url     Twilio media URL + `.mp3`, from the recording callback.
-- task_state        pending -> created | skipped_not_owner | expired (bridged
--                   > 24 h ago, never logged) | failed (gave up).
-- task_attempts / link_attempts / next_attempt_at
--                   The worker's claim IS its lease: a claim bumps the counter
--                   and pushes next_attempt_at out by that try's backoff.
-- recording_link_synced_at  The link PATCH landed (or was rejected for good).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "dialer_connects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "sf_user_id" text NOT NULL,
  "session_id" uuid NOT NULL,
  "item_id" uuid NOT NULL,
  "call_sid" text NOT NULL,
  "object_type" text NOT NULL,
  "record_id" text NOT NULL,
  "from_number" text NOT NULL,
  "to_number" text NOT NULL,
  "bridged_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "talk_seconds" integer,
  "recording_state" text NOT NULL DEFAULT 'pending',
  "recording_url" text,
  "task_state" text NOT NULL DEFAULT 'pending',
  "task_attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "salesforce_task_id" text,
  "link_attempts" integer NOT NULL DEFAULT 0,
  "recording_link_synced_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_connects_recording_state_check" CHECK ("recording_state" IN ('pending','requested','start_failed','skipped_consent','skipped_switch')),
  CONSTRAINT "dialer_connects_task_state_check" CHECK ("task_state" IN ('pending','created','skipped_not_owner','expired','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_connects_call_sid_unique" ON "dialer_connects" ("call_sid");

-- The worker's scan: pending rows whose next_attempt_at has passed.
CREATE INDEX IF NOT EXISTS "dialer_connects_task_due_idx" ON "dialer_connects" ("task_state", "next_attempt_at");

-- =============================================================================
-- 0044_inbound_messages.sql — texts to our numbers become a Salesforce Task and
-- an email alert for the rep (design: docs/superpowers/specs/
-- 2026-09-25-inbound-texts-design.md, option A).
--
-- One row per inbound text. POST /telephony/twilio/sms inserts it and answers
-- Twilio at once; services/cti-api/src/sms/inbound-text-worker.ts drains it
-- single-flight (match the sender, create the Task once, email the rep once).
--
-- message_sid   Twilio's id. UNIQUE, and a FULL index on purpose: Twilio
--               retries an un-acked webhook and the backfill re-reads history,
--               so the same text arrives twice and the insert is ON CONFLICT DO
--               NOTHING. A PARTIAL unique index cannot arbitrate ON CONFLICT
--               without repeating its predicate (42P10 on every insert).
-- body          The message. Never logged anywhere — only stored here.
-- user_id       The rep it routed to (agent DID owner, else the pool callback
--               rules). NULL = nobody, and the row is 'skipped'.
-- status        pending → in_flight (the worker's claim) → done | failed;
--               skipped when there was no rep. Text + CHECK, house style (0043).
-- sf_task_id    Stamped the moment the Task exists — a retry never creates twice.
-- emailed_at    Stamped the moment the alert is sent — a retry never re-emails.
-- email_skip_reason  Why a live text got its Task but NO alert (the flood guard:
--               one email per rep per sender number per 60 minutes). NULL with
--               emailed_at NULL on a done row means backfill (digest instead).
-- backfill      Pulled from Twilio history, not live: the worker creates the
--               Task but never emails it individually (one digest instead).
-- backfill_batch  One id shared by every row a single backfill-texts.mjs run
--               inserted. NULL for a live text. The worker groups by this id
--               to find a batch whose rows are ALL terminal and send it one
--               digest email (see inbound_text_digests below).
-- received_at   When Twilio received it (live: webhook time; backfill: Twilio's
--               date). Drives the Task's ActivityDate and the email's time.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "inbound_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "message_sid" text NOT NULL,
  "from_e164" text NOT NULL,
  "to_e164" text NOT NULL,
  "body" text NOT NULL DEFAULT '',
  "num_media" integer NOT NULL DEFAULT 0,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "sf_task_id" text,
  "emailed_at" timestamptz,
  "email_skip_reason" text,
  "backfill" boolean NOT NULL DEFAULT false,
  "backfill_batch" uuid,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_messages_status_check" CHECK ("status" IN ('pending','in_flight','done','skipped','failed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "inbound_messages_message_sid_unique" ON "inbound_messages" ("message_sid");

-- The worker's scan: pending rows whose next_attempt_at has passed.
CREATE INDEX IF NOT EXISTS "inbound_messages_status_idx" ON "inbound_messages" ("status", "next_attempt_at");

-- The flood guard's lookup, once per alert: has this rep been emailed about
-- this sender in the last hour?
CREATE INDEX IF NOT EXISTS "inbound_messages_alert_idx" ON "inbound_messages" ("user_id", "from_e164", "emailed_at");

-- The digest's batch scan: every row belonging to one backfill run.
CREATE INDEX IF NOT EXISTS "inbound_messages_backfill_batch_idx" ON "inbound_messages" ("backfill_batch");

-- One row per backfill batch, tracking its ONE digest email through a small
-- state machine (review finding I2 — the original "claim then send" design
-- could lose a digest forever when a Salesforce read failed right after the
-- claim landed, since the claim itself was the only guard). No FK to
-- inbound_messages (a batch, not a single row) — user_id is who it goes to.
--
-- status       pending (queued, not yet tried) -> sending (claimed, a send is
--              in flight) -> sent (done) | failed (gave up) | unknown (the
--              send's outcome could not be determined — NEVER retried, since
--              Salesforce may have sent it anyway; see inbound-text-worker.ts).
-- attempts     bumped on every failed try (read OR send), never on success.
-- next_attempt_at  when this digest becomes claimable again after a retryable
--              failure; also what the claim's compare-and-swap re-checks, the
--              same way a row's claim does.
-- last_error   the most recent failure, redacted (never a quoted text body).
-- sent_at      stamped only on a genuine 'sent' outcome; NULL otherwise.
CREATE TABLE IF NOT EXISTS "inbound_text_digests" (
  "batch_id" uuid PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "inbound_text_digests_status_check" CHECK ("status" IN ('pending','sending','sent','failed','unknown'))
);

-- The worker's two scans: pending digests due for a try, and (via status
-- alone) a stuck-in-'sending' scan for the reaper.
CREATE INDEX IF NOT EXISTS "inbound_text_digests_status_idx" ON "inbound_text_digests" ("status", "next_attempt_at");

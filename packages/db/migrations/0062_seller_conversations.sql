-- =============================================================================
-- 0062_seller_conversations.sql — Sam's email channel (Resend) and one
-- conversation timeline per seller (plan
-- docs/superpowers/plans/2026-10-19-sam-email-timeline.md, Task 1).
--
-- seller_conversations   One row per seller (a crm_records row) per tenant: the
--                        thread every channel hangs from. Calls are NOT copied
--                        into it; they are merged in from ai_calls at read time.
--   practice_user_id     NULL for the real conversation. An admin's practice
--                        email (Sam's email for a real seller, sent to the
--                        admin's own address) gets its own row with the admin's
--                        id, so nothing it does touches the seller's thread, the
--                        suppression list or Salesforce. Two partial unique
--                        indexes keep one real row and one practice row per
--                        admin per record. An ON CONFLICT on either must repeat
--                        the index's column list and its WHERE predicate.
--   token                The opaque reply token: replies go to
--                        sam+<token>@reply.rethinkre.team and the unsubscribe
--                        mailto carries it too. Unique across tenants.
--   handler              sam | person: who is handling the seller. handler_user_id
--                        is the person (SET NULL when the user is removed);
--                        handler_changed_at is when it last changed.
--   status               open | booked | stopped. stop_reason says why Sam may no
--                        longer reach out (opted_out, complained, asked_to_stop,
--                        not_interested); flag_reason / flagged_at say a reply or
--                        draft needs a person (contracts: StopReason, FlagReason).
--                        Neither reason has a CHECK, so a later step can add a
--                        value without a migration.
-- conversation_events    The timeline rows Sam and the team write: emails, hand-
--                        overs, status changes, flags (texts and human touches
--                        later). direction in | out | none; actor sam | seller |
--                        person | system. org_id has no FK of its own: the
--                        conversation's cascade already removes the rows with the
--                        tenant, and the column is kept for tenant-scoped queries.
--   meta                 Free-form detail, e.g. { autoReply: true }.
--   sf_log_status        The Salesforce Task log: pending (the tick owes one) |
--                        done | failed | skipped (nothing to log, the default).
--                        sf_task_id is the Task it created (unique per tenant: one
--                        Task, one event); sf_log_attempts / sf_log_next_at /
--                        sf_log_error are the tick's backoff.
-- email_messages         The outbox and the inbox, one row per email, tied to its
--                        timeline event. direction out | in; purpose first |
--                        reply | holding | practice | inbound; status queued →
--                        sending → sent → delivered | bounced | complained |
--                        failed | canceled, or received for mail in.
--   in_reply_to / references / message_id   The RFC 5322 threading headers (a
--                        reply finds its seller by token first, then by these).
--   resend_id            Resend's id; unique per direction, so a redelivered
--                        webhook cannot make a second row.
--   send_after / attempts / claimed_at / last_error   The send tick's schedule,
--                        claim and retry state (last_error also carries why a
--                        canceled email was not sent).
--   first_attempt_at     When the tick first handed this email to Resend (NULL =
--                        never). Resend remembers the Idempotency-Key for 24
--                        hours from that moment, so an email whose first attempt
--                        is older than 23 hours must never be handed over again:
--                        a repeat would be a second copy. event_id is UNIQUE: one
--                        row per timeline event.
--   handled_at           When the inbound tick finished deciding on a reply.
--   touch_id             The touch that queued the email (the automatic follow-up
--                        rhythm, a later step); SET NULL if the touch goes.
--   requested_by         The person who pressed Send; SET NULL if removed.
-- email_suppressions     Addresses Sam must never email again, per tenant (stored
--                        lowercased). Kept when the conversation goes
--                        (conversation_id SET NULL): an opt-out outlives the row.
-- resend_webhook_events  Resend (Svix) webhooks, verified then stored under their
--                        svix-id (the primary key, so a redelivery is a no-op) and
--                        processed by a second tick: pending → done | failed |
--                        ignored, with attempts / next_attempt_at / last_error.
-- =============================================================================

-- The FKs lock organizations, users, crm_records and touches: fail fast rather
-- than queue behind a conflicting lock (0045's rule; migrate-runner wraps each
-- file in one transaction, so SET LOCAL scopes to this file). Every statement
-- below only creates, so no existing table is locked for long.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "seller_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE,
  "practice_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "handler" text NOT NULL DEFAULT 'sam',
  "handler_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "handler_changed_at" timestamptz,
  "status" text NOT NULL DEFAULT 'open',
  "stop_reason" text,
  "flag_reason" text,
  "flagged_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "seller_conversations_token_unique" UNIQUE ("token"),
  CONSTRAINT "seller_conversations_handler_check" CHECK ("handler" IN ('sam', 'person')),
  CONSTRAINT "seller_conversations_status_check" CHECK ("status" IN ('open', 'booked', 'stopped'))
);

-- One real conversation per record, and one practice conversation per admin per record.
CREATE UNIQUE INDEX IF NOT EXISTS "seller_conversations_record_unique" ON "seller_conversations" ("org_id", "crm_record_id") WHERE "practice_user_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "seller_conversations_practice_unique" ON "seller_conversations" ("org_id", "crm_record_id", "practice_user_id") WHERE "practice_user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "conversation_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "seller_conversations"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "direction" text NOT NULL,
  "actor" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "subject" text,
  "body" text,
  "detail" text,
  "meta" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "sf_log_status" text NOT NULL DEFAULT 'skipped',
  "sf_task_id" text,
  "sf_log_attempts" integer NOT NULL DEFAULT 0,
  "sf_log_next_at" timestamptz,
  "sf_log_error" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversation_events_kind_check" CHECK ("kind" IN ('email', 'text', 'human_touch', 'handler', 'status', 'flag', 'note')),
  CONSTRAINT "conversation_events_direction_check" CHECK ("direction" IN ('in', 'out', 'none')),
  CONSTRAINT "conversation_events_actor_check" CHECK ("actor" IN ('sam', 'seller', 'person', 'system')),
  CONSTRAINT "conversation_events_sf_log_status_check" CHECK ("sf_log_status" IN ('pending', 'done', 'failed', 'skipped'))
);

-- The timeline read: one conversation's events, oldest first.
CREATE INDEX IF NOT EXISTS "conversation_events_conversation_idx" ON "conversation_events" ("conversation_id", "occurred_at");

-- The Salesforce log tick's scan: events that still owe a Task.
CREATE INDEX IF NOT EXISTS "conversation_events_sf_log_due_idx" ON "conversation_events" ("sf_log_next_at") WHERE "sf_log_status" = 'pending';

-- One Salesforce Task belongs to one timeline event: two events can never end up pointing at the same Task.
CREATE UNIQUE INDEX IF NOT EXISTS "conversation_events_sf_task_unique" ON "conversation_events" ("org_id", "sf_task_id") WHERE "sf_task_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "email_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "seller_conversations"("id") ON DELETE CASCADE,
  "event_id" uuid NOT NULL REFERENCES "conversation_events"("id") ON DELETE CASCADE,
  "direction" text NOT NULL,
  "status" text NOT NULL,
  "purpose" text NOT NULL,
  "to_address" text NOT NULL,
  "from_address" text NOT NULL,
  "in_reply_to" text,
  "references" text,
  "message_id" text,
  "resend_id" text,
  "send_after" timestamptz,
  "attempts" integer NOT NULL DEFAULT 0,
  "claimed_at" timestamptz,
  "first_attempt_at" timestamptz,
  "last_error" text,
  "handled_at" timestamptz,
  "touch_id" uuid REFERENCES "touches"("id") ON DELETE SET NULL,
  "requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "email_messages_direction_check" CHECK ("direction" IN ('out', 'in')),
  CONSTRAINT "email_messages_status_check" CHECK ("status" IN ('queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'canceled', 'received')),
  CONSTRAINT "email_messages_purpose_check" CHECK ("purpose" IN ('first', 'reply', 'holding', 'practice', 'inbound'))
);

-- One email row per timeline event (the timeline joins an event to its email, and nothing may add a second).
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_event_unique" ON "email_messages" ("event_id");

-- Resend redelivers webhooks and the send tick may retry: one row per (direction, Resend id).
CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_resend_unique" ON "email_messages" ("direction", "resend_id") WHERE "resend_id" IS NOT NULL;

-- A reply that carries no token is matched to our email by its In-Reply-To / References ids.
CREATE INDEX IF NOT EXISTS "email_messages_message_id_idx" ON "email_messages" ("message_id") WHERE "message_id" IS NOT NULL;

-- The send tick's scan: queued emails, soonest first.
CREATE INDEX IF NOT EXISTS "email_messages_due_idx" ON "email_messages" ("send_after") WHERE "status" = 'queued';

-- One conversation's emails (the per-seller daily cap, the timeline join).
CREATE INDEX IF NOT EXISTS "email_messages_conversation_idx" ON "email_messages" ("conversation_id", "created_at");

CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "address" text NOT NULL,
  "reason" text NOT NULL,
  "conversation_id" uuid REFERENCES "seller_conversations"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "email_suppressions_org_address_pk" PRIMARY KEY ("org_id", "address"),
  CONSTRAINT "email_suppressions_reason_check" CHECK ("reason" IN ('opted_out', 'complained', 'bounced'))
);

CREATE TABLE IF NOT EXISTS "resend_webhook_events" (
  "svix_id" text PRIMARY KEY,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "last_error" text,
  "received_at" timestamptz NOT NULL DEFAULT now(),
  "processed_at" timestamptz,
  CONSTRAINT "resend_webhook_events_status_check" CHECK ("status" IN ('pending', 'done', 'failed', 'ignored'))
);

-- The webhook tick's scan: stored events still to process.
CREATE INDEX IF NOT EXISTS "resend_webhook_events_due_idx" ON "resend_webhook_events" ("next_attempt_at") WHERE "status" = 'pending';

-- =============================================================================
-- 0061_inbound_agent_testing.sql — test phones get the AI phone agent when they
-- call one of its numbers (plan docs/superpowers/plans/2026-10-16-inbound-agent-testing.md,
-- Task 1).
--
-- ai_calls.direction     outbound | inbound. Every existing row is an outbound
--                        call, so the default backfills them (a constant default
--                        does not rewrite the table). An inbound row is a test call
--                        (is_test) and never has a calls row, a Salesforce Task or
--                        an opt-out; outbound-only queries (warm-up and velocity
--                        caps, callback routing, sticky caller-ID) filter on it.
-- ai_agent_prompts.kind  gains 'inbound': the prompt the agent follows on a call a
--                        test phone makes to it. The CHECK is dropped and re-added
--                        under the same name (contracts: AgentPromptKind).
-- ai_test_phones         The admin-managed list of phones that get the agent on an
--                        inbound call, per org (contracts: TEST_PHONES_MAX, 25).
--   e164                 The number in strict E.164, unique per org.
--   label                Who it belongs to, in the admin's words ('' = none).
--   added_by             The admin who added it. NOT NULL, so no SET NULL: a user
--                        who added phones cannot be removed until the phones go
--                        (the same as ai_calls.started_by in 0050).
-- =============================================================================

-- ai_calls is a hot table (the voice agent updates it during calls) and the FKs
-- lock organizations and users: fail fast rather than queue behind a conflicting
-- lock (0045's rule; migrate-runner wraps each file in one transaction, so
-- SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

-- Order matters: every lock is held until the file commits, so the ai_calls
-- change comes LAST. Taken first, its ACCESS EXCLUSIVE lock would stall live
-- calls' writes while the CREATE TABLE waits (up to the timeout) for its
-- organizations and users FK locks.
CREATE TABLE IF NOT EXISTS "ai_test_phones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "e164" text NOT NULL,
  "label" text NOT NULL DEFAULT '',
  "added_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_test_phones_org_e164_unique" UNIQUE ("org_id", "e164")
);

ALTER TABLE "ai_agent_prompts" DROP CONSTRAINT IF EXISTS "ai_agent_prompts_kind_check";
ALTER TABLE "ai_agent_prompts" ADD CONSTRAINT "ai_agent_prompts_kind_check" CHECK ("kind" IN ('instructions', 'voicemail', 'inbound'));

ALTER TABLE "ai_calls"
  ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'outbound' CONSTRAINT "ai_calls_direction_check" CHECK ("direction" IN ('outbound', 'inbound'));

-- =============================================================================
-- 0060_ai_agent_prompts.sql — Admin-editable agent prompts (plan
-- docs/superpowers/plans/2026-10-16-editable-agent-prompts.md, Task 2).
--
-- ai_agent_prompts  One row per saved version of an org's AI phone agent
--                   instructions or voicemail message. Append-only: a save inserts
--                   a new row and nothing here is ever updated or deleted, so the
--                   history is the audit trail and "restore" is another insert.
--   kind            instructions | voicemail.
--   body            The template text (contracts: AgentPromptKind,
--                   AGENT_PROMPT_MAX_CHARS). NULL means "use the built-in
--                   default": a reset is a NULL row, not a deleted one.
--   created_by      The admin who saved it; SET NULL when that user is removed.
-- The active version is the newest created_at per (org_id, kind); a kind with no
-- rows uses the built-in default. ai_agent_prompts_active_idx serves both that
-- lookup and the newest-20 history list.
-- =============================================================================

-- The foreign keys lock organizations and users: fail fast rather than queue
-- behind a conflicting lock (0045's rule; migrate-runner wraps each file in one
-- transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ai_agent_prompts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "body" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_agent_prompts_kind_check" CHECK ("kind" IN ('instructions', 'voicemail'))
);
CREATE INDEX IF NOT EXISTS "ai_agent_prompts_active_idx" ON "ai_agent_prompts" ("org_id", "kind", "created_at" DESC);

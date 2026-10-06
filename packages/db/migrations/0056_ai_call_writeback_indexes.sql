-- =============================================================================
-- 0056_ai_call_writeback_indexes.sql — indexes on the foreign-key columns of
-- 0055's tables that no index led with (plan 1D sweep, D-8).
--
-- Without them, deleting a touch, an enrollment, a call plan, an AI call, a
-- user or an organization scans ai_call_writebacks / ai_practice_calls for the
-- ON DELETE action, and a join on these columns scans too. Both tables are new
-- and small, so the plain (non-concurrent) builds are quick; 0054 and 0055 are
-- never edited.
-- =============================================================================

-- CREATE INDEX takes a SHARE lock (writes wait): fail fast rather than queue
-- behind a conflicting lock (0045's rule; migrate-runner wraps each file in one
-- transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS "ai_call_writebacks_touch_idx" ON "ai_call_writebacks" ("touch_id");
CREATE INDEX IF NOT EXISTS "ai_call_writebacks_enrollment_idx" ON "ai_call_writebacks" ("enrollment_id");

CREATE INDEX IF NOT EXISTS "ai_practice_calls_org_idx" ON "ai_practice_calls" ("org_id");
CREATE INDEX IF NOT EXISTS "ai_practice_calls_enrollment_idx" ON "ai_practice_calls" ("enrollment_id");
CREATE INDEX IF NOT EXISTS "ai_practice_calls_call_plan_idx" ON "ai_practice_calls" ("call_plan_id");
CREATE INDEX IF NOT EXISTS "ai_practice_calls_ai_call_idx" ON "ai_practice_calls" ("ai_call_id");
CREATE INDEX IF NOT EXISTS "ai_practice_calls_requested_by_idx" ON "ai_practice_calls" ("requested_by");

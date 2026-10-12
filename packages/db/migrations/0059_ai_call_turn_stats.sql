-- =============================================================================
-- 0059_ai_call_turn_stats.sql — per-call turn-taking numbers from the AI voice
-- bridge (spec docs/superpowers/specs/2026-10-09-ai-voice-natural-turn-taking-design.md §4.3):
--   { v, bargeIn, turns, totalMs{p50,p90,max}, endpointMs{p50}, answerMs{p50},
--     interruptions, listening, silenceChecks }   (contracts: AiCallTurnStats)
-- NULL for calls before this shipped. A nullable ADD COLUMN with no default does
-- not rewrite the table.
-- =============================================================================

-- ai_calls is a hot table (the voice agent updates it during calls): fail fast
-- rather than queue behind a conflicting lock (0045's rule; migrate-runner wraps
-- each file in one transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "turn_stats" jsonb;

-- =============================================================================
-- 0045_cti_reset.sql — an admin's "Reset CTI" for one rep or for everyone
-- (design: docs/superpowers/specs/2026-09-28-cti-reset-design.md).
--
-- users.cti_reset_requested_at  When an admin last asked for this user's web
--                               softphone to be reset. A web session is DUE
--                               while this is later than its
--                               sessions.created_at, so signing in again (a
--                               new session) is what ends it: no flag to
--                               clear, no reset loop, and a rep who was
--                               offline is reset on their next load. Always
--                               written with the database's now() — the clock
--                               that stamps sessions.created_at.
-- users.cti_reset_requested_by  The admin who asked (audit). SET NULL if that
--                               admin's user row is ever deleted.
-- users.cti_reset_completed_at  When a softphone tab last finished a reset
--                               (POST /auth/reset-complete). The Team panel
--                               shows "pending" while requested_at is later.
-- All three are nullable with no default: additive, and old code ignores them.
--
-- M5 (review fix): migrate-runner.ts wraps every file in begin/commit, so
-- SET LOCAL below applies for the rest of THIS transaction only. users is a
-- hot, high-traffic table — fail fast instead of queueing behind, and
-- indefinitely blocking, whatever already holds a conflicting lock on it.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS cti_reset_requested_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cti_reset_requested_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cti_reset_completed_at timestamptz;

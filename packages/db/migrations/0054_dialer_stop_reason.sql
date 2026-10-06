-- =============================================================================
-- 0054_dialer_stop_reason.sql — why the CTI stopped a power-dial run
-- (design: docs/superpowers/specs/2026-10-06-dialer-idle-cutoff-design.md).
--
-- dialer_sessions.stop_reason   Why a run is `stopped`, when the CTI did it:
--                               'idle' = 15 minutes with nothing happening on an
--                               open line (dialer/idle-runs.ts). NULL = the rep's
--                               own Stop, or any other end that does not say —
--                               every run that exists today. The softphone reads
--                               it to tell the rep why the line went quiet.
--
-- Nullable with no default, so adding it is instant and every existing row, and
-- every write from a container still running the previous release, reads as
-- "the rep stopped it". The CHECK rides the ADD COLUMN IF NOT EXISTS, so
-- re-running the file is a no-op. dialer_sessions is a hot table: fail fast
-- rather than queue behind a conflicting lock (same guard as 0046.
-- migrate-runner.ts wraps the file in one transaction, which is what makes
-- SET LOCAL cover it).
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS stop_reason text CONSTRAINT dialer_sessions_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN ('idle'));

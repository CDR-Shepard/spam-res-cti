-- =============================================================================
-- 0046_run_settings.sql — Power Dial run settings
-- (design: docs/superpowers/specs/2026-09-28-run-settings-design.md;
-- controller ruling S2: users.dialer_max_records; review M1: dialer_sessions.run_size).
--
-- dialer_sessions.passes                  Calls per person for THIS run: 1 (Once,
--                                         no end-of-run retry, a follow-up rolls on
--                                         the owner's first non-connect of the day)
--                                         or 2 (Twice, today's run).
-- dialer_sessions.max_records             How many dialable people the run queued.
--                                         NULL = the whole list (today).
-- dialer_sessions.rollover_business_days  Missed tasks move to: 1 = next business
--                                         day (today), 2 = in 2 business days.
-- dialer_sessions.run_size                How many people THIS run will actually
--                                         dial — min(max_records, pending rows) at
--                                         the claim. NULL for an unlimited run.
--                                         Distinct from max_records: the queue can
--                                         carry settled rows (skip, unreachable,
--                                         consent-blocked) ahead of the Nth pending
--                                         one, and those must not count toward N in
--                                         "record X of N" (review M1).
-- users.dialer_passes                     The rep's saved choices, written when a
-- users.dialer_max_records                run starts and read back as the next
-- users.dialer_rollover_business_days     run's defaults (and, for the rollover
--                                         days, by click-to-dial rollovers too).
--                                         dialer_max_records is nullable (null =
--                                         All) — S2: "How many" is remembered too.
-- followup_rollover_jobs.business_days    Captured when the job is queued, so the
--                                         worker needs no session lookup.
--
-- Every default is today's behaviour, so every existing row, and every write
-- from a container still running the previous release, behaves exactly as
-- before. Each CHECK rides its own ADD COLUMN IF NOT EXISTS, so re-running the
-- file is a no-op. users and dialer_sessions are hot tables: fail fast rather
-- than queue behind a conflicting lock (same guard as 0045. migrate-runner.ts
-- wraps the file in one transaction, which is what makes SET LOCAL cover it).
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_passes integer NOT NULL DEFAULT 2 CONSTRAINT users_dialer_passes_check CHECK (dialer_passes IN (1, 2));
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_max_records integer CONSTRAINT users_dialer_max_records_check CHECK (dialer_max_records IS NULL OR dialer_max_records > 0);
ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT users_dialer_rollover_business_days_check CHECK (dialer_rollover_business_days IN (1, 2));
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS passes integer NOT NULL DEFAULT 2 CONSTRAINT dialer_sessions_passes_check CHECK (passes IN (1, 2));
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS max_records integer CONSTRAINT dialer_sessions_max_records_check CHECK (max_records IS NULL OR max_records >= 1);
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT dialer_sessions_rollover_business_days_check CHECK (rollover_business_days IN (1, 2));
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS run_size integer CONSTRAINT dialer_sessions_run_size_check CHECK (run_size IS NULL OR run_size >= 0);
ALTER TABLE followup_rollover_jobs ADD COLUMN IF NOT EXISTS business_days integer NOT NULL DEFAULT 1 CONSTRAINT followup_rollover_jobs_business_days_check CHECK (business_days IN (1, 2));

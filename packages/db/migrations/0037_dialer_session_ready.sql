-- =============================================================================
-- 0037_dialer_session_ready.sql — a power-dial session is created 'ready'
-- (queue built, nothing dialed) and only becomes 'active' when the rep presses
-- Start dialing. Additive enum value in a file of its own: Postgres refuses to
-- USE a new enum value in the transaction that added it, so no row may be
-- written as 'ready' until this file has committed on its own.
-- Spec: docs/superpowers/specs/2026-09-10-power-dialer-ship-design.md §3
-- =============================================================================

ALTER TYPE dialer_session_status ADD VALUE IF NOT EXISTS 'ready';

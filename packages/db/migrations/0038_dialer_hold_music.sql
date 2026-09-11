-- =============================================================================
-- 0038_dialer_hold_music.sql — per-rep Power Dial hold-music preference.
-- Default on (today's behavior); a rep turns it off from the phone panel's
-- Settings tab (PATCH /auth/me { dialerHoldMusic: false }).
-- =============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_hold_music boolean NOT NULL DEFAULT true;

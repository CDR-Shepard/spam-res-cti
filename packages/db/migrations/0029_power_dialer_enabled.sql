-- Power dialing is a granted capability (spec 2026-08-25): default OFF for
-- every existing and future user; admins flip it per user from the softphone
-- Team panel. Gates live in routes/dialer.ts (requirePowerDialer).
ALTER TABLE users ADD COLUMN IF NOT EXISTS power_dialer_enabled boolean NOT NULL DEFAULT false;

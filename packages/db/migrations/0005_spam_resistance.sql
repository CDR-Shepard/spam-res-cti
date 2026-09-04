-- =============================================================================
-- 0005_spam_resistance.sql — 2026 spam-likely defense layer.
-- Adds: warmup tracking per DID, daily/velocity counters, STIR/SHAKEN
-- attestation per call, state-specific calling rule overrides.
-- =============================================================================

-- Per-DID warmup + velocity tracking.
alter table outbound_numbers
  add column if not exists first_used_at timestamptz,
  add column if not exists last_dial_at timestamptz,
  add column if not exists dials_today integer not null default 0,
  add column if not exists dials_today_date date not null default current_date,
  add column if not exists warmup_override_cap integer,  -- null = use auto curve
  add column if not exists last_minute_dial_count integer not null default 0,
  add column if not exists last_minute_window_start timestamptz;

-- STIR/SHAKEN attestation per call (read from Twilio webhook).
alter table calls
  add column if not exists shaken_attestation char(1),   -- 'A', 'B', 'C', or null
  add column if not exists shaken_verstat text;

-- Per-state calling rule overrides. These take precedence over campaign config.
create table if not exists state_calling_rules (
  state_code char(2) primary key,
  calling_hours_start text not null default '08:00',
  calling_hours_end text not null default '20:00',
  max_attempts_per_24h integer,             -- null = use campaign default
  requires_registration boolean not null default false,
  requires_bond boolean not null default false,
  notes text
);

-- Seed the known-strict states (2026 mini-TCPA landscape).
insert into state_calling_rules (state_code, calling_hours_start, calling_hours_end, max_attempts_per_24h, notes)
values
  ('FL', '08:00', '20:00', 3,  'Florida FTSA: 3 calls/24h per recipient per subject. PRA.'),
  ('OK', '08:00', '20:00', 3,  'Oklahoma OTSA: 3 calls/24h. Mirrors FTSA.'),
  ('MD', '08:00', '20:00', 3,  'Maryland Stop the Spam Calls Act (eff. 2024).'),
  ('NJ', '08:00', '20:00', 3,  'New Jersey ATCA: 3 calls/24h.'),
  ('NY', '08:00', '21:00', null, 'NY GBL 399-pp/z: $20k/violation; internal DNC disclosure required immediately.'),
  ('CA', '08:00', '21:00', null, 'California: 2-party recording consent.'),
  ('TX', '09:00', '21:00', null, 'Texas TSA (Aug 2025 update): registration + surety bond required.')
on conflict (state_code) do nothing;

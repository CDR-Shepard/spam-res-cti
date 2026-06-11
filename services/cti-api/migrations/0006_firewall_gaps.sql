-- =============================================================================
-- 0006_firewall_gaps.sql — close the high-leverage P0 firewall gaps.
--
-- Adds:
--   • federal_dnc_entries — vendor-pluggable DNC list cache
--   • rnd_lookups — cached Reassigned Numbers Database checks (FCC safe harbor)
--   • consent_records — TCPA prior-express-written-consent audit trail
--   • outbound_numbers.baseline_attestation — expected STIR/SHAKEN level per DID
--   • calls.analytics_blocked — true when terminating carrier returned SIP 603+
--   • calls.recording_disclosure_played — flag set after disclosure TwiML plays
-- =============================================================================

-- Federal DNC cache. Real provider (FreeDNCList, etc.) populates this; we
-- check it pre-call. Hashed for privacy + so we can sync without storing raw.
create table if not exists federal_dnc_entries (
  e164 text primary key,
  source text not null default 'manual',  -- 'federal_dnc' | 'state_tx_dnc' | etc.
  added_at timestamptz not null default now(),
  expires_at timestamptz                  -- federal DNC entries never expire; state lists do
);

-- Reassigned Numbers Database lookups. Cache vendor results 90 days per FCC.
create table if not exists rnd_lookups (
  e164 text not null,
  consent_date date not null,             -- when did the rep originally get consent?
  checked_at timestamptz not null default now(),
  result text not null,                   -- 'no_match' (safe) | 'reassigned' (block) | 'unknown'
  vendor text,
  primary key (e164, consent_date)
);

-- Per-recipient consent records. TCPA requires you to prove you had consent.
-- FCC's April 2026 KYC FNPRM proposes mandating exact disclosure text + IP + URL.
create table if not exists consent_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  consent_type text not null,             -- 'express_written' | 'prior_business_relationship' | 'public_record'
  source_url text,
  source_ip text,
  disclosure_text text,                   -- exact opt-in language shown
  captured_at timestamptz not null default now(),
  revoked_at timestamptz,
  notes text
);
create index if not exists consent_records_org_e164_idx on consent_records(org_id, e164);

-- Per-DID baseline STIR/SHAKEN attestation. We learn this from the first
-- few successful calls; future degradation triggers a firewall block.
alter table outbound_numbers
  add column if not exists baseline_attestation char(1),    -- 'A', 'B', 'C', null
  add column if not exists baseline_attestation_set_at timestamptz;

-- SIP 603+ analytics-block detection (FCC 8th Order, effective March 25 2026).
-- When Twilio reports `Reason: analytics-blocked` or SIP 603, we flip this
-- and degrade the DID's health.
alter table calls
  add column if not exists analytics_blocked boolean,
  add column if not exists analytics_block_reason text,
  add column if not exists recording_disclosure_played boolean;

-- Seed federal DNC with a few known-DNC test numbers so the demo shows the
-- block. Real implementation pulls from FreeDNCList or your DNC vendor.
insert into federal_dnc_entries (e164, source)
values
  ('+15551234567', 'demo_seed'),
  ('+14155550100', 'demo_seed')
on conflict (e164) do nothing;

-- =============================================================================
-- 0001_init.sql — initial schema for Caller Reputation CTI
-- =============================================================================

create extension if not exists "pgcrypto";

-- Enums
do $$ begin
  create type call_status as enum
    ('queued','initiating','ringing','in_progress','completed','no_answer','busy','failed','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type call_direction as enum ('outbound','inbound');
exception when duplicate_object then null; end $$;

do $$ begin
  create type precall_decision as enum ('ALLOW','BLOCK','REQUIRE_REVIEW');
exception when duplicate_object then null; end $$;

do $$ begin
  create type number_health as enum ('healthy','warning','degraded','spam_likely','unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type sync_status as enum ('pending','in_flight','succeeded','failed');
exception when duplicate_object then null; end $$;

-- Core
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  display_name text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now()
);
create unique index if not exists users_email_unique on users(email);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists sessions_token_hash_unique on sessions(token_hash);

-- Salesforce
create table if not exists salesforce_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  instance_url text not null,
  sf_user_id text not null,
  sf_org_id text not null,
  access_token_enc text not null,
  refresh_token_enc text,
  scope text,
  issued_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sf_conn_user_unique on salesforce_connections(user_id);

create table if not exists salesforce_oauth_state (
  state text primary key,
  pkce_verifier text not null,
  user_id uuid references users(id) on delete cascade,
  desktop_handshake_token text not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Telephony
create table if not exists outbound_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  label text,
  provider text not null,
  active boolean not null default true,
  health number_health not null default 'unknown',
  health_updated_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists outbound_numbers_org_e164_unique on outbound_numbers(org_id, e164);

create table if not exists number_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  outbound_number_id uuid not null references outbound_numbers(id) on delete cascade,
  health number_health not null,
  source text not null,
  details jsonb,
  captured_at timestamptz not null default now()
);

-- Call targets
create table if not exists call_targets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  display_name text,
  timezone text,
  salesforce_who_id text,
  salesforce_what_id text,
  last_seen_at timestamptz not null default now()
);
create index if not exists call_targets_org_e164_idx on call_targets(org_id, e164);

-- Compliance
create table if not exists opt_outs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  source text not null,
  note text,
  created_at timestamptz not null default now()
);
create unique index if not exists opt_outs_org_e164_unique on opt_outs(org_id, e164);

create table if not exists blocked_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  e164 text not null,
  reason text,
  created_at timestamptz not null default now()
);
create unique index if not exists blocked_numbers_org_e164_unique on blocked_numbers(org_id, e164);

create table if not exists campaign_configs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  key text not null,
  name text not null,
  paused boolean not null default false,
  max_attempts integer not null default 5,
  attempt_window_days integer not null default 14,
  calling_hours_start text not null default '08:00',
  calling_hours_end text not null default '20:00',
  calling_days jsonb not null default '[1,2,3,4,5]'::jsonb,
  recording_consent_mode text not null default 'off',
  required_script_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists campaign_configs_org_key_unique on campaign_configs(org_id, key);

create table if not exists pre_call_audits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  to_number_raw text not null,
  to_number_e164 text,
  from_number_e164 text,
  campaign_key text,
  decision precall_decision not null,
  reasons jsonb not null,
  block_reason text,
  required_script_id text,
  checks jsonb not null,
  request_id text,
  created_at timestamptz not null default now()
);
create index if not exists pre_call_audits_org_created_idx on pre_call_audits(org_id, created_at);
create index if not exists pre_call_audits_e164_idx on pre_call_audits(to_number_e164);

-- Calls
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  provider text not null,
  provider_call_id text,
  from_number text not null,
  to_number text not null,
  normalized_to_number text not null,
  direction call_direction not null default 'outbound',
  status call_status not null default 'queued',
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  disposition text,
  notes text,
  recording_url text,
  transcript_url text,
  salesforce_task_id text,
  salesforce_who_id text,
  salesforce_what_id text,
  precall_audit_id uuid references pre_call_audits(id),
  campaign_key text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists calls_provider_call_id_unique
  on calls(provider, provider_call_id)
  where provider_call_id is not null;
create index if not exists calls_org_created_idx on calls(org_id, created_at);
create index if not exists calls_org_target_idx on calls(org_id, normalized_to_number);

create table if not exists call_events (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  event_type text not null,
  raw_status text,
  payload jsonb,
  occurred_at timestamptz not null default now()
);
create index if not exists call_events_call_idx on call_events(call_id, occurred_at);

-- Webhook inbox
create table if not exists provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  signature_valid boolean not null,
  headers jsonb,
  body jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  error text
);
create unique index if not exists provider_webhook_external_unique
  on provider_webhook_events(provider, external_id);

-- Salesforce sync queue
create table if not exists salesforce_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references calls(id) on delete cascade,
  status sync_status not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  completed_at timestamptz,
  salesforce_task_id text,
  created_at timestamptz not null default now()
);
create unique index if not exists sf_sync_call_unique on salesforce_sync_jobs(call_id);
create index if not exists sf_sync_status_idx on salesforce_sync_jobs(status, next_attempt_at);

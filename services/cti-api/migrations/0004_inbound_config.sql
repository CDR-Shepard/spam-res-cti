-- =============================================================================
-- 0004_inbound_config.sql — per-number inbound auto-answer configuration.
--
-- Goal: when carriers' anti-spam scanners reverse-call our outbound numbers,
-- they hear a real human-ish greeting instead of silence/voicemail. That
-- keeps the number's reputation clean.
--
-- Config lives on the outbound_numbers row so admins can enable/disable and
-- customize per-number from the desktop Settings page.
-- =============================================================================

alter table outbound_numbers
  add column if not exists inbound_enabled boolean not null default false,
  add column if not exists inbound_greeting text,
  add column if not exists inbound_matched_greeting text,
  add column if not exists inbound_record_seconds integer not null default 60,
  add column if not exists inbound_transcribe boolean not null default true,
  add column if not exists inbound_forward_to_e164 text;

-- Inbound calls go in the existing `calls` table with direction='inbound'.
-- Add a few inbound-specific columns we don't want to stuff into metadata jsonb.
alter table calls
  add column if not exists inbound_caller_matched boolean,
  add column if not exists inbound_voicemail_url text,
  add column if not exists inbound_transcript text;

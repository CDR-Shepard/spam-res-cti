-- =============================================================================
-- 0003_sf_profile.sql — cache the connected Salesforce user's profile so we
-- can show their real name + photo in the desktop app header.
-- =============================================================================

alter table salesforce_connections
  add column if not exists sf_user_name text,
  add column if not exists sf_user_email text,
  add column if not exists sf_photo_b64 text,
  add column if not exists sf_photo_content_type text,
  add column if not exists sf_profile_fetched_at timestamptz;

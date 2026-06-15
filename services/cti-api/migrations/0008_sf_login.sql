-- =============================================================================
-- 0008_sf_login.sql — "Sign in with Salesforce" rep login.
--
-- Lets reps authenticate via Salesforce OAuth (no password, no dev backdoor).
-- The OAuth callback find-or-creates the local org (keyed by SF org id) and the
-- user (keyed by email), then issues a session handed back via the handshake
-- poll. Gated to an allowed SF org id (config) so arbitrary Salesforce orgs
-- can't self-provision accounts.
-- =============================================================================

-- Map a local org to its Salesforce org id (one local org per SF org).
alter table organizations add column if not exists sf_org_id text;
create unique index if not exists organizations_sf_org_id_unique
  on organizations (sf_org_id) where sf_org_id is not null;

-- Carry the user created/found during a login-mode OAuth callback, and a
-- single-use marker so the handshake poll mints exactly one session.
alter table salesforce_oauth_state
  add column if not exists login_user_id uuid references users(id) on delete cascade;
alter table salesforce_oauth_state
  add column if not exists session_retrieved_at timestamptz;

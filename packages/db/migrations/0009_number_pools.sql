-- =============================================================================
-- 0009_number_pools.sql — per-rep number pools + reserve + admin role.
--
-- Numbers belong to the org; each can be ASSIGNED to a rep (their active dialing
-- pool) or left unassigned (the shared RESERVE held back to swap in when an
-- active number gets flagged). Rotation dials only from the calling rep's
-- assigned pool. An admin manages assignment.
-- =============================================================================

-- Admin role (manages numbers, assignment, campaigns). The first user created
-- when an org is provisioned via Salesforce login is made an admin.
alter table users add column if not exists is_admin boolean not null default false;

-- null assigned_user_id = reserve pool; non-null = that rep's active pool.
-- On rep removal, their numbers fall back to reserve rather than vanishing.
alter table outbound_numbers
  add column if not exists assigned_user_id uuid references users(id) on delete set null;

create index if not exists outbound_numbers_assigned_user_idx
  on outbound_numbers (org_id, assigned_user_id);

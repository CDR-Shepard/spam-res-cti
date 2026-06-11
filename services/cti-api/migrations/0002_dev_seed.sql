-- =============================================================================
-- 0002_dev_seed.sql — dev-only seed for the first rep + org + campaign
-- Safe to run multiple times (ON CONFLICT DO NOTHING).
-- =============================================================================

insert into organizations (id, name)
values ('00000000-0000-0000-0000-00000000d0c1', 'Dev Org')
on conflict (id) do nothing;

insert into users (id, org_id, email, display_name, timezone)
values (
  '00000000-0000-0000-0000-00000000beef',
  '00000000-0000-0000-0000-00000000d0c1',
  'dev@example.com',
  'Dev Rep',
  'America/Los_Angeles'
)
on conflict (email) do nothing;

insert into campaign_configs (org_id, key, name)
values ('00000000-0000-0000-0000-00000000d0c1', 'default', 'Default Campaign')
on conflict (org_id, key) do nothing;

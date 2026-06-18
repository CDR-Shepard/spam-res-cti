-- Seed a default campaign config for every existing org that lacks one, so the
-- firewall's "campaign" gate passes (it flags a missing key='default' config as
-- REQUIRE_REVIEW). New orgs get this row at provisioning time (auth callback).
-- Calling hours / attempt caps fall back to the column defaults.
insert into campaign_configs (org_id, key, name)
select o.id, 'default', 'Default Campaign'
from organizations o
where not exists (
  select 1 from campaign_configs c
  where c.org_id = o.id and c.key = 'default'
);

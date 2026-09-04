-- How an org satisfies DNC compliance, driving the firewall's federal_dnc gate:
--   'registry'            → check the number against the loaded DNC cache
--   'external_prescrubbed'→ org attests lists are scrubbed offline; gate passes
--                           green ("pre-scrubbed list (org policy)"), though a
--                           number in a loaded cache still blocks.
alter table organizations
  add column if not exists dnc_mode text not null default 'registry';

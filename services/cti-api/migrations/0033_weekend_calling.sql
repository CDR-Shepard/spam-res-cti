-- Weekend-calling ruling (2026-08-31, Evren): enable Saturday/Sunday dialing
-- globally. Existing Mon-Fri-only campaigns move to all 7 days; the per-state
-- compliance overlay (src/firewall/state-calling-rules.ts) is the guard that
-- keeps Sunday-restricted states protected automatically, so this migration
-- does not need to know which states those are.
update campaign_configs set calling_days = '[1,2,3,4,5,6,7]'::jsonb where calling_days = '[1,2,3,4,5]'::jsonb;
alter table campaign_configs alter column calling_days set default '[1,2,3,4,5,6,7]'::jsonb;

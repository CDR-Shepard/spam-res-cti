-- FIX-1 (weekend-calling fix wave): campaign_configs.calling_hours_start/end
-- could be stored unpadded (e.g. "8:00"), which defeated the per-state
-- overlay's floor/cap clamp when it compared "HH:MM" strings lexicographically
-- instead of numerically (state-calling-rules.ts maxHHMM/minHHMM,
-- firewall/index.ts callingWindowFor — both fixed in the same wave to compare
-- via minutes-since-midnight). This migration repairs any unpadded rows at
-- rest and adds a CHECK constraint so the format can't regress.
update campaign_configs set calling_hours_start = lpad(calling_hours_start, 5, '0') where calling_hours_start !~ '^[0-2][0-9]:[0-5][0-9]$';
update campaign_configs set calling_hours_end   = lpad(calling_hours_end,   5, '0') where calling_hours_end   !~ '^[0-2][0-9]:[0-5][0-9]$';

alter table campaign_configs drop constraint if exists calling_hours_start_format;
alter table campaign_configs add constraint calling_hours_start_format check (calling_hours_start ~ '^[0-2][0-9]:[0-5][0-9]$');

alter table campaign_configs drop constraint if exists calling_hours_end_format;
alter table campaign_configs add constraint calling_hours_end_format check (calling_hours_end ~ '^[0-2][0-9]:[0-5][0-9]$');

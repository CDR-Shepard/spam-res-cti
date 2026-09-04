-- Add updated_at to salesforce_sync_jobs so the sync worker can reap orphaned
-- 'in_flight' jobs. A job is marked 'in_flight' only while a tick is actively
-- syncing it; if the process crashes or Railway redeploys mid-tick (which
-- happens on every push to main), that row would otherwise sit in 'in_flight'
-- forever and the call's Salesforce Task would never be created. The reaper
-- resets in_flight rows untouched for >2 min back to 'pending'.
alter table salesforce_sync_jobs
  add column if not exists updated_at timestamptz not null default now();

-- Immediately un-stick anything already orphaned from a past crash/redeploy.
update salesforce_sync_jobs
  set status = 'pending', updated_at = now()
  where status = 'in_flight';

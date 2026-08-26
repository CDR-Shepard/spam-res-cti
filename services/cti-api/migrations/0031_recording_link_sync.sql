-- Track whether the recording-link PATCH to the Task actually succeeded, so
-- the retry sweep in the sync tick (sweepUnpushedRecordingLinks, sync.ts) can
-- find and repair the ones that silently failed. Historical rows are NULL,
-- which is exactly what the sweep's WHERE clause selects on — no separate
-- one-time backfill script is needed; the sweep repairs them at <=10/tick.
alter table calls
  add column if not exists recording_link_synced_at timestamptz;

-- Partial index for sweepUnpushedRecordingLinks (sync.ts): the sweep's WHERE
-- clause (recorded + Task attached + unstamped) plus its new ORDER BY
-- updated_at desc (Fix 2, 2026-08-26 review) both hit this exact shape every
-- tick. Partial so the index only covers the small, shrinking set of rows the
-- sweep actually cares about, not every call.
create index if not exists calls_recording_link_unsynced_idx
  on calls (updated_at)
  where recording_link_synced_at is null and recording_url is not null and salesforce_task_id is not null;

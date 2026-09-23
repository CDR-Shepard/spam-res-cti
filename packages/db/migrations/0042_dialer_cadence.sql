-- =============================================================================
-- 0042_dialer_cadence.sql — the person, not the run, as the unit of contact.
--
-- dialer_sessions.list_view_id        which list view a run came from, so a
--                                     second run on the same list starts where
--                                     the first has got to (shared position).
-- dialer_queue_items.list_position    the record's index in that list view at
--                                     pull time — NOT the queue ordinal, which
--                                     rotation changes.
-- dialer_queue_items.prospect_ended_at the prospect hung up on a connected call;
--                                     the rep chooses Redial or Resume.
-- dialer_queue_items.redial_of        the item a rep-requested redial copies.
-- dialer_dial_attempts.record_id      the record dialed (the log was keyed by
--                                     number only); the 3-hour rule matches on
--                                     either.
-- dialer_dial_attempts.connected_at   stamped on a human connect — the number
--                                     that reached the person is the one every
--                                     later run leads with.
-- Both indexes serve the dial-time checks (bounded to 24 h, a few rows each).
-- Nullable throughout; no backfill — the windows are hours, not history.
-- =============================================================================

ALTER TABLE dialer_sessions    ADD COLUMN IF NOT EXISTS list_view_id text;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS list_position integer;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS prospect_ended_at timestamptz;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS redial_of uuid;
ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS record_id text;
ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS connected_at timestamptz;

CREATE INDEX IF NOT EXISTS dialer_dial_attempts_record_idx ON dialer_dial_attempts (org_id, record_id, dialed_at);
CREATE INDEX IF NOT EXISTS calls_outbound_target_idx ON calls (org_id, normalized_to_number, created_at) WHERE direction = 'outbound';

-- =============================================================================
-- 0040_no_answer_chatter.sql — "No answer" Chatter posts at the end of a
-- power-dial run.
--
-- When a run ends (done / stopped, including the abandoned-run reaper), a
-- background worker posts one "No answer (Power Dialer) — …" FeedItem, authored
-- by the rep through their own Salesforce token, on every record that was dialed
-- and never connected — and only on records the rep owns (the same ownership
-- rule the follow-up rollover uses). The worker SCANS for ended, un-swept
-- sessions; nothing is enqueued, so there is no enqueue step to lose.
--
-- dialer_queue_items — per-record outcome of the sweep, stamped on EVERY
-- qualifying item of the record (both attempts), which is also the idempotency
-- key: a stamped item is never posted again.
--   no_answer_feed_item_id  the FeedItem id once posted
--   no_answer_skip_reason   terminal skip: 'not-owner', 'not-found', or the
--                           Salesforce statusCode that rejected the post
--
-- dialer_sessions — the sweep's own bookkeeping.
--   no_answer_chatter_at          sweep finished (everything terminal) or given up on
--   no_answer_chatter_claimed_at  claim held by a worker (reaped when stuck)
--   no_answer_chatter_attempts    claims that consumed an attempt (max 8)
--   no_answer_chatter_next_at     backoff: not before this instant
--
-- NO HISTORICAL BACKFILL — the closing UPDATE is load-bearing. Every session that
-- ended before this migration has no_answer_chatter_at IS NULL and would be swept
-- on first boot: thousands of "No answer" posts on months-old records. It also
-- pre-stamps every session, WHATEVER its status, not touched in 24h: a run
-- paused or left `ready` weeks ago and stopped after the deploy gets a fresh
-- updated_at from stopSession (it is a status-flip clock, not an "ended at"),
-- and must already be swept when that happens. Marking them here is one half of
-- a belt-and-braces pair; the worker independently counts only misses whose
-- dialer_queue_items.updated_at (the attempt's settle time) is inside 24h. Keep
-- both. (Pinned by packages/db/src/migration-0040.test.ts.)
-- =============================================================================

ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS no_answer_feed_item_id text;
ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS no_answer_skip_reason text;

ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_at timestamptz;
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_claimed_at timestamptz;
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_next_at timestamptz;

-- The worker's scan: ended + un-swept, newest 24h only. Partial, so it stays a
-- handful of rows however many sessions the table accumulates.
CREATE INDEX IF NOT EXISTS dialer_sessions_no_answer_chatter_scan_idx
  ON dialer_sessions (updated_at)
  WHERE no_answer_chatter_at IS NULL AND status IN ('done','stopped');

-- MUST stay the last statement (see the header): no historical backfill —
-- already ended, or (any status) stale for 24h and liable to be stopped later.
UPDATE dialer_sessions SET no_answer_chatter_at = now()
  WHERE no_answer_chatter_at IS NULL
    AND (status IN ('done','stopped') OR updated_at < now() - interval '24 hours');

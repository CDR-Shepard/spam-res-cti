-- =============================================================================
-- 0041_dialer_item_display_name.sql — the person's name on each power-dial row.
--
-- The panel's "Current record" card showed only the number until the record
-- popped, and the pop waits for `connected` plus a poll — so the rep heard
-- "hello?" before seeing who it was. The name is resolved at queue build (a
-- Lead's or Contact's Name; an Opportunity's primary contact, else the
-- Opportunity's own Name) and stored on the row, so the first poll after the
-- dial already carries it, and an attempt-2 retry row carries it forward.
-- Nullable: a record with no name, and every row written before this migration,
-- simply shows the number as before.
-- =============================================================================

ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS display_name text;

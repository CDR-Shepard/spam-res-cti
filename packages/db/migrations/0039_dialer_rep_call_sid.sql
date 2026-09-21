-- =============================================================================
-- 0039_dialer_rep_call_sid.sql — the rep's own conference leg, per dialer run.
--
-- Hold music used to stop after the first connect: Twilio plays a conference's
-- wait music only BEFORE it starts, and the room outlived each prospect. Now a
-- prospect leaving ENDS the room and the rep's leg loops into a fresh one
-- (<Dial action> → /telephony/twilio/dialer-conference-rejoin). The run-end
-- backstop therefore can no longer find the rep by conference name — between
-- rooms there is no conference — so it hangs up the rep's call by sid instead.
-- Nullable: stamped when the softphone joins; older runs fall back to the
-- name-based teardown.
-- =============================================================================

ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS rep_call_sid text;

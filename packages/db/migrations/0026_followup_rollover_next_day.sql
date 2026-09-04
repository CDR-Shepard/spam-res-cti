-- The plain next business day after the miss, as computed by the rollover
-- worker from the org's real Salesforce calendar. Lets the session view tell
-- "moved to tomorrow" from "pushed later (daily cap)" with a string compare —
-- no Salesforce round trip on the softphone's 2-second poll.
ALTER TABLE "followup_rollover_jobs" ADD COLUMN IF NOT EXISTS "next_day" text;

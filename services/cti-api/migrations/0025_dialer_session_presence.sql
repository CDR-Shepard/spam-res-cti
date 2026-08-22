-- Rep presence for the retry nudge. The softphone's DialerPanel polls
-- GET /dialer/sessions/:id every ~2s while mounted (and the nav is locked to
-- that panel during a run), so a recent poll is proof a rep is at the phone.
-- The retry nudge — which ORIGINATES outbound calls from a server timer —
-- only advances sessions polled within the last 30s; a closed/asleep tab
-- stops nudging and nobody gets dialed into an empty conference.
ALTER TABLE "dialer_sessions" ADD COLUMN IF NOT EXISTS "last_polled_at" timestamptz;

-- =============================================================================
-- 0055_ai_call_booking.sql — AI call appointment booking (plan 1D:
-- docs/superpowers/plans/2026-10-06-ai-call-context-booking-writeback-1d.md).
--
-- ai_calls
--   offered_slots   The AppointmentSlot[] the signed trigger sent (contracts
--                   appointments.ts): the free times on the appointment owner's
--                   calendar the agent may offer. '[]' when none were sent.
--   appointment     The BookedAppointment that the agent's book_appointment tool
--                   stored (one of offered_slots); NULL until a slot is booked.
--   practice        A practice call: the real record's plan and prompt, dialed to
--                   an admin's test number. Always also is_test (CHECK), so every
--                   "not for test calls" guard (the Salesforce Task, results
--                   counting, the write-back) applies to it.
-- =============================================================================

-- ai_calls is a hot table (the voice agent updates it during calls): fail fast
-- rather than queue behind a conflicting lock (0045's rule; migrate-runner wraps
-- each file in one transaction, so SET LOCAL scopes to this file).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "ai_calls"
  ADD COLUMN IF NOT EXISTS "offered_slots" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "appointment" jsonb,
  ADD COLUMN IF NOT EXISTS "practice" boolean NOT NULL DEFAULT false CONSTRAINT "ai_calls_practice_check" CHECK (NOT "practice" OR "is_test");

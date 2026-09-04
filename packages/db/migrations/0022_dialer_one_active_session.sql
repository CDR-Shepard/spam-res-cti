-- One active dialer session per rep.
--
-- Until now a fresh session was created with status='active' but nothing kicked
-- the engine, so a duplicate 'active' row for the same rep was a harmless no-op.
-- Session creation now originates a real Twilio call synchronously
-- (createAndStartSession -> advanceSession), so two 'active' sessions for one
-- rep would mean two simultaneous live outbound calls — a direct violation of
-- the "exactly one call in-flight per rep" / TCPA invariant this system exists
-- to protect. Postgres now refuses the second; createDialerSession catches the
-- violation and returns the rep's existing active session instead (idempotent
-- for a double-submitted start, and self-healing for a session whose first
-- originate failed — the rep's next start re-kicks the same session).

-- Defensive: if any environment already has >1 active session for a rep (e.g.
-- earlier hung test runs that were never stopped), keep the newest and stop the
-- rest so the unique index below can be created.
UPDATE "dialer_sessions" s
SET "status" = 'stopped', "updated_at" = now()
WHERE "status" = 'active'
  AND EXISTS (
    SELECT 1 FROM "dialer_sessions" s2
    WHERE s2."user_id" = s."user_id"
      AND s2."status" = 'active'
      AND (s2."created_at" > s."created_at"
           OR (s2."created_at" = s."created_at" AND s2."id" > s."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "dialer_sessions_one_active_per_user"
  ON "dialer_sessions" ("user_id")
  WHERE "status" = 'active';

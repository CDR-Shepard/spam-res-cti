-- =============================================================================
-- 0053_ai_call_requests.sql — idempotency for POST /internal/ai-calls (plan 1C).
--
-- outreach-api triggers AI calls in @cti/api with a signed request carrying an
-- idempotency key (touch:<touchId>:<n>). The key is reserved here BEFORE anything
-- is dialed; `response` is NULL while the request is in flight and holds the
-- answer afterwards, so a replay or a retry after a lost response returns the
-- stored answer instead of placing a second call. A different body under the
-- same key is refused (request_hash).
-- =============================================================================

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "ai_call_requests" (
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL,
  "response" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ai_call_requests_pkey" PRIMARY KEY ("org_id", "idempotency_key")
);

-- Housekeeping scans (rows older than 30 days can be deleted by an operator).
CREATE INDEX IF NOT EXISTS "ai_call_requests_created_idx" ON "ai_call_requests" ("created_at");

-- services/cti-api/migrations/0019_dialer_handoffs.sql
CREATE TABLE IF NOT EXISTS "dialer_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid,
  "salesforce_user_id" text NOT NULL,
  "object_type" text NOT NULL,
  "record_ids" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "claimed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "dialer_handoffs_sfuser_status_idx"
  ON "dialer_handoffs" ("salesforce_user_id", "status");

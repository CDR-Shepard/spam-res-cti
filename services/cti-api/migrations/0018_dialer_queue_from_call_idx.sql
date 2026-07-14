-- services/cti-api/migrations/0018_dialer_queue_from_call_idx.sql
ALTER TABLE "dialer_queue_items" ADD COLUMN IF NOT EXISTS "from_number" text;

CREATE INDEX IF NOT EXISTS "dialer_queue_items_call_id_idx" ON "dialer_queue_items" ("call_id");

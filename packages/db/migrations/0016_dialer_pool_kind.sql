-- services/cti-api/migrations/0016_dialer_pool_kind.sql
DO $$ BEGIN
  CREATE TYPE "number_kind" AS ENUM ('agent', 'dialer_pool');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "outbound_numbers"
  ADD COLUMN IF NOT EXISTS "kind" "number_kind" NOT NULL DEFAULT 'agent';

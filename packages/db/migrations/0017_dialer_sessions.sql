-- services/cti-api/migrations/0017_dialer_sessions.sql
DO $$ BEGIN
  CREATE TYPE "dialer_session_status" AS ENUM ('active', 'paused', 'stopped', 'done');
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  CREATE TYPE "dialer_item_status" AS ENUM ('pending', 'dialing', 'connected', 'no_connect', 'skipped', 'unreachable', 'done');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "dialer_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "sf_owner_id" text NOT NULL,
  "object_type" text NOT NULL,
  "status" "dialer_session_status" NOT NULL DEFAULT 'active',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE,
  CONSTRAINT "dialer_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "dialer_queue_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "object_type" text NOT NULL,
  "record_id" text NOT NULL,
  "to_number" text,
  "status" "dialer_item_status" NOT NULL DEFAULT 'pending',
  "call_id" text,
  "outcome" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "dialer_queue_items_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "dialer_sessions" ("id") ON DELETE CASCADE
);

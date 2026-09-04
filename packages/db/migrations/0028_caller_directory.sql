-- Caller-ID mobile app: the merged directory the phone syncs, plus device
-- pairing. caller_directory_versions/entries hold the OUTPUT of
-- mergeDirectory() (src/mobile/directory-merge.ts) — one immutable snapshot
-- per publish, so a client can diff by version instead of re-pulling every
-- number on every sync. mobile_devices/mobile_pair_codes are the pairing
-- flow: a rep enters a short-lived code (mobile_pair_codes) in the app to
-- mint a device row (mobile_devices) holding the long-lived API token hash.

CREATE TABLE IF NOT EXISTS "caller_directory_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "entry_count" integer NOT NULL,
  "content_hash" text NOT NULL,
  "built_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "caller_directory_versions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "caller_directory_versions_org_version_unique"
  ON "caller_directory_versions" ("org_id", "version");

CREATE TABLE IF NOT EXISTS "caller_directory_entries" (
  "org_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "e164" text NOT NULL,
  "label" text NOT NULL,
  "stage" text NOT NULL,
  PRIMARY KEY ("org_id", "version", "e164"),
  CONSTRAINT "caller_directory_entries_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "mobile_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "label" text NOT NULL,
  "apns_token" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz,
  CONSTRAINT "mobile_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "mobile_devices_token_hash_unique"
  ON "mobile_devices" ("token_hash");

CREATE TABLE IF NOT EXISTS "mobile_pair_codes" (
  "code_hash" text PRIMARY KEY,
  "user_id" uuid NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  CONSTRAINT "mobile_pair_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
);

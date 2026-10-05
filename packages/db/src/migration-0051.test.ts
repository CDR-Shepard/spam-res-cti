/**
 * 0051_outreach_campaigns.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract; the real-Postgres lane
 * (services/outreach-api/src/test/pg.test.ts) applies it for real.
 * Load-bearing: the PARTIAL unique index enrollment_contact_keys_active_unique
 * (one active campaign per person), the FULL unique indexes every upsert
 * arbitrates on, the CHECK lists matching the schema-outreach.ts constants, and
 * a Drizzle mirror with no foreign keys (they live in SQL only).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  CAMPAIGN_SF_OBJECTS,
  CAMPAIGN_SOURCE_KINDS,
  CAMPAIGN_STATUSES,
  CAMPAIGN_PAUSED_FROM,
  CRM_CONNECTION_STATUSES,
  CRM_PROVIDERS,
  ENROLLMENT_STATUSES,
  SF_WRITE_KINDS,
  SF_WRITE_STATUSES,
  TOUCH_CHANNELS,
  TOUCH_STATUSES,
  aiUsageDays,
  campaignEnrollments,
  campaigns,
  crmConnections,
  crmOauthStates,
  crmRecords,
  dialerSessions,
  enrollmentContactKeys,
  recordTriage,
  sfWrites,
  touches,
} from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0051_outreach_campaigns.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

function createOf(table: string): string {
  const create = statements.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS "${table}" (`));
  if (!create) throw new Error(`no CREATE TABLE for ${table}`);
  return create;
}

const inList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

const ORG_FK = '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE';
const ID = '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()';
const CREATED = '"created_at" timestamptz NOT NULL DEFAULT now()';
const UPDATED = '"updated_at" timestamptz NOT NULL DEFAULT now()';

/** Every table: its exact column definitions, in order. */
const TABLES: Record<string, string[]> = {
  crm_connections: [
    ID,
    ORG_FK,
    `"provider" text NOT NULL DEFAULT 'salesforce'`,
    '"instance_url" text NOT NULL',
    '"sf_org_id" text NOT NULL',
    '"sf_user_id" text NOT NULL',
    '"sf_username" text',
    '"access_token_enc" text NOT NULL',
    '"refresh_token_enc" text',
    `"status" text NOT NULL DEFAULT 'connected'`,
    '"last_error" text',
    '"field_map" jsonb',
    '"connected_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
    '"connected_at" timestamptz NOT NULL DEFAULT now()',
    UPDATED,
  ],
  crm_oauth_states: [ID, ORG_FK, '"user_id" uuid NOT NULL', '"state" text NOT NULL', '"code_verifier" text NOT NULL', CREATED],
  campaigns: [
    ID,
    ORG_FK,
    '"name" text NOT NULL',
    '"sf_object" text NOT NULL',
    '"source_kind" text NOT NULL',
    '"list_view_id" text',
    '"soql" text NOT NULL',
    `"status" text NOT NULL DEFAULT 'draft'`,
    '"pause_reason" text',
    '"paused_from" text',
    '"refresh_minutes" integer NOT NULL DEFAULT 240',
    `"touch_days" integer[] NOT NULL DEFAULT '{0,1,3,6,10,14}'`,
    '"approvals_remaining" integer NOT NULL DEFAULT 50',
    `"playbook" jsonb NOT NULL DEFAULT '{}'::jsonb`,
    '"member_count" integer NOT NULL DEFAULT 0',
    '"last_refreshed_at" timestamptz',
    '"last_refresh_error" text',
    '"created_by" uuid',
    CREATED,
    UPDATED,
  ],
  crm_records: [
    ID,
    ORG_FK,
    '"sf_object" text NOT NULL',
    '"sf_record_id" text NOT NULL',
    '"name" text',
    '"owner_sf_user_id" text',
    '"owner_name" text',
    '"lead_manager_sf_user_id" text',
    `"phones" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    '"email" text',
    '"state" text',
    '"web_form_source" text',
    '"consent_ai_call" boolean NOT NULL DEFAULT false',
    '"consent_source" text',
    '"consent_at" timestamptz',
    '"sf_do_not_call" boolean NOT NULL DEFAULT false',
    '"sf_email_opt_out" boolean NOT NULL DEFAULT false',
    '"skip_on_dialer" boolean NOT NULL DEFAULT false',
    '"is_closed" boolean NOT NULL DEFAULT false',
    '"notes_hash" text',
    '"triage_needed" boolean NOT NULL DEFAULT true',
    '"sf_last_modified_at" timestamptz',
    '"synced_at" timestamptz NOT NULL DEFAULT now()',
  ],
  record_triage: [
    ID,
    ORG_FK,
    '"crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE',
    '"notes_hash" text NOT NULL',
    '"model" text NOT NULL',
    '"result" jsonb NOT NULL',
    '"input_tokens" integer NOT NULL',
    '"output_tokens" integer NOT NULL',
    CREATED,
  ],
  campaign_enrollments: [
    ID,
    ORG_FK,
    '"campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE',
    '"crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE',
    `"status" text NOT NULL DEFAULT 'active'`,
    '"exit_reason" text',
    '"review_category" text',
    '"review_quote" text',
    '"flagged_at" timestamptz',
    '"next_touch_at" timestamptz',
    '"touches_done" integer NOT NULL DEFAULT 0',
    '"enrolled_at" timestamptz NOT NULL DEFAULT now()',
    UPDATED,
  ],
  enrollment_contact_keys: [
    '"enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE',
    ORG_FK,
    '"key" text NOT NULL',
    '"active" boolean NOT NULL DEFAULT true',
  ],
  touches: [
    ID,
    ORG_FK,
    '"enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE',
    '"seq" integer NOT NULL',
    '"channel" text NOT NULL',
    '"status" text NOT NULL',
    '"due_at" timestamptz NOT NULL',
    '"sent_at" timestamptz',
    '"dialer_session_id" uuid',
    '"claimed_at" timestamptz',
    '"outcome" text',
    '"provider_ref" text',
    '"body" text',
    `"gate_audit" jsonb NOT NULL DEFAULT '[]'::jsonb`,
    '"skip_reason" text',
    CREATED,
    UPDATED,
  ],
  sf_writes: [
    ID,
    ORG_FK,
    '"kind" text NOT NULL',
    '"sf_object" text NOT NULL',
    '"sf_record_id" text NOT NULL',
    '"payload" jsonb NOT NULL',
    `"status" text NOT NULL DEFAULT 'pending'`,
    '"attempts" integer NOT NULL DEFAULT 0',
    '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
    '"last_error" text',
    '"first_failed_at" timestamptz',
    '"alerted_at" timestamptz',
    '"done_at" timestamptz',
    CREATED,
    UPDATED,
  ],
  ai_usage_days: [ORG_FK, '"day" text NOT NULL', '"cost_micros" bigint NOT NULL DEFAULT 0', UPDATED],
};

/** Every CHECK, verbatim — each value list comes from the schema constant. */
const CHECKS: Record<string, string[]> = {
  crm_connections: [
    `CONSTRAINT "crm_connections_provider_check" CHECK ("provider" IN (${inList(CRM_PROVIDERS)}))`,
    `CONSTRAINT "crm_connections_status_check" CHECK ("status" IN (${inList(CRM_CONNECTION_STATUSES)}))`,
  ],
  campaigns: [
    `CONSTRAINT "campaigns_sf_object_check" CHECK ("sf_object" IN (${inList(CAMPAIGN_SF_OBJECTS)}))`,
    `CONSTRAINT "campaigns_source_kind_check" CHECK ("source_kind" IN (${inList(CAMPAIGN_SOURCE_KINDS)}))`,
    `CONSTRAINT "campaigns_status_check" CHECK ("status" IN (${inList(CAMPAIGN_STATUSES)}))`,
    `CONSTRAINT "campaigns_paused_from_check" CHECK ("paused_from" IN (${inList(CAMPAIGN_PAUSED_FROM)}))`,
  ],
  campaign_enrollments: [`CONSTRAINT "campaign_enrollments_status_check" CHECK ("status" IN (${inList(ENROLLMENT_STATUSES)}))`],
  touches: [
    `CONSTRAINT "touches_channel_check" CHECK ("channel" IN (${inList(TOUCH_CHANNELS)}))`,
    `CONSTRAINT "touches_status_check" CHECK ("status" IN (${inList(TOUCH_STATUSES)}))`,
  ],
  sf_writes: [
    `CONSTRAINT "sf_writes_kind_check" CHECK ("kind" IN (${inList(SF_WRITE_KINDS)}))`,
    `CONSTRAINT "sf_writes_status_check" CHECK ("status" IN (${inList(SF_WRITE_STATUSES)}))`,
  ],
  ai_usage_days: [`CONSTRAINT "ai_usage_days_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`],
};

/** Every index statement in the file, verbatim. */
const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS "crm_connections_org_provider_unique" ON "crm_connections" ("org_id", "provider")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "crm_oauth_states_state_unique" ON "crm_oauth_states" ("state")',
  'CREATE INDEX IF NOT EXISTS "campaigns_org_status_idx" ON "campaigns" ("org_id", "status")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "crm_records_org_record_unique" ON "crm_records" ("org_id", "sf_record_id")',
  'CREATE INDEX IF NOT EXISTS "crm_records_triage_needed_idx" ON "crm_records" ("org_id") WHERE "triage_needed"',
  'CREATE INDEX IF NOT EXISTS "record_triage_record_created_idx" ON "record_triage" ("crm_record_id", "created_at" DESC)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "campaign_enrollments_campaign_record_unique" ON "campaign_enrollments" ("campaign_id", "crm_record_id")',
  'CREATE INDEX IF NOT EXISTS "campaign_enrollments_org_status_next_idx" ON "campaign_enrollments" ("org_id", "status", "next_touch_at")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "enrollment_contact_keys_active_unique" ON "enrollment_contact_keys" ("org_id", "key") WHERE "active"',
  'CREATE UNIQUE INDEX IF NOT EXISTS "touches_enrollment_seq_unique" ON "touches" ("enrollment_id", "seq")',
  'CREATE INDEX IF NOT EXISTS "touches_org_status_due_idx" ON "touches" ("org_id", "status", "due_at")',
  'CREATE INDEX IF NOT EXISTS "touches_dialer_session_idx" ON "touches" ("dialer_session_id") WHERE "dialer_session_id" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "sf_writes_status_next_idx" ON "sf_writes" ("status", "next_attempt_at")',
];

/** Strips everything but the column / constraint list of a CREATE TABLE. */
function body(create: string): string[] {
  const inner = create.slice(create.indexOf('(') + 1, create.lastIndexOf(')'));
  // Split on commas that are not inside parentheses or quotes.
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const ch of inner) {
    if (ch === "'") quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth--;
    if (!quoted && depth === 0 && ch === ',') {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

const DRIZZLE: Record<string, PgTable> = {
  crm_connections: crmConnections,
  crm_oauth_states: crmOauthStates,
  campaigns,
  crm_records: crmRecords,
  record_triage: recordTriage,
  campaign_enrollments: campaignEnrollments,
  enrollment_contact_keys: enrollmentContactKeys,
  touches,
  sf_writes: sfWrites,
  ai_usage_days: aiUsageDays,
};

describe('migration 0051_outreach_campaigns', () => {
  it('creates exactly the ten outreach tables, each idempotently', () => {
    const creates = statements.filter((s) => s.startsWith('CREATE TABLE'));
    expect(creates.map((s) => /"([a-z_]+)"/.exec(s)?.[1])).toEqual(Object.keys(TABLES));
    for (const s of creates) expect(s).toMatch(/^CREATE TABLE IF NOT EXISTS "/);
  });

  for (const [table, columns] of Object.entries(TABLES)) {
    it(`${table}: exactly these columns, then its constraints`, () => {
      const parts = body(createOf(table));
      const constraints = parts.filter((p) => p.startsWith('CONSTRAINT '));
      expect(parts.filter((p) => !p.startsWith('CONSTRAINT '))).toEqual(columns);
      const pk = table === 'enrollment_contact_keys'
        ? ['CONSTRAINT "enrollment_contact_keys_pkey" PRIMARY KEY ("enrollment_id", "key")']
        : table === 'ai_usage_days'
          ? ['CONSTRAINT "ai_usage_days_pkey" PRIMARY KEY ("org_id", "day")']
          : [];
      expect(constraints).toEqual([...pk, ...(CHECKS[table] ?? [])]);
    });
  }

  it('every index, verbatim and idempotent — unique ones FULL except the one-active-campaign index', () => {
    expect(statements.filter((s) => s.startsWith('CREATE') && s.includes(' INDEX '))).toEqual(INDEXES);
    const partialUnique = INDEXES.filter((s) => s.startsWith('CREATE UNIQUE') && s.includes(' WHERE '));
    expect(partialUnique).toEqual([
      'CREATE UNIQUE INDEX IF NOT EXISTS "enrollment_contact_keys_active_unique" ON "enrollment_contact_keys" ("org_id", "key") WHERE "active"',
    ]);
  });

  it('adds dialer_sessions.campaign_id idempotently: nullable, no FK, nothing else altered', () => {
    expect(statements.filter((s) => s.startsWith('ALTER TABLE'))).toEqual([
      'ALTER TABLE "dialer_sessions" ADD COLUMN IF NOT EXISTS "campaign_id" uuid',
    ]);
  });

  it('nothing but CREATE TABLE, CREATE INDEX, and the one ALTER', () => {
    const creates = statements.filter((s) => s.startsWith('CREATE TABLE')).length;
    expect(statements).toHaveLength(creates + INDEXES.length + 1);
  });

  for (const [table, drizzleTable] of Object.entries(DRIZZLE)) {
    it(`Drizzle ${table} mirrors the SQL: same name, same columns, no foreign keys`, () => {
      const cfg = getTableConfig(drizzleTable);
      expect(cfg.name).toBe(table);
      const sqlColumns = TABLES[table]!.map((c) => /^"([a-z_]+)"/.exec(c)![1]);
      expect(cfg.columns.map((c) => c.name)).toEqual(sqlColumns);
      for (const col of cfg.columns) {
        const def = TABLES[table]!.find((c) => c.startsWith(`"${col.name}" `))!;
        expect({ column: col.name, notNull: col.notNull || col.primary }).toEqual({
          column: col.name,
          notNull: def.includes('NOT NULL') || def.includes('PRIMARY KEY'),
        });
      }
      expect(cfg.foreignKeys).toHaveLength(0);
    });
  }

  it('Drizzle indexes carry the SQL names, uniqueness, and partial predicates', () => {
    const all = Object.values(DRIZZLE).flatMap((t) => getTableConfig(t).indexes);
    const byName = new Map(all.map((i) => [i.config.name, i.config]));
    expect([...byName.keys()].sort()).toEqual(INDEXES.map((s) => /INDEX IF NOT EXISTS "([a-z_]+)"/.exec(s)![1]).sort());
    for (const stmt of INDEXES) {
      const name = /INDEX IF NOT EXISTS "([a-z_]+)"/.exec(stmt)![1]!;
      const cfg = byName.get(name)!;
      expect({ name, unique: cfg.unique, partial: cfg.where !== undefined }).toEqual({
        name,
        unique: stmt.startsWith('CREATE UNIQUE'),
        partial: stmt.includes(' WHERE '),
      });
    }
  });

  it('Drizzle composite primary keys match the SQL constraint names', () => {
    const keys = getTableConfig(enrollmentContactKeys).primaryKeys;
    expect(keys.map((k) => [k.getName(), k.columns.map((c) => c.name)])).toEqual([
      ['enrollment_contact_keys_pkey', ['enrollment_id', 'key']],
    ]);
    const usage = getTableConfig(aiUsageDays).primaryKeys;
    expect(usage.map((k) => [k.getName(), k.columns.map((c) => c.name)])).toEqual([['ai_usage_days_pkey', ['org_id', 'day']]]);
  });

  it('Drizzle dialerSessions has a nullable uuid campaign_id', () => {
    const col = getTableConfig(dialerSessions).columns.find((c) => c.name === 'campaign_id');
    expect(col?.columnType).toBe('PgUUID');
    expect(col?.notNull).toBe(false);
  });
});

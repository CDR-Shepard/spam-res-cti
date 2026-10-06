/**
 * 0058_ai_record_tests.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  AI_RECORD_TEST_CALL_MODES,
  AI_RECORD_TEST_SF_OBJECTS,
  AI_RECORD_TEST_STATUSES,
  aiRecordTestCalls,
  aiRecordTests,
} from './schema-outreach.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0058_ai_record_tests.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const createOf = (table: string) => statements.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS "${table}"`));
/** The column / constraint lines of a CREATE TABLE, in order. */
const linesOf = (create: string) =>
  create
    .replace(/^CREATE TABLE IF NOT EXISTS "[a-z_]+" \(\s*/, '')
    .replace(/\s*\)$/, '')
    .split(/,\s*(?="|CONSTRAINT)/)
    .map((l) => l.trim());
const columnsOf = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).columns.map((c) => ({ name: c.name, notNull: c.notNull }));
const expectedColumns = (lines: string[]) =>
  lines
    .filter((l) => l.startsWith('"'))
    .map((l) => ({ name: l.slice(1, l.indexOf('"', 1)), notNull: / NOT NULL| PRIMARY KEY/.test(l) }));

const TEST_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"sf_object" text NOT NULL',
  '"sf_record_id" text NOT NULL',
  `"status" text NOT NULL DEFAULT 'running'`,
  '"error" text',
  '"name" text',
  '"research" jsonb',
  '"plan" jsonb',
  '"plan_text" text',
  `"plan_text_issues" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  `"slots" jsonb NOT NULL DEFAULT '[]'::jsonb`,
  '"offer_note" text',
  '"owner_sf_user_id" text',
  '"model" text',
  '"input_tokens" integer NOT NULL DEFAULT 0',
  '"output_tokens" integer NOT NULL DEFAULT 0',
  '"cost_micros" bigint NOT NULL DEFAULT 0',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  '"completed_at" timestamptz',
  `CONSTRAINT "ai_record_tests_sf_object_check" CHECK ("sf_object" IN ('Lead', 'Opportunity'))`,
  `CONSTRAINT "ai_record_tests_status_check" CHECK ("status" IN ('running', 'ready', 'failed'))`,
];

const CALL_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"record_test_id" uuid NOT NULL REFERENCES "ai_record_tests"("id") ON DELETE CASCADE',
  '"requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"mode" text NOT NULL',
  '"to_e164" text',
  '"client_identity" text',
  '"idempotency_key" text NOT NULL',
  '"ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL',
  '"result" jsonb',
  '"dry_run" jsonb',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  `CONSTRAINT "ai_record_test_calls_mode_check" CHECK ( ("mode" = 'phone' AND "to_e164" IS NOT NULL AND "client_identity" IS NULL) OR ("mode" = 'browser' AND "client_identity" IS NOT NULL AND "to_e164" IS NULL))`,
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS "ai_record_tests_org_created_idx" ON "ai_record_tests" ("org_id", "created_at" DESC)',
  'CREATE INDEX IF NOT EXISTS "ai_record_tests_requester_idx" ON "ai_record_tests" ("requested_by", "created_at" DESC)',
  'CREATE UNIQUE INDEX IF NOT EXISTS "ai_record_test_calls_key_unique" ON "ai_record_test_calls" ("idempotency_key")',
  'CREATE INDEX IF NOT EXISTS "ai_record_test_calls_test_idx" ON "ai_record_test_calls" ("record_test_id", "created_at" DESC)',
  'CREATE INDEX IF NOT EXISTS "ai_record_test_calls_requester_idx" ON "ai_record_test_calls" ("requested_by", "created_at" DESC)',
];

describe('migration 0058_ai_record_tests', () => {
  it('starts with the lock_timeout guard (the FKs lock organizations, users, ai_calls)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('creates ai_record_tests with exactly these columns and CHECKs', () => {
    const create = createOf('ai_record_tests');
    expect(create).toBeDefined();
    expect(linesOf(create!)).toEqual(TEST_LINES);
  });

  it('creates ai_record_test_calls with exactly these columns and the phone/browser CHECK', () => {
    const create = createOf('ai_record_test_calls');
    expect(create).toBeDefined();
    expect(linesOf(create!)).toEqual(CALL_LINES);
  });

  it("the CHECKs match the schema's value lists", () => {
    const tests = createOf('ai_record_tests')!;
    expect(tests).toContain(`CHECK ("sf_object" IN (${quoted(AI_RECORD_TEST_SF_OBJECTS)}))`);
    expect(tests).toContain(`CHECK ("status" IN (${quoted(AI_RECORD_TEST_STATUSES)}))`);
    const calls = createOf('ai_record_test_calls')!;
    for (const mode of AI_RECORD_TEST_CALL_MODES) expect(calls).toContain(`"mode" = '${mode}'`);
  });

  it('creates the five indexes, and has exactly these statements', () => {
    for (const index of INDEXES) expect(statements).toContain(index);
    expect(statements).toHaveLength(3 + INDEXES.length);
  });

  it('matches the Drizzle aiRecordTests table', () => {
    const config = getTableConfig(aiRecordTests);
    expect(config.name).toBe('ai_record_tests');
    expect(columnsOf(aiRecordTests)).toEqual(expectedColumns(TEST_LINES));
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(['ai_record_tests_org_created_idx', 'ai_record_tests_requester_idx']);
  });

  it('matches the Drizzle aiRecordTestCalls table, with the unique idempotency key', () => {
    const config = getTableConfig(aiRecordTestCalls);
    expect(config.name).toBe('ai_record_test_calls');
    expect(columnsOf(aiRecordTestCalls)).toEqual(expectedColumns(CALL_LINES));
    expect(config.foreignKeys).toHaveLength(0);
    const unique = config.indexes.find((i) => i.config.name === 'ai_record_test_calls_key_unique');
    expect(unique?.config.unique).toBe(true);
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
      ['ai_record_test_calls_key_unique', 'ai_record_test_calls_requester_idx', 'ai_record_test_calls_test_idx'].sort(),
    );
  });

  it('the nullable columns are exactly the optional ones', () => {
    const nullable = (t: Parameters<typeof getTableConfig>[0]) => columnsOf(t).filter((c) => !c.notNull).map((c) => c.name);
    expect(nullable(aiRecordTests)).toEqual(
      expect.arrayContaining(['error', 'name', 'research', 'plan', 'plan_text', 'offer_note', 'owner_sf_user_id', 'completed_at']),
    );
    expect(nullable(aiRecordTestCalls)).toEqual(['requested_by', 'to_e164', 'client_identity', 'ai_call_id', 'result', 'dry_run']);
  });
});

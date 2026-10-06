/**
 * 0055_ai_call_writebacks.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { AI_CALL_WRITEBACK_SF_OBJECTS, AI_CALL_WRITEBACK_STATUSES, aiCallWritebacks, aiPracticeCalls } from './schema-outreach.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0055_ai_call_writebacks.sql'), 'utf8');
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

const WRITEBACK_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"ai_call_id" uuid NOT NULL REFERENCES "ai_calls"("id") ON DELETE CASCADE',
  '"touch_id" uuid REFERENCES "touches"("id") ON DELETE SET NULL',
  '"enrollment_id" uuid REFERENCES "campaign_enrollments"("id") ON DELETE SET NULL',
  '"sf_object" text NOT NULL',
  '"sf_record_id" text NOT NULL',
  '"outcome" text NOT NULL',
  `"status" text NOT NULL DEFAULT 'pending'`,
  '"attempts" integer NOT NULL DEFAULT 0',
  '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
  '"locked_until" timestamptz',
  '"plan" jsonb',
  `"steps" jsonb NOT NULL DEFAULT '{}'::jsonb`,
  '"sf_event_id" text',
  '"sf_task_id" text',
  '"sf_feed_item_id" text',
  '"converted_opportunity_id" text',
  '"converted_account_id" text',
  '"converted_contact_id" text',
  '"model" text',
  '"input_tokens" integer NOT NULL DEFAULT 0',
  '"output_tokens" integer NOT NULL DEFAULT 0',
  '"last_error" text',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  '"updated_at" timestamptz NOT NULL DEFAULT now()',
  '"completed_at" timestamptz',
  `CONSTRAINT "ai_call_writebacks_sf_object_check" CHECK ("sf_object" IN ('Lead', 'Opportunity'))`,
  `CONSTRAINT "ai_call_writebacks_status_check" CHECK ("status" IN ('pending', 'running', 'done', 'partial', 'failed', 'skipped'))`,
];

const PRACTICE_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"campaign_id" uuid NOT NULL REFERENCES "campaigns"("id") ON DELETE CASCADE',
  '"enrollment_id" uuid NOT NULL REFERENCES "campaign_enrollments"("id") ON DELETE CASCADE',
  '"call_plan_id" uuid REFERENCES "call_plans"("id") ON DELETE SET NULL',
  '"plan_version" integer NOT NULL',
  '"ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL',
  '"requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"to_e164" text NOT NULL',
  '"idempotency_key" text NOT NULL',
  '"result" jsonb',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
];

describe('migration 0055_ai_call_writebacks', () => {
  it('starts with the lock_timeout guard (the FKs lock organizations, users, ai_calls, touches, campaigns, campaign_enrollments, call_plans)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('creates ai_call_writebacks with exactly these columns and CHECKs, including the converted_* ids', () => {
    const create = createOf('ai_call_writebacks');
    expect(create).toBeDefined();
    expect(linesOf(create!)).toEqual(WRITEBACK_LINES);
  });

  it("the CHECKs match the schema's value lists", () => {
    const create = createOf('ai_call_writebacks')!;
    expect(create).toContain(`CHECK ("sf_object" IN (${quoted(AI_CALL_WRITEBACK_SF_OBJECTS)}))`);
    expect(create).toContain(`CHECK ("status" IN (${quoted(AI_CALL_WRITEBACK_STATUSES)}))`);
  });

  it('indexes the write-backs: one per AI call, the due scan, and per record', () => {
    expect(statements).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "ai_call_writebacks_ai_call_unique" ON "ai_call_writebacks" ("ai_call_id")');
    expect(statements).toContain(
      `CREATE INDEX IF NOT EXISTS "ai_call_writebacks_due_idx" ON "ai_call_writebacks" ("next_attempt_at") WHERE "status" IN ('pending', 'running')`,
    );
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS "ai_call_writebacks_record_idx" ON "ai_call_writebacks" ("org_id", "sf_record_id")');
  });

  it('creates ai_practice_calls with exactly these columns, indexed by campaign, newest first', () => {
    const create = createOf('ai_practice_calls');
    expect(create).toBeDefined();
    expect(linesOf(create!)).toEqual(PRACTICE_LINES);
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS "ai_practice_calls_campaign_idx" ON "ai_practice_calls" ("campaign_id", "created_at" DESC)');
  });

  it('has exactly these statements', () => {
    expect(statements).toHaveLength(7);
  });

  it('matches the Drizzle aiCallWritebacks table', () => {
    const config = getTableConfig(aiCallWritebacks);
    expect(config.name).toBe('ai_call_writebacks');
    expect(columnsOf(aiCallWritebacks)).toEqual(
      WRITEBACK_LINES.filter((l) => l.startsWith('"')).map((l) => ({
        name: l.slice(1, l.indexOf('"', 1)),
        notNull: / NOT NULL| PRIMARY KEY/.test(l),
      })),
    );
    expect(config.foreignKeys).toHaveLength(0);
    const unique = config.indexes.find((i) => i.config.name === 'ai_call_writebacks_ai_call_unique');
    expect(unique?.config.unique).toBe(true);
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
      ['ai_call_writebacks_ai_call_unique', 'ai_call_writebacks_due_idx', 'ai_call_writebacks_record_idx'].sort(),
    );
  });

  it('matches the Drizzle aiPracticeCalls table', () => {
    const config = getTableConfig(aiPracticeCalls);
    expect(config.name).toBe('ai_practice_calls');
    expect(columnsOf(aiPracticeCalls)).toEqual(
      PRACTICE_LINES.map((l) => ({ name: l.slice(1, l.indexOf('"', 1)), notNull: / NOT NULL| PRIMARY KEY/.test(l) })),
    );
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.indexes.map((i) => i.config.name)).toEqual(['ai_practice_calls_campaign_idx']);
  });
});

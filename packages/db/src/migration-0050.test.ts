/**
 * 0050_ai_calls.sql — pinned. Read from disk (no database in the unit suite),
 * so the file's text IS the contract. Load-bearing: the status CHECK list (the
 * ai-voice state machine writes exactly these values) and the PARTIAL unique
 * index on call_sid (Twilio status callbacks upsert by CallSid; NULL until the
 * call is placed, so only non-null values may collide).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiCalls } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0050_ai_calls.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0050_ai_calls', () => {
  it('starts with the lock_timeout guard (FKs lock the hot organizations and users tables)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('creates ai_calls idempotently with every column', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "ai_calls" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL REFERENCES "organizations"("id")',
      '"started_by" uuid NOT NULL REFERENCES "users"("id")',
      '"handoff_user_id" uuid REFERENCES "users"("id")',
      '"sf_object" text',
      '"sf_record_id" text',
      '"to_e164" text NOT NULL',
      '"from_e164" text',
      '"is_test" boolean NOT NULL DEFAULT false',
      `"status" text NOT NULL DEFAULT 'queued'`,
      '"outcome" text',
      '"block_reason" text',
      '"call_sid" text',
      '"answered_by" text',
      `"qualification" jsonb NOT NULL DEFAULT '{}'::jsonb`,
      `"transcript" jsonb NOT NULL DEFAULT '[]'::jsonb`,
      '"summary" text',
      '"callback_at" timestamptz',
      '"sf_task_id" text',
      '"cti_call_id" uuid',
      '"duration_seconds" integer',
      '"started_at" timestamptz',
      '"ended_at" timestamptz',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
  });

  it('CHECKs status to the AI-call state machine values', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    expect(create).toContain(
      `CONSTRAINT "ai_calls_status_check" CHECK ("status" IN ('queued', 'ringing', 'in_progress', 'transferring', 'transferred', 'completed', 'failed', 'blocked'))`,
    );
  });

  it('indexes (org_id, created_at desc) and uniquely, partially, call_sid', () => {
    const org = statements.find((s) => s.includes('ai_calls_org_created_idx'));
    expect(org).toBe(
      'CREATE INDEX IF NOT EXISTS "ai_calls_org_created_idx" ON "ai_calls" ("org_id", "created_at" DESC)',
    );
    const sid = statements.find((s) => s.includes('ai_calls_call_sid_unique'));
    expect(sid).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "ai_calls_call_sid_unique" ON "ai_calls" ("call_sid") WHERE "call_sid" IS NOT NULL',
    );
  });

  it('the schema mirrors the migration', () => {
    const cfg = getTableConfig(aiCalls);
    expect(cfg.name).toBe('ai_calls');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      [
        'id', 'org_id', 'started_by', 'handoff_user_id', 'sf_object', 'sf_record_id', 'to_e164', 'from_e164',
        'is_test', 'status', 'outcome', 'block_reason', 'call_sid', 'answered_by', 'qualification', 'transcript',
        'summary', 'callback_at', 'sf_task_id', 'cti_call_id', 'duration_seconds', 'started_at', 'ended_at',
        'created_at', 'updated_at',
      ].sort(),
    );
    const unique = cfg.indexes.find((i) => i.config.name === 'ai_calls_call_sid_unique');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.where).toBeDefined();
    expect(cfg.indexes.find((i) => i.config.name === 'ai_calls_org_created_idx')).toBeDefined();
    expect(cfg.foreignKeys).toHaveLength(3);
  });
});

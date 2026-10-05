/**
 * 0053_ai_call_requests.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiCallRequests } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0053_ai_call_requests.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0053_ai_call_requests', () => {
  it('starts with the lock_timeout guard (the FKs lock organizations, users and ai_calls)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('creates ai_call_requests keyed by (org_id, idempotency_key)', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "ai_call_requests"'));
    expect(create).toBeDefined();
    for (const column of [
      '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
      '"idempotency_key" text NOT NULL',
      '"request_hash" text NOT NULL',
      '"user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL',
      '"ai_call_id" uuid REFERENCES "ai_calls"("id") ON DELETE SET NULL',
      '"response" jsonb',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
      'CONSTRAINT "ai_call_requests_pkey" PRIMARY KEY ("org_id", "idempotency_key")',
    ]) {
      expect(create).toContain(column);
    }
  });

  it('indexes created_at for housekeeping', () => {
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS "ai_call_requests_created_idx" ON "ai_call_requests" ("created_at")');
  });

  it('has exactly these statements', () => {
    expect(statements).toHaveLength(3);
  });

  it('matches the Drizzle table', () => {
    const config = getTableConfig(aiCallRequests);
    expect(config.columns.map((c) => c.name)).toEqual([
      'org_id',
      'idempotency_key',
      'request_hash',
      'user_id',
      'ai_call_id',
      'response',
      'created_at',
      'updated_at',
    ]);
    expect(config.primaryKeys.map((pk) => pk.getName())).toEqual(['ai_call_requests_pkey']);
    expect(config.indexes.map((i) => i.config.name)).toEqual(['ai_call_requests_created_idx']);
  });
});

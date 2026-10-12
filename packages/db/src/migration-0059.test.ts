/**
 * 0059_ai_call_turn_stats.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiCalls } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0059_ai_call_turn_stats.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0059_ai_call_turn_stats', () => {
  it('starts with the lock_timeout guard (it locks ai_calls)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(raw).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('adds a nullable jsonb turn_stats column to ai_calls, idempotently', () => {
    expect(raw).toMatch(/ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "turn_stats" jsonb;/);
    expect(statements[1]).toBe('ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "turn_stats" jsonb');
  });

  it('has no NOT NULL and no DEFAULT (NULL for calls before this shipped; no table rewrite)', () => {
    const code = statements.join('; ');
    expect(code).not.toMatch(/NOT NULL|DEFAULT/i);
  });

  it('has exactly these statements', () => {
    expect(statements).toHaveLength(2);
  });

  it('matches the Drizzle column', () => {
    const col = getTableConfig(aiCalls).columns.find((c) => c.name === 'turn_stats');
    expect(col?.columnType).toBe('PgJsonb');
    expect(col?.notNull).toBe(false);
    expect(col?.hasDefault).toBe(false);
  });
});

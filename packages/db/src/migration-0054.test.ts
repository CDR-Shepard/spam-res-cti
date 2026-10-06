/**
 * 0054_ai_call_booking.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiCalls } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0054_ai_call_booking.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0054_ai_call_booking', () => {
  it('starts with the lock_timeout guard (it locks ai_calls)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('adds offered_slots, appointment and practice to ai_calls in one ALTER', () => {
    const alters = statements.filter((s) => s.startsWith('ALTER TABLE "ai_calls"'));
    expect(alters).toHaveLength(1);
    const clauses = alters[0]!
      .replace(/^ALTER TABLE "ai_calls" /, '')
      .split(/,\s*(?=ADD COLUMN)/)
      .map((c) => c.trim());
    expect(clauses).toEqual([
      `ADD COLUMN IF NOT EXISTS "offered_slots" jsonb NOT NULL DEFAULT '[]'::jsonb`,
      'ADD COLUMN IF NOT EXISTS "appointment" jsonb',
      'ADD COLUMN IF NOT EXISTS "practice" boolean NOT NULL DEFAULT false CONSTRAINT "ai_calls_practice_check" CHECK (NOT "practice" OR "is_test")',
    ]);
  });

  it('has exactly these statements', () => {
    expect(statements).toHaveLength(2);
  });

  it('matches the Drizzle columns', () => {
    const byName = new Map(getTableConfig(aiCalls).columns.map((c) => [c.name, c]));
    const offered = byName.get('offered_slots');
    expect(offered?.notNull).toBe(true);
    expect(offered?.hasDefault).toBe(true);
    expect(offered?.columnType).toBe('PgJsonb');
    const appointment = byName.get('appointment');
    expect(appointment?.notNull).toBe(false);
    expect(appointment?.columnType).toBe('PgJsonb');
    const practice = byName.get('practice');
    expect(practice?.notNull).toBe(true);
    expect(practice?.default).toBe(false);
    expect(practice?.columnType).toBe('PgBoolean');
  });
});

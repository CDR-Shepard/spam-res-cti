/**
 * 0057_ai_call_writeback_indexes.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { aiCallWritebacks, aiPracticeCalls } from './schema-outreach.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0057_ai_call_writeback_indexes.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

const INDEXES: Array<[string, string, string]> = [
  ['ai_call_writebacks_touch_idx', 'ai_call_writebacks', 'touch_id'],
  ['ai_call_writebacks_enrollment_idx', 'ai_call_writebacks', 'enrollment_id'],
  ['ai_practice_calls_org_idx', 'ai_practice_calls', 'org_id'],
  ['ai_practice_calls_enrollment_idx', 'ai_practice_calls', 'enrollment_id'],
  ['ai_practice_calls_call_plan_idx', 'ai_practice_calls', 'call_plan_id'],
  ['ai_practice_calls_ai_call_idx', 'ai_practice_calls', 'ai_call_id'],
  ['ai_practice_calls_requested_by_idx', 'ai_practice_calls', 'requested_by'],
];

describe('migration 0057_ai_call_writeback_indexes (sweep D-8)', () => {
  it('starts with the lock_timeout guard (CREATE INDEX locks the table against writes)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('indexes every 0056 foreign-key column no index led with, so a parent delete or a join never scans', () => {
    for (const [name, table, column] of INDEXES) {
      expect(statements).toContain(`CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" ("${column}")`);
    }
  });

  it('has exactly these statements', () => {
    expect(statements).toHaveLength(1 + INDEXES.length);
  });

  it('the Drizzle tables declare the same indexes', () => {
    const names = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).indexes.map((i) => i.config.name);
    for (const [name, table] of INDEXES) {
      expect(names(table === 'ai_call_writebacks' ? aiCallWritebacks : aiPracticeCalls)).toContain(name);
    }
  });
});

/**
 * 0045_cti_reset.sql — pinned. Read from disk rather than applied (the unit
 * suite has no database), so the file's text IS the contract: a lock_timeout
 * guard (M5 — see migrate-runner.ts's `begin`/`commit` per file, which is
 * what makes SET LOCAL apply for the rest of this file) plus three nullable
 * columns, nothing else, safe to re-run.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { users } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0045_cti_reset.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0045_cti_reset', () => {
  it('sets a lock_timeout guard, then adds exactly three nullable columns to users, idempotently', () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS cti_reset_requested_at timestamptz',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS cti_reset_requested_by uuid REFERENCES users(id) ON DELETE SET NULL',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS cti_reset_completed_at timestamptz',
    ]);
  });

  it('the Drizzle schema matches: nullable, no default, timestamptz / uuid', () => {
    const c = getTableColumns(users);
    expect(c.ctiResetRequestedAt.name).toBe('cti_reset_requested_at');
    expect(c.ctiResetRequestedBy.name).toBe('cti_reset_requested_by');
    expect(c.ctiResetCompletedAt.name).toBe('cti_reset_completed_at');
    for (const col of [c.ctiResetRequestedAt, c.ctiResetRequestedBy, c.ctiResetCompletedAt]) {
      expect(col.notNull).toBe(false);
      expect(col.hasDefault).toBe(false);
    }
    expect(c.ctiResetRequestedAt.columnType).toBe('PgTimestamp');
    expect(c.ctiResetCompletedAt.columnType).toBe('PgTimestamp');
    expect((c.ctiResetRequestedAt as unknown as { withTimezone: boolean }).withTimezone).toBe(true);
    expect((c.ctiResetCompletedAt as unknown as { withTimezone: boolean }).withTimezone).toBe(true);
    expect(c.ctiResetRequestedBy.columnType).toBe('PgUUID');
  });
});

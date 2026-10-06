/**
 * 0054_dialer_stop_reason.sql — pinned. Read from disk rather than applied (the
 * unit suite has no database), so the file's text IS the contract: the
 * lock_timeout guard (migrate-runner.ts wraps each file in one transaction,
 * which is what makes SET LOCAL cover it), then one nullable, default-free
 * column whose named CHECK rides its own ADD COLUMN IF NOT EXISTS, so
 * re-running the file is a no-op.
 *
 * The CHECK's list is the DIALER_STOP_REASONS constant: add a reason in both
 * places (a new migration for the CHECK) or the insert fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DIALER_STOP_REASONS, dialerSessions } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0054_dialer_stop_reason.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0054_dialer_stop_reason', () => {
  it('sets the lock_timeout guard, then adds the one checked, nullable column, idempotently', () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS stop_reason text CONSTRAINT dialer_sessions_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN ('idle'))",
    ]);
  });

  it('CHECKs stop_reason against exactly the schema constant, NULL for every run that was not cut', () => {
    const list = DIALER_STOP_REASONS.map((x) => `'${x}'`).join(', ');
    expect(statements[1]).toContain(
      `CONSTRAINT dialer_sessions_stop_reason_check CHECK (stop_reason IS NULL OR stop_reason IN (${list}))`,
    );
  });

  it('adds no default and no NOT NULL, so the ALTER is instant and every old row stays NULL', () => {
    const alter = statements[1]!;
    expect(alter).not.toMatch(/DEFAULT|NOT NULL/i);
  });

  it('the schema mirrors the migration: a nullable text stop_reason, and the CHECK list is the constant', () => {
    const col = getTableConfig(dialerSessions).columns.find((c) => c.name === 'stop_reason');
    expect(col).toBeDefined();
    expect(col!.getSQLType()).toBe('text');
    expect(col!.notNull).toBe(false);
    expect(col!.hasDefault).toBe(false);
    expect([...DIALER_STOP_REASONS]).toEqual(['idle']);
  });
});

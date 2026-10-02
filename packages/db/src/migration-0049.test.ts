/**
 * 0049_dialer_time_tasks.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract. Load-bearing: the FULL unique
 * index on (user_id, day) — salesforce/dialer-time-store.ts inserts with a bare
 * ON CONFLICT DO NOTHING, which a PARTIAL index cannot arbitrate (42P10).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { dialerTimeTasks } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0049_dialer_time_tasks.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0049_dialer_time_tasks', () => {
  it('creates dialer_time_tasks idempotently with every column, FK-free', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "dialer_time_tasks" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL',
      '"user_id" uuid NOT NULL',
      '"day" text NOT NULL',
      '"salesforce_task_id" text',
      '"synced_seconds" integer',
      '"attempts" integer NOT NULL DEFAULT 0',
      '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
      '"last_error" text',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
    expect(create).not.toContain('REFERENCES');
  });

  it('CHECKs day is a YYYY-MM-DD string', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    expect(create).toContain(`CONSTRAINT "dialer_time_tasks_day_check" CHECK ("day" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`);
  });

  it('has a FULL (never partial) unique index on (user_id, day)', () => {
    const idx = statements.find((s) => s.includes('dialer_time_tasks_user_day_unique'));
    expect(idx).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dialer_time_tasks_user_day_unique" ON "dialer_time_tasks" ("user_id", "day")',
    );
    expect(idx).not.toMatch(/WHERE/i);
  });

  it('the schema mirrors the migration', () => {
    const cfg = getTableConfig(dialerTimeTasks);
    expect(cfg.name).toBe('dialer_time_tasks');
    expect(cfg.columns.map((c) => c.name).sort()).toEqual(
      ['id', 'org_id', 'user_id', 'day', 'salesforce_task_id', 'synced_seconds', 'attempts', 'next_attempt_at', 'last_error', 'created_at', 'updated_at'].sort(),
    );
    const unique = cfg.indexes.find((i) => i.config.name === 'dialer_time_tasks_user_day_unique');
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.where).toBeUndefined();
    expect(cfg.foreignKeys).toHaveLength(0);
  });
});

/**
 * 0046_run_settings.sql — pinned. Read from disk rather than applied (the unit
 * suite has no database), so the file's text IS the contract: the
 * lock_timeout guard (0045's M5 rule — migrate-runner.ts wraps each file in
 * one transaction, which is what makes SET LOCAL cover it all), then eight
 * columns, each with the default that is today's behaviour and a named CHECK
 * riding its own ADD COLUMN IF NOT EXISTS, so re-running the file is a no-op.
 *
 * `users.dialer_max_records` (controller ruling S2) rides alongside
 * `dialer_passes` and `dialer_rollover_business_days`: the rep's saved "How
 * many" default, nullable (null = All), CHECK > 0 when not null.
 *
 * `dialer_sessions.run_size` (review M1): the rep's Calls per person and
 * Missed tasks choices are one thing; "how many people will THIS run
 * actually dial" is another — the queue can carry settled rows (skip,
 * unreachable, consent-blocked) ahead of the maxRecords-th pending one, and
 * those must not count toward N in "record X of N". Computed once at the
 * claim (min(maxRecords, pending rows)), nullable — null for an unlimited
 * run, CHECK >= 0 (a run whose every record settled at build is legitimately
 * size 0).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { dialerSessions, followupRolloverJobs, users } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0046_run_settings.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0046_run_settings', () => {
  it("sets the lock_timeout guard, then adds eight checked columns whose defaults are today's run, idempotently", () => {
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_passes integer NOT NULL DEFAULT 2 CONSTRAINT users_dialer_passes_check CHECK (dialer_passes IN (1, 2))',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_max_records integer CONSTRAINT users_dialer_max_records_check CHECK (dialer_max_records IS NULL OR dialer_max_records > 0)',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS dialer_rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT users_dialer_rollover_business_days_check CHECK (dialer_rollover_business_days IN (1, 2))',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS passes integer NOT NULL DEFAULT 2 CONSTRAINT dialer_sessions_passes_check CHECK (passes IN (1, 2))',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS max_records integer CONSTRAINT dialer_sessions_max_records_check CHECK (max_records IS NULL OR max_records >= 1)',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS rollover_business_days integer NOT NULL DEFAULT 1 CONSTRAINT dialer_sessions_rollover_business_days_check CHECK (rollover_business_days IN (1, 2))',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS run_size integer CONSTRAINT dialer_sessions_run_size_check CHECK (run_size IS NULL OR run_size >= 0)',
      'ALTER TABLE followup_rollover_jobs ADD COLUMN IF NOT EXISTS business_days integer NOT NULL DEFAULT 1 CONSTRAINT followup_rollover_jobs_business_days_check CHECK (business_days IN (1, 2))',
    ]);
  });

  it("the Drizzle schema matches: integer, NOT NULL with today's default — max_records/dialer_max_records/run_size nullable with none", () => {
    const u = getTableColumns(users);
    const s = getTableColumns(dialerSessions);
    const j = getTableColumns(followupRolloverJobs);
    for (const [col, name, dflt] of [
      [u.dialerPasses, 'dialer_passes', 2],
      [u.dialerRolloverBusinessDays, 'dialer_rollover_business_days', 1],
      [s.passes, 'passes', 2],
      [s.rolloverBusinessDays, 'rollover_business_days', 1],
      [j.businessDays, 'business_days', 1],
    ] as const) {
      expect(col.name).toBe(name);
      expect(col.columnType).toBe('PgInteger');
      expect(col.notNull).toBe(true);
      expect(col.default).toBe(dflt);
    }
    for (const [col, name] of [
      [s.maxRecords, 'max_records'],
      [u.dialerMaxRecords, 'dialer_max_records'],
      [s.runSize, 'run_size'],
    ] as const) {
      expect(col.name).toBe(name);
      expect(col.columnType).toBe('PgInteger');
      expect(col.notNull).toBe(false);
      expect(col.hasDefault).toBe(false);
    }
  });
});

/**
 * 0048_talk_time.sql — calls.talk_seconds + dialer_rep_legs, pinned.
 *
 * Read from disk rather than applied (no database in the unit suite), so the
 * file's text IS the contract. Load-bearing: talk time is a NEW column —
 * duration_seconds is untouched because the reputation engine reads it — and
 * dialer_rep_legs has a FULL unique index on call_sid, which
 * dialer/rep-legs.ts's bare ON CONFLICT DO NOTHING needs (a PARTIAL one fails
 * every insert with 42P10).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DIALER_REP_LEG_END_SOURCES, calls, dialerRepLegs } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0048_talk_time.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0048_talk_time', () => {
  it('adds calls.talk_seconds idempotently and touches no other calls column', () => {
    expect(statements.filter((s) => s.startsWith('ALTER TABLE'))).toEqual([
      'ALTER TABLE "calls" ADD COLUMN IF NOT EXISTS "talk_seconds" integer',
    ]);
    expect(statements.join(' ')).not.toContain('duration_seconds');
  });

  it('creates dialer_rep_legs idempotently with every column, FK-free', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "dialer_rep_legs" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL',
      '"user_id" uuid NOT NULL',
      '"session_id" uuid NOT NULL',
      '"call_sid" text NOT NULL',
      '"joined_at" timestamptz NOT NULL DEFAULT now()',
      '"ended_at" timestamptz',
      '"end_source" text',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
    expect(create).not.toContain('REFERENCES');
  });

  it('CHECKs end_source against exactly the schema constant, NULL while the leg is open', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    const list = DIALER_REP_LEG_END_SOURCES.map((x) => `'${x}'`).join(',');
    expect(create).toContain(
      `CONSTRAINT "dialer_rep_legs_end_source_check" CHECK ("end_source" IS NULL OR "end_source" IN (${list}))`,
    );
  });

  it('call_sid has a FULL unique index (no WHERE) — the bare ON CONFLICT arbiter', () => {
    expect(statements).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "dialer_rep_legs_call_sid_unique" ON "dialer_rep_legs" ("call_sid")',
    );
  });

  it('indexes the report scan (org_id, joined_at)', () => {
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "dialer_rep_legs_org_joined_idx" ON "dialer_rep_legs" ("org_id", "joined_at")',
    );
  });

  it('the drizzle tables match: same names, same indexes, no foreign keys, a nullable integer talk_seconds', () => {
    const cfg = getTableConfig(dialerRepLegs);
    expect(cfg.name).toBe('dialer_rep_legs');
    expect(cfg.foreignKeys).toHaveLength(0);
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
      'dialer_rep_legs_call_sid_unique',
      'dialer_rep_legs_org_joined_idx',
    ]);
    const unique = cfg.indexes.find((i) => i.config.name === 'dialer_rep_legs_call_sid_unique')!;
    expect(unique.config.unique).toBe(true);
    expect(unique.config.where).toBeUndefined();
    const talk = getTableConfig(calls).columns.find((c) => c.name === 'talk_seconds');
    expect(talk?.columnType).toBe('PgInteger');
    expect(talk?.notNull).toBe(false);
  });
});

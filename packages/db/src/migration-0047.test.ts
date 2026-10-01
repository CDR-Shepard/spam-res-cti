/**
 * 0047_dialer_connects.sql — one row per bridged power-dial call, pinned.
 *
 * Read from disk rather than applied (no database in the unit suite), so the
 * file's text IS the contract. The load-bearing line is the FULL unique index
 * on call_sid: dialer/connect-log.ts inserts with a bare ON CONFLICT DO NOTHING
 * so a re-delivered AMD "human" for the same call writes nothing. A PARTIAL
 * unique index cannot arbitrate a bare ON CONFLICT (42P10 on every insert —
 * the calls_provider_call_id_unique incident).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DIALER_CONNECT_RECORDING_STATES, DIALER_CONNECT_TASK_STATES, dialerConnects } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0047_dialer_connects.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0047_dialer_connects', () => {
  it('creates the table idempotently with every column the design names, FK-free', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "dialer_connects" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL',
      '"user_id" uuid NOT NULL',
      '"sf_user_id" text NOT NULL',
      '"session_id" uuid NOT NULL',
      '"item_id" uuid NOT NULL',
      '"call_sid" text NOT NULL',
      '"object_type" text NOT NULL',
      '"record_id" text NOT NULL',
      '"from_number" text NOT NULL',
      '"to_number" text NOT NULL',
      '"bridged_at" timestamptz NOT NULL DEFAULT now()',
      '"ended_at" timestamptz',
      '"talk_seconds" integer',
      '"recording_state" text NOT NULL DEFAULT \'pending\'',
      '"recording_url" text',
      '"task_state" text NOT NULL DEFAULT \'pending\'',
      '"task_attempts" integer NOT NULL DEFAULT 0',
      '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
      '"last_error" text',
      '"salesforce_task_id" text',
      '"link_attempts" integer NOT NULL DEFAULT 0',
      '"recording_link_synced_at" timestamptz',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
    expect(create).not.toContain('REFERENCES');
  });

  it('CHECKs the two state columns against exactly the schema constants', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'))!;
    const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(',');
    expect(create).toContain(
      `CONSTRAINT "dialer_connects_recording_state_check" CHECK ("recording_state" IN (${list(DIALER_CONNECT_RECORDING_STATES)}))`,
    );
    expect(create).toContain(
      `CONSTRAINT "dialer_connects_task_state_check" CHECK ("task_state" IN (${list(DIALER_CONNECT_TASK_STATES)}))`,
    );
  });

  it('call_sid has a FULL unique index (no WHERE) — the bare ON CONFLICT arbiter', () => {
    const idx = statements.find((s) => s.includes('"dialer_connects_call_sid_unique"'));
    expect(idx).toBe('CREATE UNIQUE INDEX IF NOT EXISTS "dialer_connects_call_sid_unique" ON "dialer_connects" ("call_sid")');
  });

  it('indexes the worker scan (task_state, next_attempt_at)', () => {
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "dialer_connects_task_due_idx" ON "dialer_connects" ("task_state", "next_attempt_at")',
    );
  });

  it('the drizzle table matches: same name, same indexes, no foreign keys', () => {
    const cfg = getTableConfig(dialerConnects);
    expect(cfg.name).toBe('dialer_connects');
    expect(cfg.foreignKeys).toHaveLength(0);
    expect(cfg.indexes.map((i) => i.config.name).sort()).toEqual([
      'dialer_connects_call_sid_unique',
      'dialer_connects_task_due_idx',
    ]);
    const unique = cfg.indexes.find((i) => i.config.name === 'dialer_connects_call_sid_unique')!;
    expect(unique.config.unique).toBe(true);
    expect(unique.config.where).toBeUndefined();
  });
});

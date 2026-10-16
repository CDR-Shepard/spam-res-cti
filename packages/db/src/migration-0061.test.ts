/**
 * 0061_inbound_agent_testing.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { AI_AGENT_PROMPT_KINDS } from './schema-outreach-ai-prompts.js';
import { aiTestPhones } from './schema-outreach-ai-test-phones.js';
import * as schema from './schema.js';
import { AI_CALL_DIRECTIONS, aiCalls } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0061_inbound_agent_testing.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const create = statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "ai_test_phones"'));
/** The column / constraint lines of the CREATE TABLE, in order. */
const lines = (create ?? '')
  .replace(/^CREATE TABLE IF NOT EXISTS "[a-z_]+" \(\s*/, '')
  .replace(/\s*\)$/, '')
  .split(/,\s*(?="[a-z_0-9]+" [a-z]|CONSTRAINT)/)
  .map((l) => l.trim());

const DIRECTION_ALTER =
  `ALTER TABLE "ai_calls" ADD COLUMN IF NOT EXISTS "direction" text NOT NULL DEFAULT 'outbound' ` +
  `CONSTRAINT "ai_calls_direction_check" CHECK ("direction" IN ('outbound', 'inbound'))`;
const KIND_DROP = 'ALTER TABLE "ai_agent_prompts" DROP CONSTRAINT IF EXISTS "ai_agent_prompts_kind_check"';
const KIND_ADD =
  'ALTER TABLE "ai_agent_prompts" ADD CONSTRAINT "ai_agent_prompts_kind_check" ' +
  `CHECK ("kind" IN ('instructions', 'voicemail', 'inbound'))`;

const LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"e164" text NOT NULL',
  `"label" text NOT NULL DEFAULT ''`,
  '"added_by" uuid NOT NULL REFERENCES "users"("id")',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  'CONSTRAINT "ai_test_phones_org_e164_unique" UNIQUE ("org_id", "e164")',
];

describe('migration 0061_inbound_agent_testing', () => {
  it('starts with the lock_timeout guard (it locks ai_calls, ai_agent_prompts, organizations and users)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(raw).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('adds ai_calls.direction: NOT NULL, defaulting to outbound (every existing row is an outbound call), with its CHECK', () => {
    expect(statements).toContain(DIRECTION_ALTER);
    expect(AI_CALL_DIRECTIONS).toEqual(['outbound', 'inbound']);
    expect(DIRECTION_ALTER).toContain(`CHECK ("direction" IN (${quoted(AI_CALL_DIRECTIONS)}))`);
  });

  it('widens the ai_agent_prompts kind CHECK to three kinds: drop and re-add under the same name', () => {
    expect(statements).toContain(KIND_DROP);
    expect(statements).toContain(KIND_ADD);
    expect(statements.indexOf(KIND_DROP)).toBeLessThan(statements.indexOf(KIND_ADD));
  });

  it('the kind CHECK matches the schema value list', () => {
    expect(AI_AGENT_PROMPT_KINDS).toEqual(['instructions', 'voicemail', 'inbound']);
    expect(KIND_ADD).toContain(`CHECK ("kind" IN (${quoted(AI_AGENT_PROMPT_KINDS)}))`);
  });

  it('creates ai_test_phones with exactly these columns, the org FK and the per-org unique number', () => {
    expect(create).toBeDefined();
    expect(lines).toEqual(LINES);
  });

  it('the people on the list are tied to the org (cascade) and to the admin who added them', () => {
    expect(lines.find((l) => l.startsWith('"org_id"'))).toMatch(/NOT NULL REFERENCES "organizations"\("id"\) ON DELETE CASCADE$/);
    // NOT NULL, so no SET NULL: removing a user who added phones is refused rather than orphaning the row.
    expect(lines.find((l) => l.startsWith('"added_by"'))).toBe('"added_by" uuid NOT NULL REFERENCES "users"("id")');
  });

  it('has exactly these statements, in order: the hot ai_calls table is changed LAST (final review M-4)', () => {
    // The file runs in one transaction and every lock is held until commit: taking ai_calls' ACCESS EXCLUSIVE lock last
    // keeps live calls' writes from waiting behind the organizations/users FK locks the CREATE TABLE may wait for.
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "ai_test_phones"/),
      KIND_DROP,
      KIND_ADD,
      DIRECTION_ALTER,
    ]);
    expect(statements.findIndex((s) => s.includes('"ai_calls"'))).toBe(statements.length - 1);
  });

  it('never rewrites or deletes data: no UPDATE, DELETE, TRUNCATE or DROP TABLE/COLUMN', () => {
    expect(statements.join('; ')).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE|DROP TABLE|DROP COLUMN)\b/i);
  });

  it('matches the Drizzle ai_calls.direction column', () => {
    const col = getTableConfig(aiCalls).columns.find((c) => c.name === 'direction');
    expect(col?.columnType).toBe('PgText');
    expect(col?.notNull).toBe(true);
    expect(col?.default).toBe('outbound');
  });

  it('matches the Drizzle aiTestPhones table', () => {
    const config = getTableConfig(aiTestPhones);
    expect(config.name).toBe('ai_test_phones');
    expect(config.columns.map((c) => ({ name: c.name, notNull: c.notNull }))).toEqual(
      LINES.filter((l) => l.startsWith('"')).map((l) => ({
        name: l.slice(1, l.indexOf('"', 1)),
        notNull: / NOT NULL| PRIMARY KEY/.test(l),
      })),
    );
    expect(config.columns.find((c) => c.name === 'label')?.default).toBe('');
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.uniqueConstraints.map((u) => ({ name: u.name, columns: u.columns.map((c) => c.name) }))).toEqual([
      { name: 'ai_test_phones_org_e164_unique', columns: ['org_id', 'e164'] },
    ]);
  });

  it('is reachable through schema (@cti/db) like the other outreach tables', () => {
    expect(schema.aiTestPhones).toBe(aiTestPhones);
  });
});

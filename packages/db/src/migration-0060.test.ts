/**
 * 0060_ai_agent_prompts.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { AI_AGENT_PROMPT_KINDS, aiAgentPrompts } from './schema-outreach-ai-prompts.js';
import * as schema from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0060_ai_agent_prompts.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const create = statements.find((s) => s.startsWith('CREATE TABLE IF NOT EXISTS "ai_agent_prompts"'));
/** The column / constraint lines of the CREATE TABLE, in order. */
const lines = (create ?? '')
  .replace(/^CREATE TABLE IF NOT EXISTS "[a-z_]+" \(\s*/, '')
  .replace(/\s*\)$/, '')
  .split(/,\s*(?="|CONSTRAINT)/)
  .map((l) => l.trim());

const LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"kind" text NOT NULL',
  '"body" text',
  '"created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  `CONSTRAINT "ai_agent_prompts_kind_check" CHECK ("kind" IN ('instructions', 'voicemail'))`,
];

const INDEX = 'CREATE INDEX IF NOT EXISTS "ai_agent_prompts_active_idx" ON "ai_agent_prompts" ("org_id", "kind", "created_at" DESC)';

describe('migration 0060_ai_agent_prompts', () => {
  it('starts with the lock_timeout guard (the FKs lock organizations and users)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(raw).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('creates ai_agent_prompts with exactly these columns and the kind CHECK', () => {
    expect(create).toBeDefined();
    expect(lines).toEqual(LINES);
  });

  it('the CHECK matches the schema value list', () => {
    expect(create).toContain(`CHECK ("kind" IN (${quoted(AI_AGENT_PROMPT_KINDS)}))`);
    expect(AI_AGENT_PROMPT_KINDS).toEqual(['instructions', 'voicemail']);
  });

  it('body is nullable (NULL means the built-in default) and nothing else is', () => {
    expect(lines).toContain('"body" text');
    expect(lines.find((l) => l.startsWith('"body"'))).not.toMatch(/NOT NULL|DEFAULT/);
    expect(lines.find((l) => l.startsWith('"created_by"'))).not.toMatch(/NOT NULL/);
  });

  it('creates the active-version index (newest first per org and kind)', () => {
    expect(statements).toContain(INDEX);
  });

  it('is append-only: it only creates (no UPDATE, DELETE, ALTER or DROP statement), and has no unique index on a version', () => {
    for (const statement of statements) expect(statement).toMatch(/^(SET LOCAL|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS) /);
    expect(statements.join('; ')).not.toMatch(/UNIQUE/i);
  });

  it('has exactly these statements', () => {
    expect(statements).toEqual([`SET LOCAL lock_timeout = '5s'`, expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "ai_agent_prompts"/), INDEX]);
  });

  it('matches the Drizzle aiAgentPrompts table', () => {
    const config = getTableConfig(aiAgentPrompts);
    expect(config.name).toBe('ai_agent_prompts');
    expect(config.columns.map((c) => ({ name: c.name, notNull: c.notNull }))).toEqual(
      LINES.filter((l) => l.startsWith('"')).map((l) => ({
        name: l.slice(1, l.indexOf('"', 1)),
        notNull: / NOT NULL| PRIMARY KEY/.test(l),
      })),
    );
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.indexes.map((i) => i.config.name)).toEqual(['ai_agent_prompts_active_idx']);
  });

  it('is reachable through schema (@cti/db) like the other outreach tables', () => {
    expect(schema.aiAgentPrompts).toBe(aiAgentPrompts);
  });
});

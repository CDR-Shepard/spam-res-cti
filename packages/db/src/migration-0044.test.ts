/**
 * 0044_inbound_messages.sql — the inbox for texts to our numbers, pinned.
 *
 * Read from disk rather than applied: migrations here are hand-written raw SQL
 * with no database in the unit suite, so the file's text IS the contract.
 *
 * The load-bearing line is the unique index on `message_sid`. Twilio retries a
 * webhook it did not get a 200 for, and the backfill script re-reads history,
 * so the SAME text arrives more than once; the insert is ON CONFLICT DO NOTHING
 * and this index is what makes the second copy a no-op. It must be a FULL index:
 * Postgres cannot use a PARTIAL unique index as an ON CONFLICT arbiter unless
 * the statement repeats its predicate, and `calls_provider_call_id_unique`
 * (partial) once made every insert on that table fail with 42P10.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { INBOUND_MESSAGE_STATUSES, inboundMessages } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0044_inbound_messages.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0044_inbound_messages', () => {
  it('creates the table idempotently with every column the design names', () => {
    const create = statements.find((s) => s.startsWith('CREATE TABLE'));
    expect(create).toBeDefined();
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "inbound_messages" \(/);
    for (const col of [
      '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
      '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
      '"message_sid" text NOT NULL',
      '"from_e164" text NOT NULL',
      '"to_e164" text NOT NULL',
      '"body" text NOT NULL DEFAULT \'\'',
      '"num_media" integer NOT NULL DEFAULT 0',
      '"user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL',
      '"status" text NOT NULL DEFAULT \'pending\'',
      '"attempts" integer NOT NULL DEFAULT 0',
      '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
      '"last_error" text',
      '"sf_task_id" text',
      '"emailed_at" timestamptz',
      '"email_skip_reason" text',
      '"backfill" boolean NOT NULL DEFAULT false',
      '"received_at" timestamptz NOT NULL DEFAULT now()',
      '"created_at" timestamptz NOT NULL DEFAULT now()',
      '"updated_at" timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(create).toContain(col);
    }
  });

  it('refuses any status the worker does not know (in_flight is the claim state)', () => {
    expect(raw).toContain(
      "CONSTRAINT \"inbound_messages_status_check\" CHECK (\"status\" IN ('pending','in_flight','done','skipped','failed'))",
    );
    expect([...INBOUND_MESSAGE_STATUSES]).toEqual(['pending', 'in_flight', 'done', 'skipped', 'failed']);
  });

  it('dedupes on message_sid with a FULL (non-partial) unique index — a partial one breaks ON CONFLICT (42P10)', () => {
    const idx = statements.find((s) => s.includes('inbound_messages_message_sid_unique'));
    expect(idx).toBe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "inbound_messages_message_sid_unique" ON "inbound_messages" ("message_sid")',
    );
    expect(idx).not.toMatch(/ WHERE /i);
  });

  it("indexes the worker's scan: (status, next_attempt_at)", () => {
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "inbound_messages_status_idx" ON "inbound_messages" ("status", "next_attempt_at")',
    );
  });

  it("indexes the flood guard's lookup: (user_id, from_e164, emailed_at)", () => {
    expect(statements).toContain(
      'CREATE INDEX IF NOT EXISTS "inbound_messages_alert_idx" ON "inbound_messages" ("user_id", "from_e164", "emailed_at")',
    );
  });

  it('the Drizzle schema names the same columns, defaults and nullability as the SQL', () => {
    const c = getTableColumns(inboundMessages);
    expect(Object.values(c).map((col) => col.name).sort()).toEqual([
      'attempts', 'backfill', 'body', 'created_at', 'email_skip_reason', 'emailed_at', 'from_e164', 'id', 'last_error',
      'message_sid', 'next_attempt_at', 'num_media', 'org_id', 'received_at', 'sf_task_id', 'status', 'to_e164',
      'updated_at', 'user_id',
    ]);
    expect(c.status.default).toBe('pending');
    expect(c.attempts.default).toBe(0);
    expect(c.numMedia.default).toBe(0);
    expect(c.backfill.default).toBe(false);
    expect(c.body.default).toBe('');
    // Nullable on purpose: null IS "no rep", "not created yet", "not emailed yet".
    for (const col of [c.userId, c.sfTaskId, c.emailedAt, c.emailSkipReason, c.lastError]) expect(col.notNull).toBe(false);
    for (const col of [c.messageSid, c.fromE164, c.toE164, c.status, c.attempts, c.backfill, c.receivedAt]) {
      expect(col.notNull).toBe(true);
    }
  });

  it('the Drizzle schema declares the same full unique index and scan index', () => {
    const { indexes } = getTableConfig(inboundMessages);
    const sid = indexes.find((i) => i.config.name === 'inbound_messages_message_sid_unique');
    expect(sid?.config.unique).toBe(true);
    expect(sid?.config.where).toBeUndefined();
    expect(sid?.config.columns.map((col) => (col as { name: string }).name)).toEqual(['message_sid']);
    const scan = indexes.find((i) => i.config.name === 'inbound_messages_status_idx');
    expect(scan?.config.columns.map((col) => (col as { name: string }).name)).toEqual(['status', 'next_attempt_at']);
    const alert = indexes.find((i) => i.config.name === 'inbound_messages_alert_idx');
    expect(alert?.config.columns.map((col) => (col as { name: string }).name)).toEqual(['user_id', 'from_e164', 'emailed_at']);
  });
});

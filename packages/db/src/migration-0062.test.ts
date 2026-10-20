/**
 * 0062_seller_conversations.sql — pinned. Read from disk (no database in the unit
 * suite), so the file's text IS the contract. (Number provisional: renamed with this
 * file when it is rebased onto whatever migration landed first.)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import {
  CONVERSATION_ACTORS,
  CONVERSATION_EVENT_DIRECTIONS,
  CONVERSATION_EVENT_KINDS,
  CONVERSATION_HANDLERS,
  CONVERSATION_STATUSES,
  EMAIL_DIRECTIONS,
  EMAIL_PURPOSES,
  EMAIL_STATUSES,
  EMAIL_SUPPRESSION_REASONS,
  SF_LOG_STATUSES,
  WEBHOOK_EVENT_STATUSES,
  conversationEvents,
  emailMessages,
  emailSuppressions,
  resendWebhookEvents,
  sellerConversations,
} from './schema-outreach-conversations.js';
import * as schema from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0062_seller_conversations.sql'), 'utf8');
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);
const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');
const createOf = (table: string) => statements.find((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS "${table}"`));
/** The column / constraint lines of a CREATE TABLE, in order. */
const linesOf = (create: string | undefined) =>
  (create ?? '')
    .replace(/^CREATE TABLE IF NOT EXISTS "[a-z_]+" \(\s*/, '')
    .replace(/\s*\)$/, '')
    .split(/,\s*(?="[a-z_0-9]+" [a-z]|CONSTRAINT)/)
    .map((l) => l.trim());
const check = (table: string, column: string, values: readonly string[]) =>
  `CONSTRAINT "${table}_${column}_check" CHECK ("${column}" IN (${quoted(values)}))`;
const columnsOf = (t: Parameters<typeof getTableConfig>[0]) => getTableConfig(t).columns.map((c) => ({ name: c.name, notNull: c.notNull }));
/** The Drizzle columns a table's SQL column lines should declare (constraint lines excluded). */
const expectedColumns = (lines: readonly string[]) =>
  lines
    .filter((l) => l.startsWith('"'))
    .map((l) => ({ name: l.slice(1, l.indexOf('"', 1)), notNull: / NOT NULL| PRIMARY KEY/.test(l) }));
const dialect = new PgDialect();
const indexesOf = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).indexes.map((i) => ({
    name: i.config.name,
    unique: i.config.unique,
    columns: i.config.columns.map((c) => ('name' in c ? c.name : '?')),
    where: i.config.where ? dialect.sqlToQuery(i.config.where).sql.replace(/\s+/g, ' ').replace(/"/g, '') : null,
  }));

const CONVERSATION_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"crm_record_id" uuid NOT NULL REFERENCES "crm_records"("id") ON DELETE CASCADE',
  '"practice_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE',
  '"token" text NOT NULL',
  `"handler" text NOT NULL DEFAULT 'sam'`,
  '"handler_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"handler_changed_at" timestamptz',
  `"status" text NOT NULL DEFAULT 'open'`,
  '"stop_reason" text',
  '"flag_reason" text',
  '"flagged_at" timestamptz',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  '"updated_at" timestamptz NOT NULL DEFAULT now()',
  'CONSTRAINT "seller_conversations_token_unique" UNIQUE ("token")',
  check('seller_conversations', 'handler', CONVERSATION_HANDLERS),
  check('seller_conversations', 'status', CONVERSATION_STATUSES),
];

const EVENT_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL',
  '"conversation_id" uuid NOT NULL REFERENCES "seller_conversations"("id") ON DELETE CASCADE',
  '"kind" text NOT NULL',
  '"direction" text NOT NULL',
  '"actor" text NOT NULL',
  '"user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"occurred_at" timestamptz NOT NULL DEFAULT now()',
  '"subject" text',
  '"body" text',
  '"detail" text',
  `"meta" jsonb NOT NULL DEFAULT '{}'::jsonb`,
  `"sf_log_status" text NOT NULL DEFAULT 'skipped'`,
  '"sf_task_id" text',
  '"sf_log_attempts" integer NOT NULL DEFAULT 0',
  '"sf_log_next_at" timestamptz',
  '"sf_log_error" text',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  check('conversation_events', 'kind', CONVERSATION_EVENT_KINDS),
  check('conversation_events', 'direction', CONVERSATION_EVENT_DIRECTIONS),
  check('conversation_events', 'actor', CONVERSATION_ACTORS),
  check('conversation_events', 'sf_log_status', SF_LOG_STATUSES),
];

const EMAIL_LINES = [
  '"id" uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  '"org_id" uuid NOT NULL',
  '"conversation_id" uuid NOT NULL REFERENCES "seller_conversations"("id") ON DELETE CASCADE',
  '"event_id" uuid NOT NULL REFERENCES "conversation_events"("id") ON DELETE CASCADE',
  '"direction" text NOT NULL',
  '"status" text NOT NULL',
  '"purpose" text NOT NULL',
  '"to_address" text NOT NULL',
  '"from_address" text NOT NULL',
  '"in_reply_to" text',
  '"references" text',
  '"message_id" text',
  '"resend_id" text',
  '"send_after" timestamptz',
  '"attempts" integer NOT NULL DEFAULT 0',
  '"claimed_at" timestamptz',
  '"first_attempt_at" timestamptz',
  '"last_error" text',
  '"handled_at" timestamptz',
  '"touch_id" uuid REFERENCES "touches"("id") ON DELETE SET NULL',
  '"requested_by" uuid REFERENCES "users"("id") ON DELETE SET NULL',
  '"sent_at" timestamptz',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  '"updated_at" timestamptz NOT NULL DEFAULT now()',
  check('email_messages', 'direction', EMAIL_DIRECTIONS),
  check('email_messages', 'status', EMAIL_STATUSES),
  check('email_messages', 'purpose', EMAIL_PURPOSES),
];

const SUPPRESSION_LINES = [
  '"org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE',
  '"address" text NOT NULL',
  '"reason" text NOT NULL',
  '"conversation_id" uuid REFERENCES "seller_conversations"("id") ON DELETE SET NULL',
  '"created_at" timestamptz NOT NULL DEFAULT now()',
  'CONSTRAINT "email_suppressions_org_address_pk" PRIMARY KEY ("org_id", "address")',
  check('email_suppressions', 'reason', EMAIL_SUPPRESSION_REASONS),
];

const WEBHOOK_LINES = [
  '"svix_id" text PRIMARY KEY',
  '"type" text NOT NULL',
  '"payload" jsonb NOT NULL',
  `"status" text NOT NULL DEFAULT 'pending'`,
  '"attempts" integer NOT NULL DEFAULT 0',
  '"next_attempt_at" timestamptz NOT NULL DEFAULT now()',
  '"last_error" text',
  '"received_at" timestamptz NOT NULL DEFAULT now()',
  '"processed_at" timestamptz',
  check('resend_webhook_events', 'status', WEBHOOK_EVENT_STATUSES),
];

const INDEXES = [
  'CREATE UNIQUE INDEX IF NOT EXISTS "seller_conversations_record_unique" ON "seller_conversations" ("org_id", "crm_record_id") WHERE "practice_user_id" IS NULL',
  'CREATE UNIQUE INDEX IF NOT EXISTS "seller_conversations_practice_unique" ON "seller_conversations" ("org_id", "crm_record_id", "practice_user_id") WHERE "practice_user_id" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "conversation_events_conversation_idx" ON "conversation_events" ("conversation_id", "occurred_at")',
  `CREATE INDEX IF NOT EXISTS "conversation_events_sf_log_due_idx" ON "conversation_events" ("sf_log_next_at") WHERE "sf_log_status" = 'pending'`,
  'CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_event_unique" ON "email_messages" ("event_id")',
  'CREATE UNIQUE INDEX IF NOT EXISTS "email_messages_resend_unique" ON "email_messages" ("direction", "resend_id") WHERE "resend_id" IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS "email_messages_message_id_idx" ON "email_messages" ("message_id") WHERE "message_id" IS NOT NULL',
  `CREATE INDEX IF NOT EXISTS "email_messages_due_idx" ON "email_messages" ("send_after") WHERE "status" = 'queued'`,
  'CREATE INDEX IF NOT EXISTS "email_messages_conversation_idx" ON "email_messages" ("conversation_id", "created_at")',
  `CREATE INDEX IF NOT EXISTS "resend_webhook_events_due_idx" ON "resend_webhook_events" ("next_attempt_at") WHERE "status" = 'pending'`,
];

describe('migration 0062_seller_conversations', () => {
  it('starts with the lock_timeout guard (the FKs lock organizations, users, crm_records and touches)', () => {
    expect(statements[0]).toBe("SET LOCAL lock_timeout = '5s'");
    expect(raw).toMatch(/SET LOCAL lock_timeout = '5s';/);
  });

  it('creates seller_conversations with exactly these columns, the unique reply token and the handler/status CHECKs', () => {
    expect(linesOf(createOf('seller_conversations'))).toEqual(CONVERSATION_LINES);
  });

  it('creates conversation_events with exactly these columns and the kind/direction/actor/sf_log_status CHECKs', () => {
    expect(linesOf(createOf('conversation_events'))).toEqual(EVENT_LINES);
  });

  it('creates email_messages with exactly these columns and the direction/status/purpose CHECKs', () => {
    expect(linesOf(createOf('email_messages'))).toEqual(EMAIL_LINES);
  });

  it('creates email_suppressions keyed by (org_id, address) with the reason CHECK', () => {
    expect(linesOf(createOf('email_suppressions'))).toEqual(SUPPRESSION_LINES);
  });

  it('creates resend_webhook_events keyed by the Svix message id with the status CHECK', () => {
    expect(linesOf(createOf('resend_webhook_events'))).toEqual(WEBHOOK_LINES);
  });

  it('every CHECK lists exactly the schema constant, in order', () => {
    expect(CONVERSATION_HANDLERS).toEqual(['sam', 'person']);
    expect(CONVERSATION_STATUSES).toEqual(['open', 'booked', 'stopped']);
    expect(CONVERSATION_EVENT_KINDS).toEqual(['email', 'text', 'human_touch', 'handler', 'status', 'flag', 'note']);
    expect(CONVERSATION_EVENT_DIRECTIONS).toEqual(['in', 'out', 'none']);
    expect(CONVERSATION_ACTORS).toEqual(['sam', 'seller', 'person', 'system']);
    expect(SF_LOG_STATUSES).toEqual(['pending', 'done', 'failed', 'skipped']);
    expect(EMAIL_DIRECTIONS).toEqual(['out', 'in']);
    expect(EMAIL_STATUSES).toEqual(['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'canceled', 'received']);
    expect(EMAIL_PURPOSES).toEqual(['first', 'reply', 'holding', 'practice', 'inbound']);
    expect(EMAIL_SUPPRESSION_REASONS).toEqual(['opted_out', 'complained', 'bounced']);
    expect(WEBHOOK_EVENT_STATUSES).toEqual(['pending', 'done', 'failed', 'ignored']);
    const checks = statements.filter((s) => s.startsWith('CREATE TABLE')).flatMap((s) => linesOf(s)).filter((l) => l.includes(' CHECK '));
    expect(checks).toHaveLength(2 + 4 + 3 + 1 + 1);
  });

  it('stop_reason and flag_reason carry no CHECK, so a later step can add a reason without a migration', () => {
    const lines = linesOf(createOf('seller_conversations'));
    expect(lines.filter((l) => l.includes('"stop_reason"') || l.includes('"flag_reason"'))).toEqual(['"stop_reason" text', '"flag_reason" text']);
  });

  it('one conversation per record: two partial uniques split on practice_user_id (a practice one per admin)', () => {
    expect(statements).toContain(INDEXES[0]);
    expect(statements).toContain(INDEXES[1]);
  });

  it('one email row per timeline event (UNIQUE on event_id), and first_attempt_at is nullable: NULL means Resend never saw it', () => {
    expect(statements).toContain(INDEXES[4]);
    expect(linesOf(createOf('email_messages'))).toContain('"first_attempt_at" timestamptz');
  });

  it('indexes the timeline, the Salesforce-log scan, the Resend id dedupe, the Message-ID lookup, the send scan and the webhook scan', () => {
    for (const index of INDEXES) expect(statements).toContain(index);
  });

  it('has exactly these statements, in FK order: each table before the indexes that follow it', () => {
    expect(statements).toEqual([
      `SET LOCAL lock_timeout = '5s'`,
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "seller_conversations"/),
      INDEXES[0],
      INDEXES[1],
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "conversation_events"/),
      INDEXES[2],
      INDEXES[3],
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "email_messages"/),
      INDEXES[4],
      INDEXES[5],
      INDEXES[6],
      INDEXES[7],
      INDEXES[8],
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "email_suppressions"/),
      expect.stringMatching(/^CREATE TABLE IF NOT EXISTS "resend_webhook_events"/),
      INDEXES[9],
    ]);
  });

  it('only creates: no UPDATE, DELETE, TRUNCATE or DROP, and no ALTER of an existing table', () => {
    expect(statements.join('; ')).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE|DROP TABLE|DROP COLUMN|ALTER TABLE)\b/i);
  });

  it('matches the Drizzle sellerConversations table', () => {
    const config = getTableConfig(sellerConversations);
    expect(config.name).toBe('seller_conversations');
    expect(columnsOf(sellerConversations)).toEqual(expectedColumns(CONVERSATION_LINES));
    expect(config.columns.find((c) => c.name === 'handler')?.default).toBe('sam');
    expect(config.columns.find((c) => c.name === 'status')?.default).toBe('open');
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.uniqueConstraints.map((u) => ({ name: u.name, columns: u.columns.map((c) => c.name) }))).toEqual([
      { name: 'seller_conversations_token_unique', columns: ['token'] },
    ]);
    expect(indexesOf(sellerConversations)).toEqual([
      { name: 'seller_conversations_record_unique', unique: true, columns: ['org_id', 'crm_record_id'], where: 'practice_user_id IS NULL' },
      {
        name: 'seller_conversations_practice_unique',
        unique: true,
        columns: ['org_id', 'crm_record_id', 'practice_user_id'],
        where: 'practice_user_id IS NOT NULL',
      },
    ]);
  });

  it('matches the Drizzle conversationEvents table', () => {
    const config = getTableConfig(conversationEvents);
    expect(config.name).toBe('conversation_events');
    expect(columnsOf(conversationEvents)).toEqual(expectedColumns(EVENT_LINES));
    expect(config.columns.find((c) => c.name === 'sf_log_status')?.default).toBe('skipped');
    expect(config.columns.find((c) => c.name === 'sf_log_attempts')?.default).toBe(0);
    expect(config.columns.find((c) => c.name === 'meta')?.columnType).toBe('PgJsonb');
    expect(config.foreignKeys).toHaveLength(0);
    expect(indexesOf(conversationEvents)).toEqual([
      { name: 'conversation_events_conversation_idx', unique: false, columns: ['conversation_id', 'occurred_at'], where: null },
      { name: 'conversation_events_sf_log_due_idx', unique: false, columns: ['sf_log_next_at'], where: "sf_log_status = 'pending'" },
    ]);
  });

  it('matches the Drizzle emailMessages table', () => {
    const config = getTableConfig(emailMessages);
    expect(config.name).toBe('email_messages');
    expect(columnsOf(emailMessages)).toEqual(expectedColumns(EMAIL_LINES));
    expect(config.columns.find((c) => c.name === 'attempts')?.default).toBe(0);
    expect(config.foreignKeys).toHaveLength(0);
    expect(indexesOf(emailMessages)).toEqual([
      { name: 'email_messages_event_unique', unique: true, columns: ['event_id'], where: null },
      { name: 'email_messages_resend_unique', unique: true, columns: ['direction', 'resend_id'], where: 'resend_id IS NOT NULL' },
      { name: 'email_messages_message_id_idx', unique: false, columns: ['message_id'], where: 'message_id IS NOT NULL' },
      { name: 'email_messages_due_idx', unique: false, columns: ['send_after'], where: "status = 'queued'" },
      { name: 'email_messages_conversation_idx', unique: false, columns: ['conversation_id', 'created_at'], where: null },
    ]);
  });

  it('matches the Drizzle emailSuppressions table: primary key (org_id, address)', () => {
    const config = getTableConfig(emailSuppressions);
    expect(config.name).toBe('email_suppressions');
    expect(columnsOf(emailSuppressions)).toEqual(expectedColumns(SUPPRESSION_LINES));
    expect(config.foreignKeys).toHaveLength(0);
    expect(config.primaryKeys.map((p) => ({ name: p.getName(), columns: p.columns.map((c) => c.name) }))).toEqual([
      { name: 'email_suppressions_org_address_pk', columns: ['org_id', 'address'] },
    ]);
  });

  it('matches the Drizzle resendWebhookEvents table', () => {
    const config = getTableConfig(resendWebhookEvents);
    expect(config.name).toBe('resend_webhook_events');
    expect(columnsOf(resendWebhookEvents)).toEqual(expectedColumns(WEBHOOK_LINES));
    expect(config.columns.find((c) => c.name === 'svix_id')?.primary).toBe(true);
    expect(config.columns.find((c) => c.name === 'status')?.default).toBe('pending');
    expect(config.columns.find((c) => c.name === 'payload')?.columnType).toBe('PgJsonb');
    expect(config.foreignKeys).toHaveLength(0);
    expect(indexesOf(resendWebhookEvents)).toEqual([
      { name: 'resend_webhook_events_due_idx', unique: false, columns: ['next_attempt_at'], where: "status = 'pending'" },
    ]);
  });

  it('is reachable through schema (@cti/db) like the other outreach tables', () => {
    expect(schema.sellerConversations).toBe(sellerConversations);
    expect(schema.conversationEvents).toBe(conversationEvents);
    expect(schema.emailMessages).toBe(emailMessages);
    expect(schema.emailSuppressions).toBe(emailSuppressions);
    expect(schema.resendWebhookEvents).toBe(resendWebhookEvents);
    expect(schema.CONVERSATION_HANDLERS).toBe(CONVERSATION_HANDLERS);
  });
});

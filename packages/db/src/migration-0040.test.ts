/**
 * 0040_no_answer_chatter.sql — the NO-HISTORICAL-BACKFILL guard, pinned.
 *
 * The "No answer" Chatter worker sweeps every ended dialer session whose
 * `no_answer_chatter_at` is NULL. On the day the column is added, that is EVERY
 * session the dialer has ever run: without the closing UPDATE the first boot
 * would post "No answer" on thousands of months-old records, authored by the
 * reps, with no way to take it back. The worker refuses anything older than 24h
 * on its own (pinned in no-answer-chatter-worker.test.ts) — this is the other
 * half of that belt-and-braces pair, and deleting either must fail a test.
 *
 * Read from disk rather than applied: migrations here are hand-written raw SQL
 * with no database in the unit suite, so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { dialerQueueItems, dialerSessions } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0040_no_answer_chatter.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0040_no_answer_chatter', () => {
  it('ENDS by marking swept every already-ended session AND every session (any status) not touched in 24h — no historical backfill', () => {
    // The second clause covers a run paused/ready for weeks and stopped after
    // the deploy: `stopSession` refreshes updated_at, so without this pre-stamp
    // the scan's 24h pre-filter would let it through.
    expect(statements[statements.length - 1]).toBe(
      'UPDATE dialer_sessions SET no_answer_chatter_at = now() WHERE no_answer_chatter_at IS NULL ' +
        "AND (status IN ('done','stopped') OR updated_at < now() - interval '24 hours')",
    );
  });

  it('adds every column idempotently (a re-run must not fail the deploy)', () => {
    const adds = statements.filter((s) => s.startsWith('ALTER TABLE'));
    expect(adds).toEqual([
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS no_answer_feed_item_id text',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS no_answer_skip_reason text',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_at timestamptz',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_claimed_at timestamptz',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_attempts integer NOT NULL DEFAULT 0',
      'ALTER TABLE dialer_sessions ADD COLUMN IF NOT EXISTS no_answer_chatter_next_at timestamptz',
    ]);
  });

  it('indexes exactly the rows the worker scans (ended + un-swept), idempotently', () => {
    const idx = statements.find((s) => s.startsWith('CREATE INDEX'));
    expect(idx).toBe(
      'CREATE INDEX IF NOT EXISTS dialer_sessions_no_answer_chatter_scan_idx ON dialer_sessions (updated_at) ' +
        "WHERE no_answer_chatter_at IS NULL AND status IN ('done','stopped')",
    );
  });

  it('the Drizzle schema names the same columns the SQL adds', () => {
    const sessionCols = Object.values(getTableColumns(dialerSessions)).map((c) => c.name);
    const itemCols = Object.values(getTableColumns(dialerQueueItems)).map((c) => c.name);
    expect(sessionCols).toEqual(expect.arrayContaining([
      'no_answer_chatter_at', 'no_answer_chatter_claimed_at', 'no_answer_chatter_attempts', 'no_answer_chatter_next_at',
    ]));
    expect(itemCols).toEqual(expect.arrayContaining(['no_answer_feed_item_id', 'no_answer_skip_reason']));
  });

  it('the schema agrees with the SQL that attempts is NOT NULL DEFAULT 0 — the claim does `attempts + 1`, and null + 1 is null forever', () => {
    const { noAnswerChatterAttempts: attempts } = getTableColumns(dialerSessions);
    expect(attempts.notNull).toBe(true);
    expect(attempts.hasDefault).toBe(true);
    expect(attempts.default).toBe(0);
    // The other three are nullable on purpose: null IS the "unclaimed / not swept / no floor" state.
    for (const c of [dialerSessions.noAnswerChatterAt, dialerSessions.noAnswerChatterClaimedAt, dialerSessions.noAnswerChatterNextAt]) {
      expect(c.notNull).toBe(false);
    }
  });

  it('the schema declares the same partial scan index as the SQL: on (updated_at), where un-swept and ended', () => {
    const idx = getTableConfig(dialerSessions).indexes.find((i) => i.config.name === 'dialer_sessions_no_answer_chatter_scan_idx');
    expect(idx).toBeDefined();
    expect(idx!.config.columns.map((c) => (c as { name: string }).name)).toEqual(['updated_at']);
    expect(idx!.config.unique).toBe(false);
    expect(new PgDialect().sqlToQuery(idx!.config.where!).sql).toBe(
      '"dialer_sessions"."no_answer_chatter_at" is null and "dialer_sessions"."status" in (\'done\',\'stopped\')',
    );
  });
});

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
  it('ENDS by marking every already-ended session as swept — no historical backfill', () => {
    expect(statements[statements.length - 1]).toBe(
      "UPDATE dialer_sessions SET no_answer_chatter_at = now() WHERE status IN ('done','stopped') AND no_answer_chatter_at IS NULL",
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
});

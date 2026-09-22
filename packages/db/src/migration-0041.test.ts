/**
 * 0041_dialer_item_display_name.sql — the name on the power-dial row, pinned.
 *
 * The panel headlines `display_name` from the first poll after a dial, so the
 * rep sees WHO is ringing before the record pops. The column must be nullable
 * (rows written before the migration, and records with no name, show the
 * number alone) and the add must be idempotent (a re-run must not fail the
 * deploy). Read from disk rather than applied: migrations here are hand-written
 * raw SQL with no database in the unit suite, so the file's text IS the contract.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { dialerQueueItems } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../migrations/0041_dialer_item_display_name.sql'), 'utf8');
/** Statements only: comments stripped, whitespace collapsed, split on `;`. */
const statements = raw
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join(' ')
  .split(';')
  .map((s) => s.replace(/\s+/g, ' ').trim())
  .filter((s) => s.length > 0);

describe('migration 0041_dialer_item_display_name', () => {
  it('adds the nullable column idempotently, and nothing else', () => {
    expect(statements).toEqual([
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS display_name text',
    ]);
  });

  it('the Drizzle schema names the same column, nullable, with no default', () => {
    const { displayName } = getTableColumns(dialerQueueItems);
    expect(displayName.name).toBe('display_name');
    expect(displayName.notNull).toBe(false);
    expect(displayName.hasDefault).toBe(false);
  });
});

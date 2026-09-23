import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { dialerDialAttempts, dialerQueueItems, dialerSessions } from './schema.js';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, '../migrations/0042_dialer_cadence.sql'), 'utf8');

describe('0042_dialer_cadence', () => {
  it('adds every column the cadence rules read, idempotently', () => {
    for (const stmt of [
      'ALTER TABLE dialer_sessions    ADD COLUMN IF NOT EXISTS list_view_id text;',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS list_position integer;',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS prospect_ended_at timestamptz;',
      'ALTER TABLE dialer_queue_items ADD COLUMN IF NOT EXISTS redial_of uuid;',
      'ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS record_id text;',
      'ALTER TABLE dialer_dial_attempts ADD COLUMN IF NOT EXISTS connected_at timestamptz;',
    ]) expect(sql).toContain(stmt);
  });
  it('adds the two indexes the checks run on', () => {
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS dialer_dial_attempts_record_idx ON dialer_dial_attempts (org_id, record_id, dialed_at);');
    expect(sql).toContain("CREATE INDEX IF NOT EXISTS calls_outbound_target_idx ON calls (org_id, normalized_to_number, created_at) WHERE direction = 'outbound';");
  });
  it('the Drizzle schema matches: nullable, no defaults', () => {
    const s = getTableColumns(dialerSessions); const i = getTableColumns(dialerQueueItems); const a = getTableColumns(dialerDialAttempts);
    expect(s.listViewId.name).toBe('list_view_id'); expect(s.listViewId.notNull).toBe(false);
    expect(i.listPosition.name).toBe('list_position'); expect(i.prospectEndedAt.name).toBe('prospect_ended_at'); expect(i.redialOf.name).toBe('redial_of');
    expect(a.recordId.name).toBe('record_id'); expect(a.connectedAt.name).toBe('connected_at');
    for (const c of [s.listViewId, i.listPosition, i.prospectEndedAt, i.redialOf, a.recordId, a.connectedAt]) { expect(c.notNull).toBe(false); expect(c.hasDefault).toBe(false); }
  });
});

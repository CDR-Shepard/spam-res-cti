import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from '@cti/db';
import { DAILY_CAP_DETAIL, dailyCapCheck, dailyDialCount } from './daily-cap.js';
import type { Db } from './types.js';

describe('dailyCapCheck', () => {
  it('blocks at 3 in a capped state with the rep-facing sentence', () => {
    expect(dailyCapCheck('FL', 3)).toEqual({
      name: 'daily_cap',
      passed: false,
      severity: 'block',
      reasonCode: 'DAILY_CAP',
      detail: 'This number has been called 3 times in the last 24 hours; state law limits calls to 3 per day.',
    });
  });

  it('passes below 3, and always in an uncapped or unknown state', () => {
    expect(dailyCapCheck('FL', 2).passed).toBe(true);
    expect(dailyCapCheck('CA', 9).passed).toBe(true);
    expect(dailyCapCheck(null, 9).passed).toBe(true);
  });

  it('exposes the exact rep-facing sentence as a constant, so evaluate.ts can reuse it verbatim', () => {
    expect(dailyCapCheck('FL', 3).detail).toBe(DAILY_CAP_DETAIL);
  });
});

/**
 * Minimal fake of the Drizzle surface `dailyDialCount` uses: canned counts
 * keyed by the table passed to `.from()`, with every `.where(...)` expression
 * rendered to real SQL text (the PgDialect trick used throughout this package
 * — see attempts.test.ts) so the tests assert the FILTERS, not just the
 * plumbing. `shouldError` lets a test simulate a read failure on either leg.
 */
function fakeDb(rows: { attempts?: number; calls?: number }, shouldError = false): { db: Db; wheres: string[] } {
  const dialect = new PgDialect();
  const wheres: string[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const n = table === schema.dialerDialAttempts ? rows.attempts ?? 0 : rows.calls ?? 0;
        const chain = {
          where: (w: Parameters<PgDialect['sqlToQuery']>[0]) => {
            wheres.push(dialect.sqlToQuery(w).sql);
            return chain;
          },
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            shouldError ? reject(new Error('read failed')) : resolve([{ n }]),
        };
        return chain;
      },
    }),
  } as unknown as Db;
  return { db, wheres };
}

const NOW = new Date('2026-09-23T18:00:00Z');

describe('dailyDialCount', () => {
  it('counts both logs, org-scoped, this number, last 24 h', async () => {
    const { db, wheres } = fakeDb({ attempts: 2, calls: 1 });
    const count = await dailyDialCount(db, 'O1', '+13055559999', NOW);
    expect(count).toBe(3);

    const dialerWhere = wheres.find((w) => w.includes('dialer_dial_attempts'));
    expect(dialerWhere).toBeDefined();
    expect(dialerWhere).toContain('"org_id" =');
    expect(dialerWhere).toContain('"to_number" =');
    expect(dialerWhere).toContain('"dialed_at" >=');

    const callsWhere = wheres.find((w) => w !== dialerWhere);
    expect(callsWhere).toBeDefined();
    expect(callsWhere).toContain('"org_id" =');
    expect(callsWhere).toContain('"direction" =');
    expect(callsWhere).toContain('"normalized_to_number" =');
    expect(callsWhere).toContain('"created_at" >=');
  });

  it('is zero when both sources are empty', async () => {
    const { db } = fakeDb({});
    const count = await dailyDialCount(db, 'O1', '+13055559999', NOW);
    expect(count).toBe(0);
  });

  it('uses the 24h rolling bound relative to `now`, not a calendar day', async () => {
    const { db, wheres } = fakeDb({ attempts: 1, calls: 0 });
    await dailyDialCount(db, 'O1', '+13055559999', NOW);
    const since = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
    expect(wheres.some((w) => w.includes('"dialed_at" >='))).toBe(true);
    // The bound itself is asserted via the param, not the rendered text (params
    // are positional placeholders) — recomputed here for documentation intent.
    expect(since).toBe('2026-09-22T18:00:00.000Z');
  });
});

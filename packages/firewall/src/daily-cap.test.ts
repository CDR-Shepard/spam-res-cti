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

/** One captured `.where(...)` call: which leg it belongs to, its rendered SQL
 *  text, and its bind params (positional — a placeholder in `sql` like `$3`
 *  says nothing about the VALUE bound to it, so tests that care about the
 *  bound value must read it from `params`, not `sql`). */
interface Capture {
  table: 'attempts' | 'calls';
  sql: string;
  params: unknown[];
}

/**
 * Minimal fake of the Drizzle surface `dailyDialCount` uses: canned counts
 * keyed by the table passed to `.from()`, with every `.where(...)` expression
 * rendered to real SQL text AND its bind params (the PgDialect trick used
 * throughout this package — see attempts.test.ts) so the tests assert the
 * FILTERS and the actual bound VALUES, not just the plumbing. `shouldError`
 * lets a test simulate a read failure on either leg.
 */
function fakeDb(rows: { attempts?: number; calls?: number }, shouldError = false): { db: Db; captures: Capture[] } {
  const dialect = new PgDialect();
  const captures: Capture[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const isAttempts = table === schema.dialerDialAttempts;
        const n = isAttempts ? rows.attempts ?? 0 : rows.calls ?? 0;
        const chain = {
          where: (w: Parameters<PgDialect['sqlToQuery']>[0]) => {
            const { sql: text, params } = dialect.sqlToQuery(w);
            captures.push({ table: isAttempts ? 'attempts' : 'calls', sql: text, params });
            return chain;
          },
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            shouldError ? reject(new Error('read failed')) : resolve([{ n }]),
        };
        return chain;
      },
    }),
  } as unknown as Db;
  return { db, captures };
}

const NOW = new Date('2026-09-23T18:00:00Z');

describe('dailyDialCount', () => {
  it('counts both logs, org-scoped, this number, last 24 h', async () => {
    const { db, captures } = fakeDb({ attempts: 2, calls: 1 });
    const count = await dailyDialCount(db, 'O1', '+13055559999', NOW);
    expect(count).toBe(3);

    const dialerWhere = captures.find((c) => c.table === 'attempts')!.sql;
    expect(dialerWhere).toContain('"org_id" =');
    expect(dialerWhere).toContain('"to_number" =');
    expect(dialerWhere).toContain('"dialed_at" >=');

    const callsWhere = captures.find((c) => c.table === 'calls')!.sql;
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

  /**
   * Pins the ACTUAL bound value bound to both queries — not just the SQL
   * text, which only shows a `$n` placeholder and would pass unchanged even
   * if the window were quietly changed (e.g. to DAILY_CAP_WINDOW_MS / 2, the
   * mutation this test exists to kill — see task-8-report.md "Fix round 1").
   * `expectedSince` is written as a literal 24h, independent of
   * DAILY_CAP_WINDOW_MS, so a changed constant is caught too, not just a
   * changed call site.
   */
  it('pins the 24h rolling bound as an actual value in both queries — not a calendar day', async () => {
    const { db, captures } = fakeDb({ attempts: 1, calls: 1 });
    await dailyDialCount(db, 'O1', '+13055559999', NOW);
    const expectedSince = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);

    const dialerParams = captures.find((c) => c.table === 'attempts')!.params;
    const callsParams = captures.find((c) => c.table === 'calls')!.params;

    // Params are positional and may come back as Date instances or as
    // driver-serialized ISO strings depending on the column's mapper — accept
    // either by round-tripping through `new Date(...)` and comparing by time.
    const hasBound = (params: unknown[]) =>
      params.some((p) => (p instanceof Date || typeof p === 'string') && new Date(p).getTime() === expectedSince.getTime());

    expect(hasBound(dialerParams)).toBe(true);
    expect(hasBound(callsParams)).toBe(true);

    expect(dialerParams).toContain('O1');
    expect(dialerParams).toContain('+13055559999');
    expect(callsParams).toContain('O1');
    expect(callsParams).toContain('+13055559999');
  });
});

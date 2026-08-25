import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { workedTodayNumbers, workedTodaySafe } from './already-worked.js';
import { orgMidnightUtc } from './org-day.js';

function fakeDb(rows: Array<{ toNumber: string }>, fail = false) {
  const where = vi.fn();
  return {
    _where: where,
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (cond: unknown) => { where(cond); if (fail) throw new Error('pg down'); return rows; }),
      })),
    })),
  } as never;
}

describe('workedTodayNumbers', () => {
  it('returns the distinct numbers the team dialed today', async () => {
    const db = fakeDb([{ toNumber: '+16195550100' }, { toNumber: '+12135550200' }]);
    const got = await workedTodayNumbers(db, 'O1', ['+16195550100', '+12135550200', '+19995550300']);
    expect(got).toEqual(new Set(['+16195550100', '+12135550200']));
  });
  it('short-circuits to an empty set with no candidate numbers (no query)', async () => {
    const db = fakeDb([]);
    expect(await workedTodayNumbers(db, 'O1', [])).toEqual(new Set());
    expect((db as { selectDistinct: ReturnType<typeof vi.fn> }).selectDistinct).not.toHaveBeenCalled();
  });

  /**
   * The predicate IS the feature: the returned set is only as trustworthy as
   * the three conditions that built it. Rendering the captured condition to
   * real SQL (the same PgDialect trick `engine.test.ts` uses on guarded
   * updates) pins all three — a dropped org scope would never surface in a
   * single-org production database, and a dropped/mis-computed day boundary
   * would silently skip numbers worked last week.
   */
  it('scopes the read to the org, exactly the candidate numbers, and this org-day\'s midnight', async () => {
    const db = fakeDb([]);
    const now = new Date('2026-08-24T18:00:00Z'); // 11:00 PDT — an ordinary LA workday
    const numbers = ['+16195550100', '+12135550200', '+19995550300'];

    await workedTodayNumbers(db, 'ORG-1', numbers, now);

    const cond = (db as { _where: ReturnType<typeof vi.fn> })._where.mock.calls[0]![0] as SQL;
    const { sql, params } = new PgDialect().sqlToQuery(cond);

    expect(sql).toContain('"dialer_dial_attempts"."org_id" = $1');
    expect(sql).toContain('"dialer_dial_attempts"."to_number" in ($2, $3, $4)');
    expect(sql).toContain('"dialer_dial_attempts"."dialed_at" >= $5');
    // One bound value per condition, in order — the org id, EVERY candidate
    // number (batched, none dropped), and the LA-midnight instant.
    expect(params).toEqual(['ORG-1', ...numbers, orgMidnightUtc(now).toISOString()]);
    // Spelled out so the boundary is readable without running the helper:
    // 00:00 PDT on Aug 24 is 07:00Z, not the server's UTC midnight.
    expect(orgMidnightUtc(now).toISOString()).toBe('2026-08-24T07:00:00.000Z');
  });
});

describe('workedTodaySafe — the one deliberate fail-open', () => {
  it('a query error yields an empty set and a warn, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await workedTodaySafe(fakeDb([], true), 'O1', ['+16195550100']);
      expect(got).toEqual(new Set());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('already-worked');
    } finally {
      warn.mockRestore();
    }
  });
});

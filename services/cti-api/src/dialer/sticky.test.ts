import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { LAST_DIAL_WINDOW_MS, lastDialerForCaller, stickyUpsertValues } from './sticky.js';

describe('stickyUpsertValues', () => {
  it('binds (org, agent, lead) → pool DID', () => {
    expect(stickyUpsertValues({ orgId: 'O', userId: 'U', leadE164: '+1619', poolDid: '+1213' })).toEqual({
      orgId: 'O', assignedUserId: 'U', recipientE164: '+1619', e164: '+1213',
    });
  });
});

/** Just enough drizzle for the one select in `lastDialerForCaller`, capturing
 *  every clause so the test can render each to real SQL. */
function fakeDb(rows: Array<{ userId: string }>) {
  const captured = { where: null as SQL | null, orderBy: [] as SQL[], limit: null as number | null };
  const chain = {
    where: vi.fn((cond: SQL) => { captured.where = cond; return chain; }),
    orderBy: vi.fn((...terms: SQL[]) => { captured.orderBy = terms; return chain; }),
    limit: vi.fn(async (n: number) => { captured.limit = n; return rows; }),
  };
  const select = vi.fn(() => ({ from: vi.fn(() => chain) }));
  return { db: { select } as never, select, captured };
}

const render = (s: SQL) => new PgDialect().sqlToQuery(s);

describe('lastDialerForCaller', () => {
  const ORG = 'ORG-1';
  const CALLER = '+13105550002';
  const POOL_DID = '+16195550100';

  it('returns the userId of the single row the query produced', async () => {
    const { db } = fakeDb([{ userId: 'rep-3' }]);
    expect(await lastDialerForCaller(db, ORG, CALLER, POOL_DID)).toBe('rep-3');
  });

  it('returns null when nobody in the org dialed the caller inside the window', async () => {
    const { db } = fakeDb([]);
    expect(await lastDialerForCaller(db, ORG, CALLER, POOL_DID)).toBeNull();
  });

  it('the window is 14 days', () => {
    expect(LAST_DIAL_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  /**
   * The statement IS the feature: a dropped org scope never surfaces in a
   * single-org production database, a dropped window rings whoever dialed the
   * number a year ago, and a dropped same-DID preference rings the wrong rep
   * when two reps dialed the same prospect from different pool numbers.
   */
  it('one query: org-scoped, this caller, inside the window, same-DID rows first then newest, limit 1', async () => {
    const { db, select, captured } = fakeDb([]);
    const now = new Date('2026-09-22T18:00:00Z');

    await lastDialerForCaller(db, ORG, CALLER, POOL_DID, now);

    expect(select).toHaveBeenCalledTimes(1);
    const where = render(captured.where!);
    expect(where.sql).toContain('"dialer_dial_attempts"."org_id" = $1');
    expect(where.sql).toContain('"dialer_dial_attempts"."to_number" = $2');
    expect(where.sql).toContain('"dialer_dial_attempts"."dialed_at" >= $3');
    expect(where.params).toEqual([ORG, CALLER, new Date(now.getTime() - LAST_DIAL_WINDOW_MS).toISOString()]);
    // Spelled out so the boundary is readable without running the helper.
    expect(where.params[2]).toBe('2026-09-08T18:00:00.000Z');

    // ORDER BY (from_number = <the DID they rang back>) DESC, dialed_at DESC:
    // Postgres sorts true after false, so DESC puts the same-DID rows first;
    // within a group, the most recent dial wins.
    expect(captured.orderBy).toHaveLength(2);
    const [preferSameDid, newest] = captured.orderBy.map(render);
    expect(preferSameDid!.sql).toBe('"dialer_dial_attempts"."from_number" = $1 desc');
    expect(preferSameDid!.params).toEqual([POOL_DID]);
    expect(newest!.sql).toBe('"dialer_dial_attempts"."dialed_at" desc');
    expect(newest!.params).toEqual([]);

    expect(captured.limit).toBe(1);
  });

  // Twilio sends these for a withheld caller ID; none was ever a dial target,
  // so the lookup answers without touching the table.
  it.each(['anonymous', 'Restricted', '+266696687', '', '+44207946000'])(
    'a caller that is not a +1 E.164 number (%j) → null, no query',
    async (caller) => {
      const { db, select } = fakeDb([{ userId: 'rep-3' }]);
      expect(await lastDialerForCaller(db, ORG, caller, POOL_DID)).toBeNull();
      expect(select).not.toHaveBeenCalled();
    },
  );
});

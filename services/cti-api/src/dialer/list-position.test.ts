import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { LIST_SHARE_WINDOW_MS, listContextFor, listStartPosition, rotateAfter } from './list-position.js';

describe('rotateAfter', () => {
  it('starts right after the furthest dialed position and wraps the rest to the end', () => {
    expect(rotateAfter(['a', 'b', 'c', 'd', 'e'], 1)).toEqual({
      ordered: ['c', 'd', 'e', 'a', 'b'], positions: [2, 3, 4, 0, 1], startedFrom: 2,
    });
  });

  it('null or a position at the end → the list as it is', () => {
    expect(rotateAfter(['a', 'b'], null)).toEqual({ ordered: ['a', 'b'], positions: [0, 1], startedFrom: 0 });
    expect(rotateAfter(['a', 'b'], 1)).toEqual({ ordered: ['a', 'b'], positions: [0, 1], startedFrom: 0 });
  });

  it('a position PAST the end (stale — the list shrank since) also wraps to the top', () => {
    expect(rotateAfter(['a', 'b', 'c'], 99)).toEqual({ ordered: ['a', 'b', 'c'], positions: [0, 1, 2], startedFrom: 0 });
  });

  it('a single-record list always starts at 0', () => {
    expect(rotateAfter(['a'], 0)).toEqual({ ordered: ['a'], positions: [0], startedFrom: 0 });
  });
});

/** Chainable fake matching the query shape: select → from → 3x innerJoin →
 *  where → groupBy (the terminal, awaited link — mirrors already-worked.test.ts
 *  and contact-history-live.test.ts's fakes for the same drizzle chain shape). */
function fakeDb(rows: Array<{ position: number | null; userId: string; name: string | null }>) {
  const wheres: SQL[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: SQL) => { wheres.push(w); return chain; },
    groupBy: () => Promise.resolve(rows),
  };
  const db = { select: vi.fn(() => chain) };
  return { db: db as never, wheres };
}

describe('listStartPosition', () => {
  it('pins: org, list view, 12h bound (as a literal now - 12h), and the shape of the group-by read', async () => {
    const now = new Date('2026-09-23T18:00:00Z');
    const { db, wheres } = fakeDb([]);

    await listStartPosition(db, 'ORG-1', '00B000000000001AAA', now);

    expect(wheres).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(wheres[0]!);
    expect(sql).toContain('"dialer_sessions"."org_id" = $1');
    expect(sql).toContain('"dialer_sessions"."list_view_id" = $2');
    expect(sql).toContain('"dialer_dial_attempts"."dialed_at" >= $3');
    expect(params).toEqual(['ORG-1', '00B000000000001AAA', new Date(now.getTime() - 12 * 60 * 60_000).toISOString()]);
    // Spelled out so the boundary is readable without running the helper, and
    // cross-checked against the exported constant so the two never drift.
    expect(LIST_SHARE_WINDOW_MS).toBe(12 * 60 * 60_000);
    expect(new Date(now.getTime() - 12 * 60 * 60_000).toISOString()).toBe('2026-09-23T06:00:00.000Z');
  });

  it('returns the max position across every rep who dialed the list, with distinct workedBy ids/names', async () => {
    const { db } = fakeDb([
      { position: 42, userId: 'U-GARRETT', name: 'Garrett' },
      { position: 87, userId: 'U-DANNY', name: 'Danny' },
    ]);
    const got = await listStartPosition(db, 'O1', 'L1', new Date());
    expect(got).toEqual({
      position: 87,
      workedBy: [{ userId: 'U-GARRETT', name: 'Garrett' }, { userId: 'U-DANNY', name: 'Danny' }],
    });
  });

  it('a null display name reads as "Someone" rather than dropping the row', async () => {
    const { db } = fakeDb([{ position: 5, userId: 'U1', name: null }]);
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toEqual({
      position: 5, workedBy: [{ userId: 'U1', name: 'Someone' }],
    });
  });

  it('nobody dialed this list in the window → null (queue starts at the top)', async () => {
    const { db } = fakeDb([]);
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toBeNull();
  });

  it('a grouped row whose max is null (a session with no positioned items) is ignored', async () => {
    const { db } = fakeDb([{ position: null, userId: 'U1', name: 'Garrett' }]);
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toBeNull();
  });
});

describe('listContextFor', () => {
  const items = [
    { attempt: 1, ordinal: 0, listPosition: 87 },
    { attempt: 1, ordinal: 1, listPosition: 88 },
    { attempt: 1, ordinal: 2, listPosition: 0 },
    // An attempt-2 retry row: must not be counted in `total`, and its ordinal
    // (appended past the max) must never be mistaken for the ordinal-0 row.
    { attempt: 2, ordinal: 3, listPosition: 87 },
  ];

  it('no list view on the session → null, no read attempted', async () => {
    const readShared = vi.fn();
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: null, status: 'ready' }, items, 'U-ME', new Date(), readShared,
    );
    expect(got).toBeNull();
    expect(readShared).not.toHaveBeenCalled();
  });

  it('status "ready": runs the join, excludes the requesting rep by id, and reports total/startedFrom from the rows alone', async () => {
    const readShared = vi.fn(async () => ({
      position: 87,
      workedBy: [{ userId: 'U-GARRETT', name: 'Garrett' }, { userId: 'U-ME', name: 'Me' }],
    }));
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, items, 'U-ME', new Date(), readShared,
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: ['Garrett'] });
    expect(readShared).toHaveBeenCalledOnce();
  });

  it('a redial copy (attempt 1, redialOf set) is excluded from `total` — Task 11 fix-round-1 Minor: it is not part of the queue creation built, same as an attempt-2 retry', async () => {
    const withRedial = [...items, { attempt: 1, ordinal: 4, listPosition: 87, redialOf: 'i1' }];
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, withRedial, 'U-ME', new Date(), vi.fn(async () => null),
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
  });

  /**
   * The controller decision this whole function exists to satisfy: the panel
   * polls every 1-2s, and `workedBy`'s join is org-wide across every session
   * on the list view — running it on every poll of an `active` run would
   * multiply that query by the poll rate for a line that is never shown again
   * once dialing starts. Every non-`ready` status must skip the read outright.
   */
  it.each(['active', 'paused', 'stopped', 'done'])('status %s: never runs the join — workedBy is empty, no read', async (status) => {
    const readShared = vi.fn();
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status }, items, 'U-ME', new Date(), readShared,
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
    expect(readShared).not.toHaveBeenCalled();
  });

  it('a start position exists but only the requesting rep dialed it: workedBy is empty (not "someone")', async () => {
    const readShared = vi.fn(async () => ({ position: 87, workedBy: [{ userId: 'U-ME', name: 'Me' }] }));
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, items, 'U-ME', new Date(), readShared,
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
  });

  it('nobody has dialed the list in the window (readShared → null): workedBy is empty', async () => {
    const readShared = vi.fn(async () => null);
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, items, 'U-ME', new Date(), readShared,
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
  });

  it('a thrown read fails open: total/startedFrom still come back, workedBy is empty, and it warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const readShared = vi.fn(async () => { throw new Error('pg down'); });
      const got = await listContextFor(
        {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, items, 'U-ME', new Date(), readShared,
      );
      expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('no ordinal-0 row (an empty/odd queue): startedFrom defaults to 0', async () => {
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'active' }, [], 'U-ME', new Date(), vi.fn(),
    );
    expect(got).toEqual({ total: 0, startedFrom: 0, workedBy: [] });
  });
});

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

/**
 * Chainable fake for PINNING the exact SQL of the two queries
 * `listStartPosition` now issues: the "most recent dial" lookup (terminal
 * `.orderBy().limit()`) and the "who worked this list" lookup (terminal
 * `.groupBy()`, unchanged shape from before). Both share the same
 * select → from → innerJoin(s) → where prefix, so one fake chain serves
 * either, dispatching on whichever terminal method is actually called.
 * Mirrors already-worked.test.ts / contact-history-live.test.ts's fakes for
 * the same drizzle chain shape.
 */
function fakeDb(opts: {
  latest?: Array<{ position: number | null }>;
  workers?: Array<{ userId: string; name: string | null }>;
} = {}) {
  const wheres: SQL[] = [];
  const orderBys: unknown[][] = [];
  const limits: number[] = [];
  const chain: {
    from: () => typeof chain;
    innerJoin: () => typeof chain;
    where: (w: SQL) => typeof chain;
    orderBy: (...args: unknown[]) => typeof chain;
    limit: (n: number) => Promise<Array<{ position: number | null }>>;
    groupBy: () => Promise<Array<{ userId: string; name: string | null }>>;
  } = {
    from: () => chain,
    innerJoin: () => chain,
    where: (w: SQL) => { wheres.push(w); return chain; },
    orderBy: (...args: unknown[]) => { orderBys.push(args); return chain; },
    limit: (n: number) => { limits.push(n); return Promise.resolve(opts.latest ?? []); },
    groupBy: () => Promise.resolve(opts.workers ?? []),
  };
  const db = { select: vi.fn(() => chain) };
  return { db: db as never, wheres, orderBys, limits };
}

/**
 * Fake that behaves like the real two queries against a growing table of
 * `dialer_dial_attempts` fixture rows — used for the end-to-end wrap/continue/
 * concurrency scenarios below, where what matters is that the RIGHT row wins,
 * not the literal SQL text (that's pinned separately, above).
 */
function fakeDbFromAttempts(
  attempts: ReadonlyArray<{ position: number | null; userId: string; name: string | null; dialedAt: Date }>,
) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => {
      const positioned = attempts.filter((a) => a.position != null);
      const latest = [...positioned].sort((a, b) => b.dialedAt.getTime() - a.dialedAt.getTime())[0];
      return Promise.resolve(latest ? [{ position: latest.position }] : []);
    },
    groupBy: () => {
      const seen = new Map<string, string | null>();
      for (const a of attempts) if (!seen.has(a.userId)) seen.set(a.userId, a.name);
      return Promise.resolve([...seen.entries()].map(([userId, name]) => ({ userId, name })));
    },
  };
  const db = { select: vi.fn(() => chain) };
  return { db: db as never };
}

describe('listStartPosition', () => {
  it('pins: org, list view, 12h bound (as a literal now - 12h), and the shape of BOTH reads — the most-recent-dial lookup (ORDER BY dialed_at DESC, a stable tiebreak, LIMIT 1) and the who-worked-it lookup', async () => {
    const now = new Date('2026-09-23T18:00:00Z');
    // A non-empty `latest` so the function doesn't short-circuit before the
    // second (workers) query — both reads are what this test pins.
    const { db, wheres, orderBys, limits } = fakeDb({ latest: [{ position: 5 }] });

    await listStartPosition(db, 'ORG-1', '00B000000000001AAA', now);

    // Two queries now, not one: the frontier (most-recent-dial) lookup, then
    // the distinct-reps lookup. Both share the same WHERE scope.
    expect(wheres).toHaveLength(2);
    for (const w of wheres) {
      const { sql, params } = new PgDialect().sqlToQuery(w);
      expect(sql).toContain('"dialer_sessions"."org_id" = $1');
      expect(sql).toContain('"dialer_sessions"."list_view_id" = $2');
      expect(sql).toContain('"dialer_dial_attempts"."dialed_at" >= $3');
      expect(params).toEqual(['ORG-1', '00B000000000001AAA', new Date(now.getTime() - 12 * 60 * 60_000).toISOString()]);
    }
    // Only the frontier query orders and limits — the workers query still
    // reads every distinct rep in the window.
    expect(orderBys).toHaveLength(1);
    expect(limits).toEqual([1]);
    // Only the FIRST (frontier) query excludes unpositioned rows — a row with
    // no stamped list_position can't anchor a frontier. The workers query
    // (built second) counts every rep regardless.
    expect(new PgDialect().sqlToQuery(wheres[0]!).sql).toContain('is not null');
    expect(new PgDialect().sqlToQuery(wheres[1]!).sql).not.toContain('is not null');
    // Spelled out so the boundary is readable without running the helper, and
    // cross-checked against the exported constant so the two never drift.
    expect(LIST_SHARE_WINDOW_MS).toBe(12 * 60 * 60_000);
    expect(new Date(now.getTime() - 12 * 60 * 60_000).toISOString()).toBe('2026-09-23T06:00:00.000Z');
  });

  it('the frontier query orders by dialed_at DESC with a stable tiebreak', async () => {
    const { db, orderBys } = fakeDb({});
    await listStartPosition(db, 'O1', 'L1', new Date());
    expect(orderBys).toHaveLength(1);
    const rendered = orderBys[0]!.map((c) => new PgDialect().sqlToQuery(c as SQL).sql);
    expect(rendered).toEqual(['"dialer_dial_attempts"."dialed_at" desc', '"dialer_dial_attempts"."id" desc']);
  });

  it('takes the position of the MOST RECENT dial, not the highest position ever reached', async () => {
    const { db } = fakeDb({
      latest: [{ position: 40 }],
      workers: [{ userId: 'U-GARRETT', name: 'Garrett' }, { userId: 'U-DANNY', name: 'Danny' }],
    });
    const got = await listStartPosition(db, 'O1', 'L1', new Date());
    expect(got).toEqual({
      position: 40,
      workedBy: [{ userId: 'U-GARRETT', name: 'Garrett' }, { userId: 'U-DANNY', name: 'Danny' }],
    });
  });

  it('a null display name reads as "Someone" rather than dropping the row', async () => {
    const { db } = fakeDb({ latest: [{ position: 5 }], workers: [{ userId: 'U1', name: null }] });
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toEqual({
      position: 5, workedBy: [{ userId: 'U1', name: 'Someone' }],
    });
  });

  it('nobody dialed this list in the window → null (queue starts at the top)', async () => {
    const { db } = fakeDb({ latest: [], workers: [] });
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toBeNull();
  });

  it('the one row in the window has a null position (no positioned items) → null, ignored before the workers read even matters', async () => {
    const { db } = fakeDb({ latest: [], workers: [{ userId: 'U1', name: 'Garrett' }] });
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toBeNull();
  });

  // -------------------------------------------------------------------------
  // I1 (spec 2026-09-28 review, ruling: fix it): the OLD rule (MAX list_position
  // ever reached, across the whole 12h window) is sticky — once any dial ever
  // touches a high position, every later run wraps to 0 forever, because a
  // stale high-water-mark never ages out until the whole window does. The NEW
  // rule (the position of the MOST RECENT dial) tracks the ACTUAL frontier.
  // -------------------------------------------------------------------------
  describe('the frontier tracks the most recent dial, not a sticky historical max', () => {
    it('wrap: limited runs of 100 on a 200-record list alternate segments forever — 0–99, 100–199, 0–99, 100–199 — never getting stuck re-dialing one half', async () => {
      const LIST_LEN = 200;
      const RUN_SIZE = 100;
      const attempts: Array<{ position: number; userId: string; name: string | null; dialedAt: Date }> = [];
      let clock = new Date('2026-09-23T06:00:00Z').getTime();
      const dialSegment = (start: number) => {
        for (let k = 0; k < RUN_SIZE; k++) {
          clock += 1_000;
          attempts.push({ position: (start + k) % LIST_LEN, userId: 'U1', name: 'Rep', dialedAt: new Date(clock) });
        }
      };
      const nextStart = async () => {
        const { db } = fakeDbFromAttempts(attempts);
        const got = await listStartPosition(db, 'O1', 'L1', new Date(clock + 60_000));
        return rotateAfter(Array.from({ length: LIST_LEN }, (_, i) => i), got?.position ?? null).startedFrom;
      };

      expect(await nextStart()).toBe(0); // nothing dialed yet
      dialSegment(0); // run 1: 0..99
      expect(await nextStart()).toBe(100);
      dialSegment(100); // run 2: 100..199
      expect(await nextStart()).toBe(0);
      dialSegment(0); // run 3: 0..99 AGAIN
      expect(await nextStart()).toBe(100); // run 4 must continue at 100 — not re-wrap
      dialSegment(100); // run 4: 100..199
      expect(await nextStart()).toBe(0);
    });

    it('a 150-of-200 run followed by a second run continues at 150', async () => {
      const attempts = Array.from({ length: 150 }, (_, k) => ({
        position: k, userId: 'U1', name: 'Rep', dialedAt: new Date(Date.UTC(2026, 8, 23, 6, 0, k)),
      }));
      const { db } = fakeDbFromAttempts(attempts);
      const got = await listStartPosition(db, 'O1', 'L1', new Date('2026-09-23T07:00:00Z'));
      expect(got?.position).toBe(149);
      expect(rotateAfter(Array.from({ length: 200 }, (_, i) => i), got!.position).startedFrom).toBe(150);
    });

    it('two reps concurrently: the new run starts after the LATEST dial, not whichever rep reached the higher position', async () => {
      const attempts = [
        // Still inside the 12h window, but stale relative to Rep B's dial.
        { position: 199, userId: 'U-A', name: 'Rep A', dialedAt: new Date('2026-09-23T00:30:00Z') },
        { position: 40, userId: 'U-B', name: 'Rep B', dialedAt: new Date('2026-09-23T06:00:00Z') },
      ];
      const { db } = fakeDbFromAttempts(attempts);
      const got = await listStartPosition(db, 'O1', 'L1', new Date('2026-09-23T06:30:00Z'));
      expect(got?.position).toBe(40);
      expect(got?.workedBy).toEqual([
        { userId: 'U-A', name: 'Rep A' }, { userId: 'U-B', name: 'Rep B' },
      ]);
    });

    it('no dials in the window → null, so rotateAfter starts at 0', async () => {
      const { db } = fakeDbFromAttempts([]);
      const got = await listStartPosition(db, 'O1', 'L1', new Date());
      expect(got).toBeNull();
      expect(rotateAfter(Array.from({ length: 200 }, (_, i) => i), null).startedFrom).toBe(0);
    });
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

  // Review R2 (re-review, ruling: fix it): M1 made `total` agree with
  // `session.runSize` for a limited run, but the web computes "dialing" as
  // firstPassTotal/total minus the skip breakdown, which still includes the
  // settled-at-build rows — "first 100" showed "dialing 92" (and could go
  // negative). N comes ONLY from `session.runSize` now; `total` reverts to
  // the plain row-based ordinal count, limited run or not.
  it("total stays the row-based ordinal count, even when the session carries a runSize", async () => {
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready', runSize: 2 }, items, 'U-ME', new Date(), vi.fn(async () => null),
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
  });

  it('a redial copy (attempt 1, redialOf set) is excluded from `total` — Task 11 fix-round-1 Minor: it is not part of the queue creation built, same as an attempt-2 retry', async () => {
    const withRedial = [...items, { attempt: 1, ordinal: 4, listPosition: 87, redialOf: 'i1' }];
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, withRedial, 'U-ME', new Date(), vi.fn(async () => null),
    );
    expect(got).toEqual({ total: 3, startedFrom: 87, workedBy: [] });
  });

  // Review round 2 (Minor #5a): a take-callback requeue copy shares its
  // cancelled original's ordinal (engine.ts `callbackRequeue`) — counted by
  // ROW it would inflate `total`, so "record 12 of 50" would drift after
  // Pause & answer the same way `firstPassTotal` (routes/dialer.ts) already
  // guards against.
  it('a take-callback requeue copy shares its ordinal with its cancelled original — counted once, not twice', async () => {
    const withCallback = [...items, { attempt: 1, ordinal: 2, listPosition: 0, outcome: 'canceled' }];
    const got = await listContextFor(
      {} as never, { orgId: 'O1', listViewId: 'L1', status: 'ready' }, withCallback, 'U-ME', new Date(), vi.fn(async () => null),
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

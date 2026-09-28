import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  LIST_SHARE_WINDOW_MS,
  listContextFor,
  listFrontierQuery,
  listRecordKey,
  listRunStart,
  listStartIndex,
  listStartPosition,
  listTrailQuery,
  rotateAfter,
  type ListRunStart,
} from './list-position.js';

// Never connects: drizzle only needs the dialect to build the statement (the
// house idiom — run-settings.test.ts, sms/inbound-text-worker.test.ts).
const renderDb = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });

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
type FrontierRow = {
  position: number | null; sessionId?: string; objectType?: string; recordId?: string; taskId?: string | null;
};

function fakeDb(opts: {
  latest?: FrontierRow[];
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
    limit: (n: number) => Promise<FrontierRow[]>;
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

  it('takes the position of the MOST RECENT dial, not the highest position ever reached — and that dial\'s RECORD (I1 follow-up)', async () => {
    const { db } = fakeDb({
      latest: [{ position: 40, sessionId: 'S-9', objectType: 'Lead', recordId: '00Q40', taskId: null }],
      workers: [{ userId: 'U-GARRETT', name: 'Garrett' }, { userId: 'U-DANNY', name: 'Danny' }],
    });
    const got = await listStartPosition(db, 'O1', 'L1', new Date());
    expect(got).toEqual({
      position: 40,
      anchor: { sessionId: 'S-9', objectType: 'Lead', key: '00Q40' },
      workedBy: [{ userId: 'U-GARRETT', name: 'Garrett' }, { userId: 'U-DANNY', name: 'Danny' }],
    });
  });

  it('a Task list\'s anchor is the TASK the dial came from — the id the view lists — not the person it rang', async () => {
    const { db } = fakeDb({
      latest: [{ position: 99, sessionId: 'S-1', objectType: 'Task', recordId: '00Q-PERSON', taskId: '00T99' }],
      workers: [{ userId: 'U1', name: 'Garrett' }],
    });
    expect((await listStartPosition(db, 'O1', 'L1', new Date()))?.anchor).toEqual({
      sessionId: 'S-1', objectType: 'Task', key: '00T99',
    });
  });

  it('a null display name reads as "Someone" rather than dropping the row', async () => {
    const { db } = fakeDb({
      latest: [{ position: 5, sessionId: 'S-1', objectType: 'Lead', recordId: '00Q5', taskId: null }],
      workers: [{ userId: 'U1', name: null }],
    });
    expect(await listStartPosition(db, 'O1', 'L1', new Date())).toEqual({
      position: 5,
      anchor: { sessionId: 'S-1', objectType: 'Lead', key: '00Q5' },
      workedBy: [{ userId: 'U1', name: 'Someone' }],
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

// ---------------------------------------------------------------------------
// I1 follow-up (final review, 2026-09-28): anchor the next run on the RECORD
// of the most recent dial, not its list INDEX. A Task view that hides
// completed tasks loses every task run 1 rolled, so run 2's fresh list is
// shorter and the old index points past where run 1 actually stopped.
// ---------------------------------------------------------------------------

describe('listRecordKey — a record\'s identity IN THE LIST VIEW', () => {
  it('a Task list is a list of Tasks: the key is the task id, never the person the row dials', () => {
    expect(listRecordKey('Task', { recordId: '00Q1', taskId: '00T1' })).toBe('00T1');
  });

  it('an unresolvable Task row (record_id is the task id itself) keys on the task id too', () => {
    expect(listRecordKey('Task', { recordId: '00T2', taskId: '00T2' })).toBe('00T2');
  });

  it('a Lead/Opportunity list keys on the record itself — even if a row ever carried a task id', () => {
    expect(listRecordKey('Lead', { recordId: '00Q1', taskId: null })).toBe('00Q1');
    expect(listRecordKey('Opportunity', { recordId: '0061', taskId: null })).toBe('0061');
    expect(listRecordKey('Lead', { recordId: '00Q1', taskId: '00T9' })).toBe('00Q1');
  });

  it('a Task-run row with no task id has NO key — never falls back to the person id', () => {
    expect(listRecordKey('Task', { recordId: '00Q1', taskId: null })).toBeNull();
  });
});

describe('the list-anchor SQL Postgres receives', () => {
  const now = new Date('2026-09-23T18:00:00Z');

  it('the frontier: the most recent positioned dial on this list in 12 h, with its run, that run\'s object type, and the row\'s record + task ids', () => {
    const { sql, params } = new PgDialect().sqlToQuery(
      listFrontierQuery(renderDb, 'ORG-1', '00B000000000001AAA', now).getSQL(),
    );
    expect(sql).toBe(
      'select "dialer_queue_items"."list_position", "dialer_sessions"."id", "dialer_sessions"."object_type", ' +
        '"dialer_queue_items"."record_id", "dialer_queue_items"."task_id" ' +
        'from "dialer_dial_attempts" ' +
        'inner join "dialer_queue_items" on "dialer_queue_items"."id" = "dialer_dial_attempts"."item_id" ' +
        'inner join "dialer_sessions" on "dialer_sessions"."id" = "dialer_dial_attempts"."session_id" ' +
        'where (("dialer_sessions"."org_id" = $1 and "dialer_sessions"."list_view_id" = $2 and "dialer_dial_attempts"."dialed_at" >= $3) ' +
        'and "dialer_queue_items"."list_position" is not null) ' +
        'order by "dialer_dial_attempts"."dialed_at" desc, "dialer_dial_attempts"."id" desc limit $4',
    );
    expect(params).toEqual(['ORG-1', '00B000000000001AAA', '2026-09-23T06:00:00.000Z', 1]);
  });

  it('the trail: that run\'s rows strictly BELOW the anchor\'s position, one per record, nearest first', () => {
    const { sql, params } = new PgDialect().sqlToQuery(listTrailQuery(renderDb, 'S-1', 99).getSQL());
    expect(sql).toBe(
      'select distinct "list_position", "record_id", "task_id" from "dialer_queue_items" ' +
        'where ("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."list_position" < $2) ' +
        'order by "dialer_queue_items"."list_position" desc',
    );
    expect(params).toEqual(['S-1', 99]);
  });
});

type TrailRow = { position: number | null; recordId: string; taskId: string | null };

/** The two reads `listRunStart` makes: the frontier (`select … limit`) and
 *  the trail (`selectDistinct … orderBy`). Records every trail WHERE so a
 *  test can check it read the FRONTIER's own run, below the frontier. */
function runStartDb(opts: { frontier: FrontierRow[]; trail?: TrailRow[] }) {
  const trailWheres: SQL[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve(opts.frontier),
    groupBy: () => Promise.resolve([]),
  };
  const trailChain = {
    from: () => trailChain,
    where: (w: SQL) => { trailWheres.push(w); return trailChain; },
    orderBy: () => Promise.resolve(opts.trail ?? []),
  };
  const raw = { select: vi.fn(() => chain), selectDistinct: vi.fn(() => trailChain) };
  return { db: raw as never, raw, trailWheres };
}

describe('listRunStart — what a new run needs to decide where it starts', () => {
  it('nobody dialed the list in 12 h → null, and neither the trail nor the who-worked-it join is read', async () => {
    const { db, raw } = runStartDb({ frontier: [] });
    expect(await listRunStart(db, 'O1', 'L1', new Date())).toBeNull();
    expect(raw.selectDistinct).not.toHaveBeenCalled();
    expect(raw.select).toHaveBeenCalledOnce(); // the frontier only — run creation never shows workedBy
  });

  it('a Task list: the anchor and every trail entry are keyed by TASK id, read from the frontier\'s own run below its position', async () => {
    const { db, trailWheres } = runStartDb({
      frontier: [{ position: 99, sessionId: 'S-1', objectType: 'Task', recordId: '00Q-P99', taskId: '00T99' }],
      trail: [
        { position: 98, recordId: '00Q-P98', taskId: '00T98' },
        { position: 97, recordId: '00T97', taskId: '00T97' }, // unresolvable Task row
      ],
    });
    expect(await listRunStart(db, 'O1', 'L1', new Date())).toEqual({
      position: 99,
      key: '00T99',
      earlier: [{ position: 98, key: '00T98' }, { position: 97, key: '00T97' }],
    });
    expect(trailWheres).toHaveLength(1);
    expect(new PgDialect().sqlToQuery(trailWheres[0]!).params).toEqual(['S-1', 99]);
  });

  it('a Lead list: keyed by record id', async () => {
    const { db } = runStartDb({
      frontier: [{ position: 3, sessionId: 'S-2', objectType: 'Lead', recordId: '00Q3', taskId: null }],
      trail: [{ position: 2, recordId: '00Q2', taskId: null }],
    });
    expect(await listRunStart(db, 'O1', 'L1', new Date())).toEqual({
      position: 3, key: '00Q3', earlier: [{ position: 2, key: '00Q2' }],
    });
  });

  it('a trail row with no position (never returned by the < predicate, but typed nullable) is dropped', async () => {
    const { db } = runStartDb({
      frontier: [{ position: 3, sessionId: 'S-2', objectType: 'Lead', recordId: '00Q3', taskId: null }],
      trail: [{ position: null, recordId: '00Q-X', taskId: null }, { position: 1, recordId: '00Q1', taskId: null }],
    });
    expect((await listRunStart(db, 'O1', 'L1', new Date()))?.earlier).toEqual([{ position: 1, key: '00Q1' }]);
  });
});

describe('listStartIndex — which index of the FRESH list the new run rotates after (null = the top)', () => {
  const start = (s: Partial<ListRunStart> & { position: number }): ListRunStart => ({ key: null, earlier: [], ...s });

  it('no dial in the window → null (the top)', () => {
    expect(listStartIndex(['a', 'b'], null)).toBeNull();
  });

  it('the anchor is still in the list → rotate after ITS index, wherever it now sits', () => {
    // It was at position 4; two records in front of it have since left.
    expect(listStartIndex(['a', 'b', 'e', 'f', 'g'], start({ position: 4, key: 'e' }))).toBe(2);
  });

  it('the anchor beats every earlier record, even when both are present', () => {
    expect(listStartIndex(['c', 'd', 'e'], start({ position: 4, key: 'e', earlier: [{ position: 3, key: 'd' }] }))).toBe(2);
  });

  it('the anchor has left → the NEAREST earlier record of that run that is still present', () => {
    const got = listStartIndex(['a', 'b', 'c', 'x', 'y'], start({
      position: 5,
      key: 'f',
      earlier: [{ position: 4, key: 'e' }, { position: 3, key: null }, { position: 2, key: 'c' }, { position: 1, key: 'b' }],
    }));
    expect(got).toBe(2); // 'c' — not 'b', and the keyless entry is skipped, not matched
  });

  it('nothing present and the anchor has no identity → today\'s index rule, untouched', () => {
    expect(listStartIndex(['x', 'y', 'z', 'w'], start({ position: 1, key: null, earlier: [{ position: 0, key: 'a' }] }))).toBe(1);
  });

  it('nothing present, no earlier records → the index, less the anchor\'s own slot (it has left too)', () => {
    // Old list …, p9, p10(anchor), p11 …; p10 is gone, so p11 now sits at 10.
    expect(listStartIndex(Array.from({ length: 20 }, (_, i) => `x${i}`), start({ position: 10, key: 'p10' }))).toBe(9);
  });

  it('nothing present, part of the run named → the index, less every record the walk proved gone (a keyless one proves nothing)', () => {
    const got = listStartIndex(Array.from({ length: 50 }, (_, i) => `x${i}`), start({
      position: 30,
      key: 'p30',
      earlier: [{ position: 29, key: 'p29' }, { position: 28, key: 'p28' }, { position: 27, key: null }],
    }));
    expect(got).toBe(27); // 30 − 2 gone − the anchor's own slot
  });

  it('nothing present and the walk named EVERY record from the top to the anchor → null (the top): the whole head of the list has left', () => {
    const earlier = Array.from({ length: 5 }, (_, i) => ({ position: 4 - i, key: `p${4 - i}` }));
    expect(listStartIndex(['q', 'r', 's'], start({ position: 5, key: 'p5', earlier }))).toBeNull();
  });
});

/**
 * An in-memory model of the three tables the reads touch, for end-to-end
 * scenarios: the frontier (most recent positioned dial), the trail (the named
 * run's rows below the named position — read off the WHERE's own params, which
 * the SQL pins above fix), and the who-worked-it join. What matters here is
 * that the RIGHT record wins; the literal SQL is pinned separately.
 */
interface World {
  sessions: Map<string, { objectType: string; userId: string; name: string }>;
  items: Array<{ id: string; sessionId: string; position: number; recordId: string; taskId: string | null }>;
  attempts: Array<{ itemId: string; dialedAt: Date }>;
}

function worldDb(w: World) {
  const itemById = new Map(w.items.map((it) => [it.id, it]));
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => {
      const latest = [...w.attempts].sort((x, y) => y.dialedAt.getTime() - x.dialedAt.getTime())[0];
      const it = latest ? itemById.get(latest.itemId) : undefined;
      return Promise.resolve(it
        ? [{ position: it.position, sessionId: it.sessionId, objectType: w.sessions.get(it.sessionId)!.objectType, recordId: it.recordId, taskId: it.taskId }]
        : []);
    },
    groupBy: () => {
      const users = new Map<string, string>();
      for (const a of w.attempts) {
        const s = w.sessions.get(itemById.get(a.itemId)!.sessionId)!;
        users.set(s.userId, s.name);
      }
      return Promise.resolve([...users].map(([userId, name]) => ({ userId, name })));
    },
  };
  const trail = () => {
    let params: unknown[] = [];
    const c = {
      from: () => c,
      where: (x: SQL) => { params = new PgDialect().sqlToQuery(x).params; return c; },
      orderBy: () => {
        const [sessionId, below] = params as [string, number];
        const rows = new Map<string, TrailRow & { position: number }>();
        for (const it of w.items) {
          if (it.sessionId === sessionId && it.position < below) {
            rows.set(`${it.position}|${it.recordId}|${it.taskId}`, { position: it.position, recordId: it.recordId, taskId: it.taskId });
          }
        }
        return Promise.resolve([...rows.values()].sort((x, y) => y.position - x.position));
      },
    };
    return c;
  };
  return { select: () => chain, selectDistinct: trail } as never;
}

const newWorld = (): World => ({ sessions: new Map(), items: [], attempts: [] });
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`);
const clock = () => { let t = Date.parse('2026-09-28T15:00:00Z'); return () => new Date((t += 1_000)); };

/** A run's queue the way createDialerSession + the Start trim leave it: the
 *  list as fetched THEN, rotated after `startAfter`, cut to the first `keep`
 *  people. A Task run's row dials the Task's PERSON; the Task rides on task_id. */
function addRun(w: World, run: {
  sessionId: string; objectType: 'Task' | 'Lead' | 'Opportunity'; user: { id: string; name: string };
  list: readonly string[]; startAfter?: number | null; keep?: number;
}) {
  w.sessions.set(run.sessionId, { objectType: run.objectType, userId: run.user.id, name: run.user.name });
  const { ordered, positions } = rotateAfter(run.list, run.startAfter ?? null);
  const rows = ordered.slice(0, run.keep ?? ordered.length).map((id, ordinal) => ({
    id: `${run.sessionId}-${ordinal}`, sessionId: run.sessionId, position: positions[ordinal]!,
    recordId: run.objectType === 'Task' ? `00Q-FOR-${id}` : id,
    taskId: run.objectType === 'Task' ? id : null,
  }));
  w.items.push(...rows);
  return rows;
}

function dial(w: World, rows: ReadonlyArray<{ id: string }>, at: () => Date) {
  for (const r of rows) w.attempts.push({ itemId: r.id, dialedAt: at() });
}

async function nextRunOrder(w: World, fresh: readonly string[]): Promise<string[]> {
  const start = await listRunStart(worldDb(w), 'O1', 'L1', new Date('2026-09-28T23:00:00Z'));
  return rotateAfter(fresh, listStartIndex(fresh, start)).ordered;
}

const GARRETT = { id: 'U-GARRETT', name: 'Garrett' };
const NORAH = { id: 'U-NORAH', name: 'Norah' };

describe('where the next run starts — record-anchored, end to end', () => {
  it('Garrett: 200-task view, run 1 dials the first 100, 80 of them roll and leave the view → run 2 starts at the task that was #100', async () => {
    const TASKS = ids('00T', 200);
    const w = newWorld();
    dial(w, addRun(w, { sessionId: 'S1', objectType: 'Task', user: GARRETT, list: TASKS, keep: 100 }), clock());
    // Every person not reached rolls; one in five was reached and keeps an open task.
    const rolled = new Set(TASKS.slice(0, 100).filter((_, n) => n % 5 !== 0));
    const fresh = TASKS.filter((t) => !rolled.has(t));
    expect(fresh).toHaveLength(120);

    const order = await nextRunOrder(w, fresh);
    expect(order[0]).toBe(TASKS[100]);
    expect(order.slice(0, 100)).toEqual(TASKS.slice(100)); // 100–199 first, in list order
    expect(order.slice(100)).toEqual(fresh.slice(0, 20)); // then the 20 still open from run 1
    // What the index rule did: after index 99 of the SHORTER list — original #180.
    expect(rotateAfter(fresh, 99).ordered[0]).toBe(TASKS[180]);
  });

  it('every one of run 1\'s 100 rolled on a view longer than the 200-record pull → run 2 still starts at #100, not #200', async () => {
    const TASKS = ids('00T', 300);
    const w = newWorld();
    dial(w, addRun(w, { sessionId: 'S1', objectType: 'Task', user: GARRETT, list: TASKS.slice(0, 200), keep: 100 }), clock());
    const fresh = TASKS.slice(100, 300); // the next pull sees the next 200 open tasks
    expect((await nextRunOrder(w, fresh))[0]).toBe(TASKS[100]);
    expect(rotateAfter(fresh, 99).ordered[0]).toBe(TASKS[200]); // the index rule skipped 100–199
  });

  it('first 20, all 20 rolled, 200-task view → run 2 starts at #20, not #40', async () => {
    const TASKS = ids('00T', 200);
    const w = newWorld();
    dial(w, addRun(w, { sessionId: 'S1', objectType: 'Task', user: GARRETT, list: TASKS, keep: 20 }), clock());
    const fresh = TASKS.slice(20);
    expect((await nextRunOrder(w, fresh))[0]).toBe(TASKS[20]);
    expect(rotateAfter(fresh, 19).ordered[0]).toBe(TASKS[40]);
  });

  it('three first-100 runs in a row on a 300-task view, most people rolling each time → 0–99, 100–199, 200–299', async () => {
    const TASKS = ids('00T', 300);
    const reached = (t: string) => Number(t.slice(3)) % 10 === 0; // one in ten keeps an open task
    const w = newWorld();
    const tick = clock();
    let open = TASKS.slice();
    const pull = () => open.slice(0, 200);

    // Run 1: nobody has dialed the list — from the top.
    const list1 = pull();
    expect((await nextRunOrder(w, list1))[0]).toBe(TASKS[0]);
    dial(w, addRun(w, { sessionId: 'S1', objectType: 'Task', user: GARRETT, list: list1, keep: 100 }), tick);
    open = open.filter((t) => Number(t.slice(3)) >= 100 || reached(t));

    // Run 2 continues at #100.
    const list2 = pull();
    const order2 = await nextRunOrder(w, list2);
    expect(order2[0]).toBe(TASKS[100]);
    const startAfter2 = list2.indexOf(order2[0]!) - 1;
    dial(w, addRun(w, { sessionId: 'S2', objectType: 'Task', user: GARRETT, list: list2, startAfter: startAfter2, keep: 100 }), tick);
    expect(w.items.filter((it) => it.sessionId === 'S2').map((it) => it.taskId)).toEqual(TASKS.slice(100, 200));
    open = open.filter((t) => Number(t.slice(3)) < 100 || Number(t.slice(3)) >= 200 || reached(t));

    // Run 3 continues at #200 — anchored inside run 2, which was itself rotated.
    expect((await nextRunOrder(w, pull()))[0]).toBe(TASKS[200]);
  });

  it('nothing from that run is still in the list and the walk cannot reach the top (a rotated first-N run) → the index, less the records proved gone', async () => {
    const TASKS = ids('00T', 300);
    const w = newWorld();
    // Pulled the first 200, started after #49, kept 30 people: #50–#79. The
    // rows for #0–#49 were trimmed at Start, so nothing says whether they left.
    dial(w, addRun(w, { sessionId: 'S1', objectType: 'Task', user: GARRETT, list: TASKS.slice(0, 200), startAfter: 49, keep: 30 }), clock());
    const fresh = TASKS.filter((_, n) => n < 50 || n >= 80).slice(0, 200); // all 30 rolled
    expect((await nextRunOrder(w, fresh))[0]).toBe(TASKS[80]);
    expect(rotateAfter(fresh, 79).ordered[0]).toBe(TASKS[110]); // the raw index would skip 80–109
  });

  it('no dials in the window → the top', async () => {
    const TASKS = ids('00T', 10);
    const w = newWorld();
    addRun(w, { sessionId: 'S1', objectType: 'Task', user: GARRETT, list: TASKS }); // built, never dialed
    expect((await nextRunOrder(w, TASKS))[0]).toBe(TASKS[0]);
  });

  it.each(['Lead', 'Opportunity'] as const)('a %s list that has not changed → exactly today\'s index result, wherever the last dial was', async (objectType) => {
    const RECORDS = ids(objectType === 'Lead' ? '00Q' : '006', 50);
    for (const stoppedAt of [0, 1, 17, 48, 49]) {
      const w = newWorld();
      dial(w, addRun(w, { sessionId: 'S1', objectType, user: GARRETT, list: RECORDS }).slice(0, stoppedAt + 1), clock());
      const start = await listRunStart(worldDb(w), 'O1', 'L1', new Date('2026-09-28T23:00:00Z'));
      expect(listStartIndex(RECORDS, start)).toBe(stoppedAt);
      expect(rotateAfter(RECORDS, listStartIndex(RECORDS, start))).toEqual(rotateAfter(RECORDS, stoppedAt));
    }
  });

  it('an unchanged Lead list whose last run had itself wrapped → still today\'s index result', async () => {
    const LEADS = ids('00Q', 50);
    const w = newWorld();
    // Started after #29: dials #30–#49, wraps, #0–#9.
    dial(w, addRun(w, { sessionId: 'S1', objectType: 'Lead', user: GARRETT, list: LEADS, startAfter: 29 }).slice(0, 30), clock());
    const start = await listRunStart(worldDb(w), 'O1', 'L1', new Date('2026-09-28T23:00:00Z'));
    expect(listStartIndex(LEADS, start)).toBe(9);
  });

  it('two reps at once: the most recent dial ANYWHERE on the list anchors, and the walk reads THAT rep\'s run (its own list, its own positions)', async () => {
    const TASKS = ids('00T', 200);
    const w = newWorld();
    // Norah pulled the whole list; Garrett pulled it after #0–#39 had rolled,
    // so HIS positions are shifted by 40 against hers.
    const norah = addRun(w, { sessionId: 'S-N', objectType: 'Task', user: NORAH, list: TASKS });
    const garrett = addRun(w, { sessionId: 'S-G', objectType: 'Task', user: GARRETT, list: TASKS.slice(40) });
    const tick = clock();
    // Interleaved: Norah deep in the list (#150–#159), Garrett on #100–#109 —
    // Garrett's last dial is the most recent one.
    for (let k = 0; k < 10; k++) {
      dial(w, [norah[150 + k]!], tick);
      dial(w, [garrett[60 + k]!], tick);
    }
    const rolled = new Set([...TASKS.slice(0, 40), ...TASKS.slice(105, 110), ...TASKS.slice(150, 160)]);
    const fresh = TASKS.filter((t) => !rolled.has(t));

    // Garrett's #109 left; his run's nearest earlier record still open is #104.
    expect((await nextRunOrder(w, fresh))[0]).toBe(TASKS[110]);
    const shared = await listStartPosition(worldDb(w), 'O1', 'L1', new Date('2026-09-28T23:00:00Z'));
    expect(shared?.anchor).toEqual({ sessionId: 'S-G', objectType: 'Task', key: TASKS[109] });
    expect(shared?.workedBy).toEqual([{ userId: 'U-NORAH', name: 'Norah' }, { userId: 'U-GARRETT', name: 'Garrett' }]);
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

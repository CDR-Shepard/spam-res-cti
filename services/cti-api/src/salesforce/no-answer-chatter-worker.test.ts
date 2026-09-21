/**
 * The no-answer Chatter worker, driven END TO END over a fake db.
 *
 * Lesson this codebase has paid for: pinning exported SQL helpers does not test
 * the function that composes them. Every SQL pin below is rendered from the
 * condition the TICK actually handed the db, and the happy path asserts the
 * ORDER of effects — claim → items → ownership → skip stamps → post → id stamps →
 * finish — because each of those orderings is a safety property (never post
 * before ownership is verified; never send chunk 2 before chunk 1 is stamped).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, desc, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import {
  BACKOFF_BASE_MS,
  CANDIDATE_LIMIT,
  LOOP_INTERVAL_MS,
  MAX_ATTEMPTS,
  OWNERSHIP_TIMEOUT_MS,
  SETTLE_RECHECK_MS,
  SETTLE_WINDOW_MS,
  STUCK_AFTER_MS,
  SWEEP_WINDOW_MS,
  maybeStartNoAnswerChatterLoop,
  runNoAnswerChatterTick,
  sweepEligible,
  type NoAnswerChatterDeps,
} from './no-answer-chatter-worker.js';
import { SalesforceUnauthorizedError, type FeedItemPost, type FeedItemResult } from './client.js';
import type { OwnershipSnapshot } from './ownership.js';
import type { SweepItem } from './no-answer-chatter.js';

const NOW = new Date('2026-09-21T18:00:00.000Z');
const ME = '0058X00000RepMeQAV';
const OTHER = '0058X00000OtherQAV';
const lead = (n: number): string => `00Q8X00000${String(n).padStart(5, '0')}UAV`;
const TASK = '00T8X00000AbCdEUAV';

const dialect = new PgDialect();
/** Real Postgres text + bound values for a captured condition / SET expression. */
const render = (q: unknown): { sql: string; params: unknown[] } => {
  const { sql, params } = dialect.sqlToQuery(q as SQL);
  return { sql, params };
};

type SessionRow = typeof schema.dialerSessions.$inferSelect;
function session(o: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'S1', orgId: 'O1', userId: 'U1', sfOwnerId: ME, objectType: 'Lead', status: 'done',
    lastPolledAt: null, repCallSid: null,
    noAnswerChatterAt: null, noAnswerChatterClaimedAt: null, noAnswerChatterAttempts: 0, noAnswerChatterNextAt: null,
    createdAt: new Date(NOW.getTime() - 3_600_000), updatedAt: new Date(NOW.getTime() - 60_000),
    ...o,
  };
}

let seq = 0;
function item(o: Partial<SweepItem> & { sessionId?: string } = {}): SweepItem & { sessionId: string } {
  seq += 1;
  return {
    id: `I${seq}`, sessionId: 'S1', recordId: lead(1), objectType: 'Lead', status: 'no_connect', outcome: 'voicemail',
    attempt: 1, ordinal: seq, taskId: null, noAnswerFeedItemId: null, noAnswerSkipReason: null,
    ...o,
  };
}

interface Write { table: 'sessions' | 'items'; patch: Record<string, unknown>; where: SQL }
interface Fake {
  db: NoAnswerChatterDeps['db'];
  writes: Write[];
  scans: Array<{ where: SQL; orderBy: (t: unknown, ops: unknown) => SQL[]; limit: number }>;
}

/** Names a write for the ORDER assertions. */
function eventOf(w: Write): string {
  if (w.table === 'items') return typeof w.patch.noAnswerSkipReason === 'string' ? `stamp-skip:${w.patch.noAnswerSkipReason}` : 'stamp-ids';
  if (w.patch.noAnswerChatterAt instanceof Date) return 'finish';
  if (w.patch.noAnswerChatterClaimedAt instanceof Date) return 'claim';
  return 'release';
}

function fakeDb(o: {
  sessions: SessionRow[];
  items?: Array<SweepItem & { sessionId: string }>;
  order?: string[];
  /** Return false to make this session's claim CAS match 0 rows. */
  wins?: (sessionId: string) => boolean;
  failWrite?: (w: Write) => boolean;
  failScan?: boolean;
}): Fake {
  const writes: Write[] = [];
  const scans: Fake['scans'] = [];
  const order = o.order ?? [];
  const sessionIdIn = (where: SQL): string => String(render(where).params.find((p) => o.sessions.some((s) => s.id === p)));
  const db = {
    query: {
      dialerSessions: {
        findMany: async (args: Fake['scans'][number]) => {
          if (o.failScan) throw new Error('pg down');
          scans.push(args);
          order.push('scan');
          return o.sessions;
        },
      },
      dialerQueueItems: {
        findMany: async (args: { where: SQL }) => {
          order.push('items');
          const sid = sessionIdIn(args.where);
          return (o.items ?? []).filter((i) => i.sessionId === sid);
        },
      },
    },
    update(table: unknown) {
      const name: Write['table'] = table === schema.dialerSessions ? 'sessions' : 'items';
      return {
        set: (patch: Record<string, unknown>) => ({
          where: (where: SQL) => {
            const w: Write = { table: name, patch, where };
            const run = async <T>(value: T): Promise<T> => {
              if (o.failWrite?.(w)) throw new Error('pg write failed');
              writes.push(w);
              order.push(eventOf(w));
              return value;
            };
            // The claim awaits `.returning()`; every other write awaits the
            // `.where()` itself. Lazy, so exactly one of the two records it.
            return {
              returning: () => {
                const sid = sessionIdIn(where);
                const s = o.sessions.find((x) => x.id === sid)!;
                return run(o.wins?.(sid) === false ? [] : [{ attempts: s.noAnswerChatterAttempts + 1 }]);
              },
              then: (ok: (v: undefined) => unknown, bad: (e: unknown) => unknown) => run(undefined).then(ok, bad),
            };
          },
        }),
      };
    },
  };
  return { db: db as unknown as NoAnswerChatterDeps['db'], writes, scans };
}

const owned = (ids: string[], ownerId = ME): Map<string, OwnershipSnapshot> =>
  new Map(ids.map((id) => [id, { type: id.startsWith('00T') ? 'Task' : 'Lead', ownerId, ownerName: 'A Rep' } as OwnershipSnapshot]));

function deps(f: Fake, over: Partial<NoAnswerChatterDeps> = {}, order: string[] = []): NoAnswerChatterDeps {
  return {
    db: f.db,
    ownership: vi.fn(async (_u: string, ids: ReadonlyArray<string>) => { order.push('ownership'); return owned([...ids]); }),
    createFeedItems: vi.fn(async (_u: string, posts: ReadonlyArray<FeedItemPost>): Promise<FeedItemResult[]> => {
      order.push('post');
      return posts.map((p) => ({ ok: true, id: `0D5-${p.parentId.slice(10, 15)}` }));
    }),
    now: () => NOW,
    ...over,
  };
}

const sessionWrites = (f: Fake): Write[] => f.writes.filter((w) => w.table === 'sessions');
const itemWrites = (f: Fake): Write[] => f.writes.filter((w) => w.table === 'items');

beforeEach(() => {
  seq = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('candidate scan', () => {
  it('asks for ended, un-swept, <24h-old, due, unclaimed-or-stuck sessions — oldest first, 5 at a time', async () => {
    const f = fakeDb({ sessions: [] });
    await runNoAnswerChatterTick(deps(f));
    expect(f.scans).toHaveLength(1);
    const { sql, params } = render(f.scans[0]!.where);
    expect(sql).toBe(
      '("dialer_sessions"."status" in ($1, $2)' +
        ' and "dialer_sessions"."no_answer_chatter_at" is null' +
        ' and "dialer_sessions"."updated_at" > $3' +
        ' and ("dialer_sessions"."no_answer_chatter_next_at" is null or "dialer_sessions"."no_answer_chatter_next_at" <= $4)' +
        ' and ("dialer_sessions"."no_answer_chatter_claimed_at" is null or "dialer_sessions"."no_answer_chatter_claimed_at" <= $5))',
    );
    expect(params).toEqual([
      'done', 'stopped',
      new Date(NOW.getTime() - SWEEP_WINDOW_MS).toISOString(), // THE 24h guard: no historical backfill
      NOW.toISOString(),
      new Date(NOW.getTime() - STUCK_AFTER_MS).toISOString(),
    ]);
    expect(SWEEP_WINDOW_MS).toBe(24 * 60 * 60_000);
    expect(f.scans[0]!.limit).toBe(CANDIDATE_LIMIT);
    expect(CANDIDATE_LIMIT).toBe(5);
    const orderBy = f.scans[0]!.orderBy(schema.dialerSessions, { asc, desc });
    expect(orderBy.map((o) => render(o).sql)).toEqual(['"dialer_sessions"."updated_at" asc']);
  });

  it('a failing scan never throws out of the tick', async () => {
    const f = fakeDb({ sessions: [], failScan: true });
    await expect(runNoAnswerChatterTick(deps(f))).resolves.toEqual({ processed: 0 });
    expect(console.error).toHaveBeenCalled();
  });
});

describe('sweepEligible — the 24h guard, re-made in code', () => {
  it('ended + un-swept + inside 24h', () => {
    expect(sweepEligible(session(), NOW)).toBe(true);
    expect(sweepEligible(session({ status: 'stopped' }), NOW)).toBe(true);
  });
  it('refuses anything that ended 24h ago or more, however it got here', () => {
    expect(sweepEligible(session({ updatedAt: new Date(NOW.getTime() - SWEEP_WINDOW_MS) }), NOW)).toBe(false);
    expect(sweepEligible(session({ updatedAt: new Date(NOW.getTime() - SWEEP_WINDOW_MS + 1) }), NOW)).toBe(true);
    expect(sweepEligible(session({ updatedAt: new Date('2026-03-01T00:00:00Z') }), NOW)).toBe(false);
  });
  it('refuses a live run and an already-swept one', () => {
    for (const status of ['active', 'paused', 'ready'] as const) expect(sweepEligible(session({ status }), NOW)).toBe(false);
    expect(sweepEligible(session({ noAnswerChatterAt: NOW }), NOW)).toBe(false);
  });

  it('TICK: a months-old session the scan somehow returned is never claimed, read, or posted on', async () => {
    const f = fakeDb({ sessions: [session({ updatedAt: new Date('2026-03-01T00:00:00Z') })], items: [item()] });
    const d = deps(f);
    expect(await runNoAnswerChatterTick(d)).toEqual({ processed: 0 });
    expect(f.writes).toEqual([]);
    expect(d.ownership).not.toHaveBeenCalled();
    expect(d.createFeedItems).not.toHaveBeenCalled();
  });
});

describe('claim', () => {
  it('is a compare-and-swap that re-checks un-swept + 24h + unclaimed-or-stuck, bumps attempts, stamps the claim clock', async () => {
    const f = fakeDb({ sessions: [session()], items: [] });
    await runNoAnswerChatterTick(deps(f));
    const claim = sessionWrites(f)[0]!;
    expect(eventOf(claim)).toBe('claim');
    const { sql, params } = render(claim.where);
    expect(sql).toBe(
      '("dialer_sessions"."id" = $1' +
        ' and "dialer_sessions"."status" in ($2, $3)' +
        ' and "dialer_sessions"."no_answer_chatter_at" is null' +
        ' and "dialer_sessions"."updated_at" > $4' +
        ' and ("dialer_sessions"."no_answer_chatter_claimed_at" is null or "dialer_sessions"."no_answer_chatter_claimed_at" <= $5))',
    );
    expect(params).toEqual([
      'S1', 'done', 'stopped',
      new Date(NOW.getTime() - SWEEP_WINDOW_MS).toISOString(),
      new Date(NOW.getTime() - STUCK_AFTER_MS).toISOString(),
    ]);
    expect(claim.patch.noAnswerChatterClaimedAt).toEqual(NOW);
    expect(render(claim.patch.noAnswerChatterAttempts).sql).toBe('"dialer_sessions"."no_answer_chatter_attempts" + 1');
  });

  it('LOST (another replica won): nothing is read, asked, posted, or written for that session', async () => {
    const order: string[] = [];
    const f = fakeDb({ sessions: [session()], items: [item()], order, wins: () => false });
    const d = deps(f, {}, order);
    expect(await runNoAnswerChatterTick(d)).toEqual({ processed: 0 });
    expect(order).toEqual(['scan', 'claim']);
    expect(d.ownership).not.toHaveBeenCalled();
    expect(d.createFeedItems).not.toHaveBeenCalled();
  });

  it('stamps each claim with a FRESH clock read, not the top-of-tick one (a slow batch must not look stuck)', async () => {
    let t = NOW.getTime();
    const f = fakeDb({ sessions: [session({ id: 'S1' }), session({ id: 'S2' })], items: [] });
    await runNoAnswerChatterTick(deps(f, { now: () => new Date((t += 1000)) }));
    const claims = sessionWrites(f).filter((w) => eventOf(w) === 'claim').map((w) => (w.patch.noAnswerChatterClaimedAt as Date).getTime());
    expect(claims[1]!).toBeGreaterThan(claims[0]!);
  });
});

describe('sweep — the happy path, in order', () => {
  it('claim → items → ownership → skip stamps → post → id stamps → finish', async () => {
    const order: string[] = [];
    const items = [
      item({ id: 'A1', recordId: lead(1), attempt: 1, ordinal: 0, outcome: 'no_answer' }),
      item({ id: 'B1', recordId: lead(2), attempt: 1, ordinal: 1, outcome: 'busy' }),
      item({ id: 'C1', recordId: lead(3), attempt: 1, ordinal: 2, outcome: 'voicemail' }),
      item({ id: 'D1', recordId: lead(4), attempt: 1, ordinal: 3, status: 'done', outcome: 'connected' }),
      item({ id: 'E1', recordId: lead(5), attempt: 1, ordinal: 4, outcome: 'canceled' }),
      item({ id: 'A2', recordId: lead(1), attempt: 2, ordinal: 5, outcome: 'voicemail' }),
    ];
    const f = fakeDb({ sessions: [session()], items, order });
    const ownership = vi.fn(async (_u: string, ids: ReadonlyArray<string>) => {
      order.push('ownership');
      const m = owned([...ids]);
      m.set(lead(2), { type: 'Lead', ownerId: OTHER, ownerName: 'Matt Penrod' }); // someone else's
      m.delete(lead(3));                                                           // Salesforce returned nothing
      return m;
    });
    const d = deps(f, { ownership }, order);

    expect(await runNoAnswerChatterTick(d)).toEqual({ processed: 1 });

    expect(order).toEqual(['scan', 'claim', 'items', 'ownership', 'stamp-skip:not-owner', 'stamp-skip:not-found', 'post', 'stamp-ids', 'finish']);

    // ONE batched lookup, as the rep, for exactly the records owed a post.
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(ownership.mock.calls[0]).toEqual(['U1', [lead(1), lead(2), lead(3)]]);

    // ONE post, as the rep, only on the record they own, with the exact text.
    expect(d.createFeedItems).toHaveBeenCalledTimes(1);
    expect((d.createFeedItems as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'U1', [{ parentId: lead(1), body: 'No answer (Power Dialer) — 2 attempts: no answer, voicemail' }],
    ]);

    // Skip stamps: terminal, scoped to the session, on exactly that record's items.
    const [notOwner, notFound, ids] = itemWrites(f);
    expect(notOwner!.patch).toEqual({ noAnswerSkipReason: 'not-owner' });
    expect(render(notOwner!.where)).toEqual({
      sql: '("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."id" in ($2))', params: ['S1', 'B1'],
    });
    expect(notFound!.patch).toEqual({ noAnswerSkipReason: 'not-found' });
    expect(render(notFound!.where).params).toEqual(['S1', 'C1']);

    // Id stamps: BOTH attempts of the record carry the same FeedItem id.
    expect(Object.keys(ids!.patch)).toEqual(['noAnswerFeedItemId']);
    expect(render(ids!.patch.noAnswerFeedItemId)).toEqual({
      sql: 'case "dialer_queue_items"."id" when $1::uuid then $2::text when $3::uuid then $4::text end',
      params: ['A1', '0D5-00001', 'A2', '0D5-00001'],
    });
    expect(render(ids!.where).params).toEqual(['S1', 'A1', 'A2']);

    // Finish: swept, claim cleared.
    const finish = sessionWrites(f).at(-1)!;
    expect(finish.patch).toEqual({ noAnswerChatterAt: NOW, noAnswerChatterClaimedAt: null, noAnswerChatterNextAt: null });
    expect(render(finish.where)).toEqual({ sql: '"dialer_sessions"."id" = $1', params: ['S1'] });
  });

  it('NEVER bumps updated_at — on sessions it is the "ended at" clock the 24h guard and the settle window read', async () => {
    const f = fakeDb({ sessions: [session()], items: [item()] });
    await runNoAnswerChatterTick(deps(f));
    expect(f.writes.length).toBeGreaterThan(2);
    for (const w of f.writes) expect(Object.keys(w.patch)).not.toContain('updatedAt');
  });

  it('a run with nothing owed is finished in one pass with NO Salesforce call at all', async () => {
    const order: string[] = [];
    const items = [item({ status: 'done', outcome: 'connected' }), item({ recordId: lead(2), status: 'skipped', outcome: 'out_of_hours' }), item({ recordId: lead(3), outcome: 'canceled' })];
    const f = fakeDb({ sessions: [session({ status: 'stopped' })], items, order });
    const d = deps(f, {}, order);
    await runNoAnswerChatterTick(d);
    expect(order).toEqual(['scan', 'claim', 'items', 'finish']);
    expect(d.ownership).not.toHaveBeenCalled();
    expect(d.createFeedItems).not.toHaveBeenCalled();
  });

  it('everything skipped → no post request, still finished', async () => {
    const order: string[] = [];
    const f = fakeDb({ sessions: [session()], items: [item()], order });
    const d = deps(f, { ownership: vi.fn(async (_u: string, ids: ReadonlyArray<string>) => owned([...ids], OTHER)) }, order);
    await runNoAnswerChatterTick(d);
    expect(order).toEqual(['scan', 'claim', 'items', 'stamp-skip:not-owner', 'finish']);
    expect(d.createFeedItems).not.toHaveBeenCalled();
  });

  it('Task run: the Task is gated with the record, and someone else\'s Task means no post', async () => {
    const f = fakeDb({ sessions: [session({ objectType: 'Task' })], items: [item({ id: 'T1', taskId: TASK })] });
    const ownership = vi.fn(async (_u: string, ids: ReadonlyArray<string>) => {
      const m = owned([...ids]);
      m.set(TASK, { type: 'Task', ownerId: OTHER, ownerName: 'Matt Penrod' });
      return m;
    });
    const d = deps(f, { ownership });
    await runNoAnswerChatterTick(d);
    expect(ownership.mock.calls[0]![1]).toEqual([lead(1), TASK]);
    expect(d.createFeedItems).not.toHaveBeenCalled();
    expect(itemWrites(f).map((w) => w.patch)).toEqual([{ noAnswerSkipReason: 'not-owner' }]);
  });

  it('a record Salesforce REJECTS is stamped with the statusCode (terminal) and logged; the rest still post', async () => {
    const items = [item({ id: 'A1', recordId: lead(1) }), item({ id: 'B1', recordId: lead(2) })];
    const f = fakeDb({ sessions: [session()], items });
    const createFeedItems = vi.fn(async (): Promise<FeedItemResult[]> => [
      { ok: false, statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'nope' },
      { ok: true, id: '0D5OK' },
    ]);
    await runNoAnswerChatterTick(deps(f, { createFeedItems }));
    const [rejected, posted] = itemWrites(f);
    expect(rejected!.patch).toEqual({ noAnswerSkipReason: 'INSUFFICIENT_ACCESS_OR_READONLY' });
    expect(render(rejected!.where).params).toEqual(['S1', 'A1']);
    expect(render(posted!.patch.noAnswerFeedItemId).params).toEqual(['B1', '0D5OK']);
    expect(console.warn).toHaveBeenCalledWith('[no-answer-chatter] post rejected', expect.objectContaining({ sessionId: 'S1', recordId: lead(1), statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }));
    expect(eventOf(sessionWrites(f).at(-1)!)).toBe('finish');
  });
});

describe('chunking — at-least-once', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => item({ id: `I-${i}`, recordId: lead(i), ordinal: i }));

  it('posts 200 per request and stamps each chunk BEFORE sending the next', async () => {
    const order: string[] = [];
    const f = fakeDb({ sessions: [session()], items: many(450), order });
    const d = deps(f, {}, order);
    await runNoAnswerChatterTick(d);
    expect((d.createFeedItems as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[1] as unknown[]).length)).toEqual([200, 200, 50]);
    expect(order.slice(3)).toEqual(['ownership', 'post', 'stamp-ids', 'post', 'stamp-ids', 'post', 'stamp-ids', 'finish']);
  });

  it('chunk 2 fails → chunk 1 is ALREADY stamped (a retry re-posts at most one chunk), session released with backoff, not finished', async () => {
    const order: string[] = [];
    const f = fakeDb({ sessions: [session()], items: many(250), order });
    let call = 0;
    const createFeedItems = vi.fn(async (_u: string, posts: ReadonlyArray<FeedItemPost>): Promise<FeedItemResult[]> => {
      order.push('post');
      if (++call === 2) throw new Error('Salesforce FeedItem create failed (503): []');
      return posts.map((_, i) => ({ ok: true, id: `0D5${i}` }));
    });
    await runNoAnswerChatterTick(deps(f, { createFeedItems }, order));
    expect(order.slice(4)).toEqual(['post', 'stamp-ids', 'post', 'release']);
    const release = sessionWrites(f).at(-1)!;
    expect(release.patch).toEqual({ noAnswerChatterClaimedAt: null, noAnswerChatterNextAt: new Date(NOW.getTime() + BACKOFF_BASE_MS) });
    expect(sessionWrites(f).some((w) => eventOf(w) === 'finish')).toBe(false);
  });
});

describe('settle check — a Stop\'s hangup callback may not have landed yet', () => {
  const dialing = () => [item({ id: 'A1' }), item({ id: 'L1', recordId: lead(2), status: 'dialing', outcome: null })];

  it('an item still `dialing` on a run that ended <10 min ago: release WITHOUT consuming the attempt, look again in 15s', async () => {
    const order: string[] = [];
    const f = fakeDb({ sessions: [session({ status: 'stopped', updatedAt: new Date(NOW.getTime() - SETTLE_WINDOW_MS + 1) })], items: dialing(), order });
    const d = deps(f, {}, order);
    await runNoAnswerChatterTick(d);
    expect(order).toEqual(['scan', 'claim', 'items', 'release']);
    const release = sessionWrites(f).at(-1)!;
    expect(release.patch.noAnswerChatterClaimedAt).toBeNull();
    expect(release.patch.noAnswerChatterNextAt).toEqual(new Date(NOW.getTime() + SETTLE_RECHECK_MS));
    expect(render(release.patch.noAnswerChatterAttempts).sql).toBe('greatest("dialer_sessions"."no_answer_chatter_attempts" - 1, 0)');
    expect(SETTLE_RECHECK_MS).toBe(15_000);
    expect(SETTLE_WINDOW_MS).toBe(10 * 60_000);
    expect(d.ownership).not.toHaveBeenCalled();
    expect(d.createFeedItems).not.toHaveBeenCalled();
  });

  it('after 10 minutes it proceeds regardless (a lost webhook must not wedge the sweep); the dialing row is simply not an attempt', async () => {
    const f = fakeDb({ sessions: [session({ status: 'stopped', updatedAt: new Date(NOW.getTime() - SETTLE_WINDOW_MS) })], items: dialing() });
    const d = deps(f);
    await runNoAnswerChatterTick(d);
    expect((d.createFeedItems as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual([{ parentId: lead(1), body: 'No answer (Power Dialer) — 1 attempt: voicemail' }]);
    expect(eventOf(sessionWrites(f).at(-1)!)).toBe('finish');
  });
});

describe('failure', () => {
  it('ownership lookup THROWS → fail closed: nothing posted, nothing stamped, released with backoff', async () => {
    const f = fakeDb({ sessions: [session()], items: [item()] });
    const d = deps(f, { ownership: vi.fn(async () => { throw new Error('SOQL failed (503): unavailable'); }) });
    expect(await runNoAnswerChatterTick(d)).toEqual({ processed: 1 });
    expect(d.createFeedItems).not.toHaveBeenCalled();
    expect(itemWrites(f)).toEqual([]);
    expect(sessionWrites(f).at(-1)!.patch).toEqual({ noAnswerChatterClaimedAt: null, noAnswerChatterNextAt: new Date(NOW.getTime() + BACKOFF_BASE_MS) });
  });

  it('backoff doubles per attempt: 30s × 2^(attempts-1)', async () => {
    const f = fakeDb({ sessions: [session({ noAnswerChatterAttempts: 3 })], items: [item()] }); // this claim makes it attempt 4
    await runNoAnswerChatterTick(deps(f, { ownership: vi.fn(async () => { throw new Error('boom'); }) }));
    expect(sessionWrites(f).at(-1)!.patch.noAnswerChatterNextAt).toEqual(new Date(NOW.getTime() + BACKOFF_BASE_MS * 8));
    expect(BACKOFF_BASE_MS).toBe(30_000);
  });

  it('a hung Salesforce call times out instead of pinning the single-flight tick', async () => {
    vi.useFakeTimers();
    const f = fakeDb({ sessions: [session()], items: [item()] });
    const d = deps(f, { ownership: vi.fn(() => new Promise<Map<string, OwnershipSnapshot>>(() => {})) });
    const tick = runNoAnswerChatterTick(d);
    await vi.advanceTimersByTimeAsync(OWNERSHIP_TIMEOUT_MS + 1);
    await tick;
    expect(eventOf(sessionWrites(f).at(-1)!)).toBe('release');
    expect(d.createFeedItems).not.toHaveBeenCalled();
  });

  it('a dead Salesforce token is NOT terminal — the rep may sign back in; it rides the normal backoff', async () => {
    const f = fakeDb({ sessions: [session()], items: [item()] });
    await runNoAnswerChatterTick(deps(f, { ownership: vi.fn(async () => { throw new SalesforceUnauthorizedError(); }) }));
    const last = sessionWrites(f).at(-1)!;
    expect(eventOf(last)).toBe('release');
    expect(last.patch.noAnswerChatterNextAt).toEqual(new Date(NOW.getTime() + BACKOFF_BASE_MS));
  });

  it(`attempt ${MAX_ATTEMPTS} fails → give up: marked swept, claim cleared, console.error names the session and how many records were left`, async () => {
    expect(MAX_ATTEMPTS).toBe(8);
    const items = [item({ recordId: lead(1) }), item({ recordId: lead(2) }), item({ recordId: lead(3) })];
    const f = fakeDb({ sessions: [session({ noAnswerChatterAttempts: MAX_ATTEMPTS - 1 })], items });
    const ownership = vi.fn(async (_u: string, ids: ReadonlyArray<string>) => { const m = owned([...ids]); m.delete(lead(3)); return m; });
    const createFeedItems = vi.fn(async () => { throw new Error('Salesforce FeedItem create failed (500): []'); });
    await runNoAnswerChatterTick(deps(f, { ownership, createFeedItems }));
    expect(sessionWrites(f).at(-1)!.patch).toEqual({ noAnswerChatterAt: NOW, noAnswerChatterClaimedAt: null, noAnswerChatterNextAt: null });
    // lead(3) was terminally skipped before the failure; two records were left un-posted.
    expect(console.error).toHaveBeenCalledWith('[no-answer-chatter] giving up', expect.objectContaining({ sessionId: 'S1', recordsLeft: 2, attempts: MAX_ATTEMPTS }));
  });

  it('one bad session — even one whose failure bookkeeping ALSO fails — never blocks the next', async () => {
    const items = [item({ sessionId: 'BAD', recordId: lead(1) }), item({ sessionId: 'GOOD', id: 'G1', recordId: lead(2) })];
    const f = fakeDb({
      sessions: [session({ id: 'BAD', userId: 'UBAD' }), session({ id: 'GOOD', userId: 'UGOOD' })], items,
      failWrite: (w) => w.table === 'sessions' && eventOf(w) === 'release',
    });
    const ownership = vi.fn(async (u: string, ids: ReadonlyArray<string>) => { if (u === 'UBAD') throw new Error('boom'); return owned([...ids]); });
    const d = deps(f, { ownership });
    await expect(runNoAnswerChatterTick(d)).resolves.toEqual({ processed: 2 });
    expect((d.createFeedItems as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['UGOOD']);
    expect(console.error).toHaveBeenCalledWith('[no-answer-chatter] session crashed', expect.objectContaining({ sessionId: 'BAD' }));
  });
});

describe('kill switch + loop wiring', () => {
  it('NO_ANSWER_CHATTER=off → the loop is NOT started', () => {
    const start = vi.fn();
    expect(maybeStartNoAnswerChatterLoop({ NO_ANSWER_CHATTER: 'off' }, start)).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it('NO_ANSWER_CHATTER=on → started at the 15s interval, and the timer handed back for close()', () => {
    const timer = setTimeout(() => {}, 0);
    clearTimeout(timer);
    const start = vi.fn(() => timer);
    expect(maybeStartNoAnswerChatterLoop({ NO_ANSWER_CHATTER: 'on' }, start)).toBe(timer);
    expect(start).toHaveBeenCalledWith(LOOP_INTERVAL_MS);
    expect(LOOP_INTERVAL_MS).toBe(15_000);
  });

  it('server.ts starts it through the kill switch, beside the other loops, and clears it on close', () => {
    // server.ts runs main() on import, so it cannot be loaded here; its text is
    // the only thing that can pin the wiring. A loop nothing starts is a
    // feature that silently does not exist.
    const here = dirname(fileURLToPath(import.meta.url));
    const server = readFileSync(resolve(here, '../server.ts'), 'utf8');
    expect(server).toContain("import { maybeStartNoAnswerChatterLoop } from './salesforce/no-answer-chatter-worker.js';");
    expect(server).toContain('const noAnswerChatterTimer = maybeStartNoAnswerChatterLoop(cfg);');
    expect(server).toContain('if (noAnswerChatterTimer) clearInterval(noAnswerChatterTimer);');
  });
});

/**
 * The stamp helpers, pinned DIRECTLY — the rendered SQL of every write, and
 * what `postChunk` does with each kind of Salesforce answer. The worker test
 * (no-answer-chatter-worker.test.ts) pins the same writes as the TICK composes
 * them; this file is where a mutant in the helper itself is caught by name.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  SF_POST_TIMEOUT_MS,
  groupByReason,
  postChunk,
  stampFeedItemIds,
  stampSkips,
  type StampDeps,
} from './no-answer-chatter-stamps.js';
import type { FeedItemPost, FeedItemResult } from './client.js';
import type { NoAnswerRecord } from './no-answer-chatter.js';

const dialect = new PgDialect();
const render = (q: unknown): { sql: string; params: unknown[] } => {
  const { sql, params } = dialect.sqlToQuery(q as SQL);
  return { sql, params };
};

const lead = (n: number): string => `00Q8X00000${String(n).padStart(5, '0')}UAV`;
const rec = (n: number, itemIds: string[]): NoAnswerRecord =>
  ({ recordId: lead(n), itemIds, reasons: itemIds.map(() => 'voicemail'), taskIds: [] });
const SESSION = { id: 'S1', userId: 'U1' };

interface Write { patch: Record<string, unknown>; where: SQL }
function fakeDb(): { db: StampDeps['db']; writes: Write[] } {
  const writes: Write[] = [];
  const db = {
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (where: SQL) => { writes.push({ patch, where }); },
      }),
    }),
  };
  return { db: db as unknown as StampDeps['db'], writes };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('groupByReason', () => {
  it('keeps EVERY record\'s items under its reason, first-seen order — two records skipped alike are both stamped', () => {
    const got = groupByReason([
      { reason: 'not-owner', record: rec(1, ['A1', 'A2']) },
      { reason: 'not-found', record: rec(2, ['B1']) },
      { reason: 'not-owner', record: rec(3, ['C1']) },
    ]);
    expect([...got]).toEqual([['not-owner', ['A1', 'A2', 'C1']], ['not-found', ['B1']]]);
  });

  it('nothing to skip → empty', () => {
    expect(groupByReason([]).size).toBe(0);
  });
});

describe('stampSkips', () => {
  it('one UPDATE scoped to the session, on exactly the given items', async () => {
    const f = fakeDb();
    await stampSkips({ db: f.db, createFeedItems: vi.fn() }, 'S1', 'not-owner', ['A1', 'C1']);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.patch).toEqual({ noAnswerSkipReason: 'not-owner' });
    expect(render(f.writes[0]!.where)).toEqual({
      sql: '("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."id" in ($2, $3))',
      params: ['S1', 'A1', 'C1'],
    });
  });
});

describe('stampFeedItemIds', () => {
  it('ONE statement for the chunk: a CASE arm per item, and a WHERE that lists every item of every posted record', async () => {
    const f = fakeDb();
    await stampFeedItemIds({ db: f.db, createFeedItems: vi.fn() }, 'S1', [
      { record: rec(1, ['A1', 'A2']), feedItemId: '0D5A' }, // two attempts, one post
      { record: rec(2, ['B1']), feedItemId: '0D5B' },
      { record: rec(3, ['C1']), feedItemId: '0D5C' },
    ]);
    expect(f.writes).toHaveLength(1);
    const [w] = f.writes;
    expect(Object.keys(w!.patch)).toEqual(['noAnswerFeedItemId']);
    expect(render(w!.patch.noAnswerFeedItemId)).toEqual({
      sql: 'case "dialer_queue_items"."id" when $1::uuid then $2::text when $3::uuid then $4::text when $5::uuid then $6::text when $7::uuid then $8::text end',
      params: ['A1', '0D5A', 'A2', '0D5A', 'B1', '0D5B', 'C1', '0D5C'],
    });
    // Not just the first record's items: a CASE arm whose row the WHERE leaves
    // out is a silent no-op, and an unstamped item is a re-post on retry.
    expect(render(w!.where)).toEqual({
      sql: '("dialer_queue_items"."session_id" = $1 and "dialer_queue_items"."id" in ($2, $3, $4, $5))',
      params: ['S1', 'A1', 'A2', 'B1', 'C1'],
    });
  });
});

describe('postChunk', () => {
  const chunk = [rec(1, ['A1', 'A2']), rec(2, ['B1']), rec(3, ['C1'])];
  const ok = (id: string): FeedItemResult => ({ ok: true, id });
  const no = (statusCode: string): FeedItemResult => ({ ok: false, statusCode, message: 'nope' });

  it('posts the chunk as the rep with the exact text, then stamps every posted item with its FeedItem id', async () => {
    const f = fakeDb();
    const createFeedItems = vi.fn(async (): Promise<FeedItemResult[]> => [ok('0D5A'), ok('0D5B'), ok('0D5C')]);
    await postChunk({ db: f.db, createFeedItems }, SESSION, chunk);
    expect(createFeedItems.mock.calls[0]!.slice(0, 2)).toEqual(['U1', [
      { parentId: lead(1), body: 'No answer (Power Dialer) — 2 attempts: voicemail, voicemail' },
      { parentId: lead(2), body: 'No answer (Power Dialer) — 1 attempt: voicemail' },
      { parentId: lead(3), body: 'No answer (Power Dialer) — 1 attempt: voicemail' },
    ]]);
    expect(f.writes).toHaveLength(1);
    expect(render(f.writes[0]!.where).params).toEqual(['S1', 'A1', 'A2', 'B1', 'C1']);
    expect(render(f.writes[0]!.patch.noAnswerFeedItemId).params).toEqual(['A1', '0D5A', 'A2', '0D5A', 'B1', '0D5B', 'C1', '0D5C']);
  });

  it('a per-record rejection is terminal: skip-stamped with its statusCode (grouped by reason), logged; the rest are id-stamped', async () => {
    const f = fakeDb();
    const createFeedItems = vi.fn(async (): Promise<FeedItemResult[]> => [no('INSUFFICIENT_ACCESS_OR_READONLY'), ok('0D5B'), no('INSUFFICIENT_ACCESS_OR_READONLY')]);
    await postChunk({ db: f.db, createFeedItems }, SESSION, chunk);
    expect(f.writes.map((w) => [w.patch.noAnswerSkipReason ?? 'ids', render(w.where).params])).toEqual([
      ['INSUFFICIENT_ACCESS_OR_READONLY', ['S1', 'A1', 'A2', 'C1']],
      ['ids', ['S1', 'B1']],
    ]);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith('[no-answer-chatter] post rejected', expect.objectContaining({ sessionId: 'S1', recordId: lead(3), statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY' }));
  });

  it('everything rejected → skip stamps only, no id stamp', async () => {
    const f = fakeDb();
    const createFeedItems = vi.fn(async (): Promise<FeedItemResult[]> => [no('X'), no('Y'), no('X')]);
    await postChunk({ db: f.db, createFeedItems }, SESSION, chunk);
    expect(f.writes.map((w) => w.patch)).toEqual([{ noAnswerSkipReason: 'X' }, { noAnswerSkipReason: 'Y' }]);
  });

  it('a request that THROWS leaves the chunk untouched (transient — the worker backs off)', async () => {
    const f = fakeDb();
    const createFeedItems = vi.fn(async (): Promise<FeedItemResult[]> => { throw new Error('Salesforce FeedItem create failed (503): []'); });
    await expect(postChunk({ db: f.db, createFeedItems }, SESSION, chunk)).rejects.toThrow(/\(503\)/);
    expect(f.writes).toEqual([]);
  });

  it(`a hung request times out after ${SF_POST_TIMEOUT_MS}ms and rejects — nothing is stamped`, async () => {
    vi.useFakeTimers();
    const f = fakeDb();
    const createFeedItems = vi.fn((_u: string, _p: ReadonlyArray<FeedItemPost>) => new Promise<FeedItemResult[]>(() => {}));
    const p = postChunk({ db: f.db, createFeedItems }, SESSION, chunk);
    const settled = expect(p).rejects.toThrow(/feed item create timed out/);
    await vi.advanceTimersByTimeAsync(SF_POST_TIMEOUT_MS + 1);
    await settled;
    expect(f.writes).toEqual([]);
    expect(SF_POST_TIMEOUT_MS).toBe(60_000);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { dialsToPerson, inFlightElsewhere, preferredNumbersFor, stampConnected } from './contact-history-live.js';

const render = (s: SQL) => new PgDialect().sqlToQuery(s);
function fakeDb(results: unknown[][]) {
  const wheres: SQL[] = []; const joins: SQL[] = []; let call = 0;
  const chain: any = {
    from: () => chain, innerJoin: () => chain,
    leftJoin: (_table: unknown, on: SQL) => { joins.push(on); return chain; },
    where: (w: SQL) => { wheres.push(w); const rows = results[call++] ?? []; const p: any = Promise.resolve(rows); p.orderBy = () => p; p.limit = async () => rows; return p; },
  };
  return { db: { select: vi.fn(() => chain), selectDistinct: vi.fn(() => chain) } as any, wheres, joins };
}
const PERSON = { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' };
const SINCE = new Date('2026-09-22T18:00:00Z');

describe('dialsToPerson', () => {
  it('reads the dial log AND the outbound call log, org-scoped, by number OR record, since the window start', async () => {
    const { db, wheres, joins } = fakeDb([[], []]);
    await dialsToPerson(db, 'org-1', PERSON, SINCE);
    expect(wheres).toHaveLength(2);
    const a = render(wheres[0]!); const c = render(wheres[1]!);
    expect(a.sql).toContain('"dialer_dial_attempts"."org_id" = $1');
    expect(a.sql).toContain('"dialer_dial_attempts"."to_number" in ($2, $3)');
    expect(a.sql).toContain('"dialer_dial_attempts"."record_id" = $4');
    expect(a.sql).toContain('"dialer_dial_attempts"."dialed_at" >= $5');
    expect(a.params).toEqual(['org-1', '+16195550100', '+12135550199', '00Q1', SINCE.toISOString()]);
    expect(c.sql).toContain('"calls"."direction" = $');
    expect(c.sql).toContain('"calls"."normalized_to_number" in (');
    expect(c.sql).toContain('"calls"."salesforce_who_id" = $');
    expect(c.sql).toContain('"calls"."salesforce_what_id" = $');
    expect(c.params).toContain('outbound');
    // The Skip mapping (ruling 2026-09-23) needs the item's status/outcome
    // alongside each attempt row — pin the join that brings them in, not just
    // the eventual `skipped` mapping, so a query that silently drops the join
    // still fails this test even though every itemStatus/itemOutcome would
    // then just read undefined.
    expect(joins).toHaveLength(1);
    const j = render(joins[0]!);
    expect(j.sql).toContain('"dialer_queue_items"."id" = "dialer_dial_attempts"."item_id"');
  });
  it('maps both sources onto Dial: connected = connected_at set / disposition Connected, unskipped', async () => {
    const { db } = fakeDb([
      [{ userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null, itemStatus: null, itemOutcome: null }],
      [{ userId: 'u2', normalizedToNumber: '+12135550199', createdAt: SINCE, disposition: 'Connected', status: 'completed' }],
    ]);
    const dials = await dialsToPerson(db, 'org-1', PERSON, SINCE);
    expect(dials).toEqual([
      { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connected: false, source: 'dialer', skipped: false },
      { userId: 'u2', sessionId: null, toNumber: '+12135550199', at: SINCE, connected: true, source: 'manual', skipped: false },
    ]);
  });
  it('marks skips: a skipped or canceled power-dial item, a canceled click-to-dial call', async () => {
    const { db } = fakeDb([
      [
        { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null, itemStatus: 'skipped', itemOutcome: null },
        { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null, itemStatus: 'no_connect', itemOutcome: 'canceled' },
        { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null, itemStatus: 'no_connect', itemOutcome: 'voicemail' },
        { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null, itemStatus: null, itemOutcome: null },
      ],
      [
        { userId: 'u2', normalizedToNumber: '+12135550199', createdAt: SINCE, disposition: null, status: 'canceled' },
        { userId: 'u2', normalizedToNumber: '+12135550199', createdAt: SINCE, disposition: 'No answer', status: 'no_answer' },
      ],
    ]);
    const dials = await dialsToPerson(db, 'org-1', PERSON, SINCE);
    expect(dials.map((d) => d.skipped)).toEqual([true, true, false, false, true, false]);
  });
  it('a person with no numbers and no record makes no query', async () => {
    const { db } = fakeDb([]);
    expect(await dialsToPerson(db, 'org-1', { numbers: [], recordId: null }, SINCE)).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('inFlightElsewhere', () => {
  it('asks for dialing/connected items on OTHER live sessions of the org for this person', async () => {
    const { db, wheres } = fakeDb([[{ id: 'x' }]]);
    expect(await inFlightElsewhere(db, 'org-1', PERSON, 'S1')).toBe(true);
    const w = render(wheres[0]!);
    expect(w.sql).toContain('"dialer_sessions"."org_id" = $');
    expect(w.sql).toContain('"dialer_sessions"."id" <> $');
    expect(w.sql).toContain('"dialer_sessions"."status" in ($');
    expect(w.sql).toContain('"dialer_queue_items"."status" in ($');
    expect(w.params).toEqual(expect.arrayContaining(['S1', 'active', 'paused', 'dialing', 'connected', '+16195550100', '+12135550199', '00Q1']));
  });
});

describe('stampConnected', () => {
  it('sets connected_at on the attempt row for the item AND ONLY the number that connected', async () => {
    // One item can own several attempt rows: a true no-answer rolls the same
    // item onto its Phone and that re-dial appends a second row. An item-only
    // predicate would stamp the number that rang out as connected as well,
    // which then feeds a false connect to preferredNumbersFor and the cadence
    // history — so the rendered WHERE, not just the patch, is pinned here.
    const wheres: SQL[] = [];
    const set = vi.fn(() => ({ where: vi.fn(async (w: SQL) => { wheres.push(w); }) }));
    const tx = { update: vi.fn(() => ({ set })) } as any;
    const at = new Date('2026-09-23T18:00:00Z');
    await stampConnected(tx, 'item-1', '+16195550100', at);
    expect(set).toHaveBeenCalledWith({ connectedAt: at });
    const w = render(wheres[0]!);
    expect(w.sql).toContain('"item_id" =');
    expect(w.sql).toContain('"to_number" =');
    expect(w.params).toEqual(['item-1', '+16195550100']);
  });
});

describe('preferredNumbersFor', () => {
  it('one query for every number of every pair, keyed back to the pair\'s primary; no query with no pairs', async () => {
    const { db, wheres } = fakeDb([[{ toNumber: '+12135550199', connectedAt: SINCE }, { toNumber: '+13105550000', connectedAt: null }]]);
    const m = await preferredNumbersFor(db, 'org-1', [['+16195550100', '+12135550199'], ['+13105550000', '+13105550001']]);
    expect(m.get('+16195550100')).toBe('+12135550199');
    expect(m.has('+13105550000')).toBe(false);
    const w = render(wheres[0]!);
    expect(w.sql).toContain('"dialer_dial_attempts"."connected_at" is not null');
    expect(w.params).toEqual(expect.arrayContaining(['+16195550100', '+12135550199', '+13105550000', '+13105550001']));
    expect(await preferredNumbersFor(db, 'org-1', [])).toEqual(new Map());
  });
});

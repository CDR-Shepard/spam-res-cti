import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { dialsToPerson, inFlightElsewhere, preferredNumbersFor, stampConnected } from './contact-history-live.js';

const render = (s: SQL) => new PgDialect().sqlToQuery(s);
function fakeDb(results: unknown[][]) {
  const wheres: SQL[] = []; let call = 0;
  const chain: any = {
    from: () => chain, innerJoin: () => chain,
    where: (w: SQL) => { wheres.push(w); const rows = results[call++] ?? []; const p: any = Promise.resolve(rows); p.orderBy = () => p; p.limit = async () => rows; return p; },
  };
  return { db: { select: vi.fn(() => chain), selectDistinct: vi.fn(() => chain) } as any, wheres };
}
const PERSON = { numbers: ['+16195550100', '+12135550199'], recordId: '00Q1' };
const SINCE = new Date('2026-09-22T18:00:00Z');

describe('dialsToPerson', () => {
  it('reads the dial log AND the outbound call log, org-scoped, by number OR record, since the window start', async () => {
    const { db, wheres } = fakeDb([[], []]);
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
  });
  it('maps both sources onto Dial: connected = connected_at set / disposition Connected', async () => {
    const { db } = fakeDb([
      [{ userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connectedAt: null }],
      [{ userId: 'u2', normalizedToNumber: '+12135550199', createdAt: SINCE, disposition: 'Connected' }],
    ]);
    const dials = await dialsToPerson(db, 'org-1', PERSON, SINCE);
    expect(dials).toEqual([
      { userId: 'u1', sessionId: 'S1', toNumber: '+16195550100', at: SINCE, connected: false, source: 'dialer' },
      { userId: 'u2', sessionId: null, toNumber: '+12135550199', at: SINCE, connected: true, source: 'manual' },
    ]);
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
  it('sets connected_at on the attempt row for the item', async () => {
    const set = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    const tx = { update: vi.fn(() => ({ set })) } as any;
    const at = new Date('2026-09-23T18:00:00Z');
    await stampConnected(tx, 'item-1', at);
    expect(set).toHaveBeenCalledWith({ connectedAt: at });
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

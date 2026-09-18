/**
 * The WIRING of assignStarterNumbersLive: that the pieces are composed in the
 * order, and on the handle, that makes them safe.
 *
 * The SQL strings are pinned in auto-assign-live.test.ts and the rules in
 * auto-assign.test.ts — but nothing executed this function's body, so three
 * mutations passed the whole suite: deleting the advisory lock (one rep, two
 * tabs, 24 numbers), swapping `db.transaction` for plain `db` (two autocommitted
 * claims, so a failed SD claim strands a half set forever), and stubbing the
 * holdings read to [] (every sign-in claims a fresh twelve). Same fake-`tx`
 * idiom as routes/dialer-handoffs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const flat = (q: unknown) => dialect.sqlToQuery(q as never).sql.replace(/\s+/g, ' ').trim();

const state = vi.hoisted(() => ({
  events: [] as string[],
  holdings: [] as Array<{ e164: string; health: string; active: boolean }>,
  claim: (async () => ({ rows: [] })) as (sqlText: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  lastHoldingsWhere: null as unknown,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  const tx = {
    execute: async (q: unknown) => {
      const text = flat(q);
      if (text.includes('pg_advisory_xact_lock')) { state.events.push('tx:lock'); return { rows: [] }; }
      state.events.push('tx:claim');
      return state.claim(text);
    },
    select: () => ({ from: () => ({ where: async (w: unknown) => {
      state.events.push('tx:holdings'); state.lastHoldingsWhere = w; return state.holdings;
    } }) }),
  };
  const db = {
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => {
      state.events.push('BEGIN');
      try { const r = await cb(tx); state.events.push('COMMIT'); return r; }
      catch (e) { state.events.push('ROLLBACK'); throw e; }
    },
    // Anything that reaches these escaped the transaction — that is the bug.
    execute: async () => { state.events.push('db:execute-OUTSIDE-TX'); return { rows: [] }; },
    select: () => ({ from: () => ({ where: async () => { state.events.push('db:select-OUTSIDE-TX'); return []; } }) }),
  };
  return { ...actual, getDb: () => db as unknown as ReturnType<typeof actual.getDb> };
});

import { assignStarterNumbersLive } from './auto-assign-live.js';

const WHO = { orgId: 'org-1', userId: 'user-1', email: 'hudson@sjoinvestments.com' };
const six = (prefix: string) => Array.from({ length: 6 }, (_, i) => ({ e164: `+1${prefix}555000${i}` }));

beforeEach(() => {
  state.events = [];
  state.holdings = [];
  state.lastHoldingsWhere = null;
  state.claim = async (text) => ({ rows: six(text.includes("'213'") || /\$2/.test(text) ? '213' : '619') });
});

describe('assignStarterNumbersLive — wiring', () => {
  it('takes the per-user lock FIRST, then reads, then claims — all inside one transaction', async () => {
    const out = await assignStarterNumbersLive(WHO);
    expect(out.status).toBe('assigned');
    expect(state.events).toEqual(['BEGIN', 'tx:lock', 'tx:holdings', 'tx:claim', 'tx:claim', 'COMMIT']);
  });

  // Without the transaction the LA claim autocommits, and a failed SD claim
  // leaves a half set that no later sign-in is allowed to finish.
  it('never touches the database outside the transaction', async () => {
    await assignStarterNumbersLive(WHO);
    expect(state.events.filter((e) => e.includes('OUTSIDE-TX'))).toEqual([]);
  });

  it('a failing SD claim ROLLS BACK the LA claim and reports failed', async () => {
    let n = 0;
    state.claim = async () => { if (++n === 2) throw new Error('connection reset'); return { rows: six('213') }; };
    const out = await assignStarterNumbersLive(WHO);
    expect(out).toEqual({ status: 'failed', reason: 'connection reset' });
    expect(state.events).toEqual(['BEGIN', 'tx:lock', 'tx:holdings', 'tx:claim', 'tx:claim', 'ROLLBACK']);
  });

  // Stubbing this read to [] would hand every rep a fresh twelve on every sign-in.
  it('feeds the REAL holdings into the plan — a fully equipped rep claims nothing', async () => {
    state.holdings = [
      ...Array.from({ length: 6 }, (_, i) => ({ e164: `+1213555100${i}`, health: 'healthy', active: true })),
      ...Array.from({ length: 6 }, (_, i) => ({ e164: `+1619555100${i}`, health: 'healthy', active: true })),
    ];
    expect(await assignStarterNumbersLive(WHO)).toEqual({ status: 'already' });
    expect(state.events).toEqual(['BEGIN', 'tx:lock', 'tx:holdings', 'COMMIT']);
  });

  it("reads holdings for THIS user in THIS org", async () => {
    await assignStarterNumbersLive(WHO);
    const where = dialect.sqlToQuery(state.lastHoldingsWhere as never);
    expect(where.params).toEqual(expect.arrayContaining(['org-1', 'user-1', 'agent']));
  });

  it('returns the claimed numbers, LA and SD kept apart', async () => {
    let n = 0;
    state.claim = async () => ({ rows: ++n === 1 ? six('213') : six('619') });
    const out = await assignStarterNumbersLive(WHO);
    expect(out).toMatchObject({ status: 'assigned', shortLa: 0, shortSd: 0 });
    if (out.status === 'assigned') {
      expect(out.la.every((e) => e.startsWith('+1213'))).toBe(true);
      expect(out.sd.every((e) => e.startsWith('+1619'))).toBe(true);
    }
  });

  it('never throws, even when the transaction itself cannot start', async () => {
    const mod = await import('@cti/db');
    const db = mod.getDb() as unknown as { transaction: unknown };
    const original = db.transaction;
    db.transaction = async () => { throw new Error('too many clients'); };
    try {
      expect(await assignStarterNumbersLive(WHO)).toEqual({ status: 'failed', reason: 'too many clients' });
    } finally { db.transaction = original; }
  });
});

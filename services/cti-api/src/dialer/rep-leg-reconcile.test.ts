import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from '@cti/db';
import {
  FALLBACK_LEG_MS,
  RECONCILE_BATCH,
  reconcileLeg,
  reconcileRepLegsTick,
  selectOpenLegs,
  startRepLegReconcileLoop,
  type ReconcileDeps,
} from './rep-leg-reconcile.js';

const NOW = new Date('2026-10-03T18:00:00Z');
const LEG = { id: 'leg-1', callSid: 'CA0123456789abcdef0123456789abcdef', joinedAt: new Date('2026-10-03T16:00:00Z') };

function fakeDb(openLegs: unknown[] = []) {
  const writes: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => openLegs }) }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => { writes.push(v); },
      }),
    }),
  };
  return { db: db as unknown as ReconcileDeps['db'], writes };
}

const deps = (db: ReconcileDeps['db'], callEnd: ReconcileDeps['callEnd']): ReconcileDeps => ({ db, now: () => NOW, callEnd });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('reconcileLeg', () => {
  it('a leg Twilio says is still live stays open', async () => {
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(LEG, deps(db, async () => ({ ended: false })))).toBe('open');
    expect(writes).toEqual([]);
  });

  it("an ended leg is closed at Twilio's end, as reconciled", async () => {
    const end = new Date('2026-10-03T17:10:00Z');
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(LEG, deps(db, async () => ({ ended: true, endedAt: end })))).toBe('reconciled');
    expect(writes).toEqual([expect.objectContaining({ endedAt: end, endSource: 'reconciled' })]);
  });

  it('an ended leg with no known end is closed at its join (counts nothing)', async () => {
    const { db, writes } = fakeDb();
    await reconcileLeg(LEG, deps(db, async () => ({ ended: true, endedAt: null })));
    expect(writes).toEqual([expect.objectContaining({ endedAt: LEG.joinedAt, endSource: 'reconciled' })]);
  });

  it('a Twilio error on a recent leg retries next tick and writes nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(LEG, deps(db, async () => { throw new Error('20429 too many requests'); }))).toBe('retry');
    expect(writes).toEqual([]);
    expect(warn).toHaveBeenCalledWith('[dialer] rep leg reconcile failed; retrying next tick', { legId: 'leg-1', err: '20429 too many requests' });
  });

  it('a leg Twilio cannot answer for after 48 h is closed by rule at join + 12 h, loudly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const old = { ...LEG, joinedAt: new Date('2026-10-01T10:00:00Z') };
    const { db, writes } = fakeDb();
    expect(await reconcileLeg(old, deps(db, async () => { throw new Error('20404 not found'); }))).toBe('fallback');
    expect(writes).toEqual([expect.objectContaining({ endedAt: new Date(old.joinedAt.getTime() + FALLBACK_LEG_MS), endSource: 'fallback' })]);
    expect(err).toHaveBeenCalledWith('[dialer] rep leg closed by rule — Twilio could not give its end', { legId: 'leg-1' });
  });
});

describe('reconcileRepLegsTick', () => {
  it('one leg failing to write never stops the next', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const second = { ...LEG, id: 'leg-2', callSid: 'CAfedcba9876543210fedcba9876543210' };
    const { db } = fakeDb([LEG, second]);
    let calls = 0;
    const flaky = {
      ...db,
      update: () => ({
        set: () => ({
          where: async () => {
            calls++;
            if (calls === 1) throw new Error('db down');
          },
        }),
      }),
    } as unknown as ReconcileDeps['db'];
    const ended = vi.fn(async () => ({ ended: true as const, endedAt: NOW }));
    await reconcileRepLegsTick(deps(flaky, ended));
    expect(ended).toHaveBeenCalledTimes(2);
    expect(calls).toBe(2);
    expect(err).toHaveBeenCalledWith('[dialer] rep leg reconcile write failed', { legId: 'leg-1', err: 'db down' });
  });
});

describe('selectOpenLegs — the statement Postgres receives', () => {
  it('open legs only, oldest first, capped', () => {
    const db = drizzle(new Pool({ connectionString: 'postgres://unused:unused@127.0.0.1:1/unused' }), { schema });
    const q = selectOpenLegs(db).toSQL();
    expect(q.sql).toContain('"dialer_rep_legs"."ended_at" is null');
    expect(q.sql).toContain('order by "dialer_rep_legs"."joined_at" asc');
    expect(q.sql).toMatch(/limit \$\d+$/);
    expect(q.params).toContain(RECONCILE_BATCH);
  });
});

describe('startRepLegReconcileLoop', () => {
  it('is single-flight: a slow tick is never overlapped', async () => {
    vi.useFakeTimers();
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => new Promise(() => {}) }) }) }) }));
    const db = { select } as unknown as ReconcileDeps['db'];
    const timer = startRepLegReconcileLoop(1000, () => deps(db, async () => ({ ended: false })));
    await vi.advanceTimersByTimeAsync(3500);
    clearInterval(timer);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

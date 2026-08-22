import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { schema } from '../db/index.js';
import { atCustomerCeiling, attemptGateChecks, customerAttemptCounts, tallyAttempts } from './index.js';

describe('tallyAttempts', () => {
  it('sums the total across all numbers and maps per-number, excluding null from_number from the map', () => {
    const { attemptsByNumber, customerAttemptsTotal } = tallyAttempts([
      { from: '+1A', n: 3 },
      { from: '+1B', n: 2 },
      { from: null, n: 4 }, // inbound/legacy — counts toward the ceiling only
    ]);
    expect(customerAttemptsTotal).toBe(9);
    expect(attemptsByNumber.get('+1A')).toBe(3);
    expect(attemptsByNumber.get('+1B')).toBe(2);
    expect([...attemptsByNumber.keys()]).toEqual(['+1A', '+1B']);
  });

  it('is empty for no rows', () => {
    const { attemptsByNumber, customerAttemptsTotal } = tallyAttempts([]);
    expect(customerAttemptsTotal).toBe(0);
    expect(attemptsByNumber.size).toBe(0);
  });

  it('ACCUMULATES a from-number that appears in more than one grouped source', () => {
    // customerAttemptCounts concatenates two GROUP BY results; overwriting here
    // would silently drop one source's dials for that number.
    const { attemptsByNumber, customerAttemptsTotal } = tallyAttempts([
      { from: '+1A', n: 3 },
      { from: '+1A', n: 2 },
    ]);
    expect(attemptsByNumber.get('+1A')).toBe(5);
    expect(customerAttemptsTotal).toBe(5);
  });
});

describe('atCustomerCeiling', () => {
  it('is the >= boundary: at the ceiling, not one below it', () => {
    expect(atCustomerCeiling({ customerAttemptsTotal: 14, perCustomerMaxAttempts: 15 })).toBe(false);
    expect(atCustomerCeiling({ customerAttemptsTotal: 15, perCustomerMaxAttempts: 15 })).toBe(true);
    expect(atCustomerCeiling({ customerAttemptsTotal: 16, perCustomerMaxAttempts: 15 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// customerAttemptCounts — the ONE attempt query, shared by the click-to-dial
// gate and the dialer's per-run ceiling.
// ---------------------------------------------------------------------------

type GroupedRow = { from: string | null; n: number };
type Db = Parameters<typeof customerAttemptCounts>[0];

/**
 * Minimal fake of the Drizzle surface the counter uses. Canned rows are keyed
 * by the table passed to `.from()`, and every `.where(...)` expression is
 * rendered to SQL text so the tests can assert the FILTERS (not just the
 * plumbing) — which rows a source is allowed to contribute is the whole point
 * of this query.
 */
function fakeDb(rows: { calls?: GroupedRow[]; attempts?: GroupedRow[] }): { db: Db; wheres: string[] } {
  const dialect = new PgDialect();
  const wheres: string[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const out = table === schema.calls ? rows.calls ?? [] : rows.attempts ?? [];
        const chain = {
          innerJoin: () => chain,
          where: (w: Parameters<PgDialect['sqlToQuery']>[0]) => {
            wheres.push(dialect.sqlToQuery(w).sql);
            return chain;
          },
          groupBy: async () => out,
        };
        return chain;
      },
    }),
  } as unknown as Db;
  return { db, wheres };
}

const WINDOW_START = new Date('2026-08-01T00:00:00Z');

describe('customerAttemptCounts', () => {
  it('counts power-dial attempts, which write no `calls` row at all', async () => {
    // The regression this exists for: the dialer originates straight through
    // Twilio, so a `calls`-only count let a run dial one recipient forever.
    // The rows come from dialer_dial_attempts (one per successful originate).
    const { db } = fakeDb({ calls: [], attempts: [{ from: '+1AGENT', n: 4 }] });
    const { attemptsByNumber, customerAttemptsTotal } = await customerAttemptCounts(db, 'O1', '+16195559999', WINDOW_START);
    expect(customerAttemptsTotal).toBe(4);
    expect(attemptsByNumber.get('+1AGENT')).toBe(4);
  });

  it('sums both sources, accumulating a number used by both dial paths', async () => {
    const { db } = fakeDb({
      calls: [{ from: '+1A', n: 2 }, { from: null, n: 1 }],
      attempts: [{ from: '+1A', n: 3 }, { from: '+1POOL', n: 1 }],
    });
    const { attemptsByNumber, customerAttemptsTotal } = await customerAttemptCounts(db, 'O1', '+16195559999', WINDOW_START);
    expect(customerAttemptsTotal).toBe(7);
    expect(attemptsByNumber.get('+1A')).toBe(5);
    expect(attemptsByNumber.get('+1POOL')).toBe(1);
  });

  it('counts BOTH dials of a fallback pair — the row the dialer overwrites cannot', async () => {
    // The regression this exists for: a TRUE no-answer on the Mobile rewrites
    // to_number/from_number on the SAME dialer_queue_items row to dial the
    // record's Phone. Counting that row saw ONE contact where the recipient had
    // been rung twice, on two different DIDs. The append-only attempts table
    // keeps both, attributed to the number that placed each.
    const { db } = fakeDb({ calls: [], attempts: [{ from: '+1MOBILEDID', n: 1 }, { from: '+1FALLBACKDID', n: 1 }] });
    const { attemptsByNumber, customerAttemptsTotal } = await customerAttemptCounts(db, 'O1', '+16195559999', WINDOW_START);
    expect(customerAttemptsTotal).toBe(2);
    expect(attemptsByNumber.get('+1MOBILEDID')).toBe(1);
    expect(attemptsByNumber.get('+1FALLBACKDID')).toBe(1);
  });

  it('scopes the dialer source to this org, this recipient, and the window', async () => {
    const { db, wheres } = fakeDb({});
    await customerAttemptCounts(db, 'O1', '+16195559999', WINDOW_START);
    const dialerWhere = wheres.find((w) => w.includes('dialer_dial_attempts'));
    expect(dialerWhere).toBeDefined();
    expect(dialerWhere).toContain('"org_id" =');
    expect(dialerWhere).toContain('"to_number" =');
    expect(dialerWhere).toContain('"dialed_at" >=');
    // Never dialer_queue_items: the fallback path rewrites that row's to/from.
    expect(wheres.some((w) => w.includes('dialer_queue_items'))).toBe(false);
  });
});

const base = { windowDays: 14, maxAttempts: 5, perCustomerMaxAttempts: 15 };

describe('attemptGateChecks — per-customer ceiling (harassment backstop)', () => {
  it('BLOCKS at the ceiling — the 16th contact when the ceiling is 15', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map(),
      customerAttemptsTotal: 15,
      effectiveFrom: null,
    }).find((x) => x.name === 'customer_limit')!;
    expect(c.passed).toBe(false);
    expect(c.severity).toBe('block');
    expect(c.reasonCode).toBe('CUSTOMER_LIMIT_EXCEEDED');
  });

  it('passes below the ceiling', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map(),
      customerAttemptsTotal: 14,
      effectiveFrom: null,
    }).find((x) => x.name === 'customer_limit')!;
    expect(c.passed).toBe(true);
    expect(c.severity).toBe('info');
  });
});

describe('attemptGateChecks — per-number budget', () => {
  it('BLOCKS when the chosen number is at its per-number budget for the customer', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map([['+1A', 5]]),
      customerAttemptsTotal: 5,
      effectiveFrom: '+1A',
    }).find((x) => x.name === 'attempt_limit')!;
    expect(c.passed).toBe(false);
    expect(c.severity).toBe('block');
    expect(c.reasonCode).toBe('ATTEMPT_LIMIT_EXCEEDED');
  });

  it('passes when the chosen number is under its per-number budget', () => {
    const c = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map([['+1A', 4]]),
      customerAttemptsTotal: 4,
      effectiveFrom: '+1A',
    }).find((x) => x.name === 'attempt_limit')!;
    expect(c.passed).toBe(true);
  });

  it('emits no per-number check when no DID was chosen, but the ceiling still applies', () => {
    const checks = attemptGateChecks({
      ...base,
      attemptsByNumber: new Map(),
      customerAttemptsTotal: 0,
      effectiveFrom: null,
    });
    expect(checks.some((x) => x.name === 'attempt_limit')).toBe(false);
    expect(checks.some((x) => x.name === 'customer_limit')).toBe(true);
  });

  it('lets each number keep its own budget while the customer total climbs (bounded by the ceiling)', () => {
    // 3 numbers × 4 each = 12 total (< ceiling 15), each under 5/number → all pass.
    const map = new Map([['+1A', 4], ['+1B', 4], ['+1C', 4]]);
    const checks = attemptGateChecks({ ...base, attemptsByNumber: map, customerAttemptsTotal: 12, effectiveFrom: '+1C' });
    expect(checks.find((x) => x.name === 'attempt_limit')!.passed).toBe(true);
    expect(checks.find((x) => x.name === 'customer_limit')!.passed).toBe(true);
  });
});

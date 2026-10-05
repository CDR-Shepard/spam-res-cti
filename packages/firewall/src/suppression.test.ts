import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import * as firewall from './index.js';
import { blockedTargets } from './suppression.js';

type Rows = { optOuts?: string[]; blocked?: string[]; dnc?: string[] };

/** Fake of the three `select().from(table).where(cond)` reads, keyed by table,
 *  capturing each predicate so the test can render it to SQL. */
function fakeDb(rows: Rows = {}) {
  const conds = new Map<unknown, SQL>();
  const db = {
    _cond: (t: unknown) => conds.get(t)!,
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async (cond: SQL) => {
          conds.set(table, cond);
          const key = table === schema.optOuts ? 'optOuts' : table === schema.blockedNumbers ? 'blocked' : 'dnc';
          return (rows[key] ?? []).map((e164) => ({ e164 }));
        },
      }),
    })),
  };
  return db as unknown as Parameters<typeof blockedTargets>[0] & typeof db;
}

const render = (cond: SQL) => new PgDialect().sqlToQuery(cond);

describe('blockedTargets (moved from cti-api dialer/consent-check.ts)', () => {
  it('is exported from the package index (cti-api re-exports it from @cti/firewall)', () => {
    expect(firewall.blockedTargets).toBe(blockedTargets);
  });

  it('maps each list to its own outcome and leaves clean numbers out', async () => {
    const db = fakeDb({ optOuts: ['+16195550100'], blocked: ['+16195550200'], dnc: ['+16195550300'] });
    const got = await blockedTargets(db, 'O1', ['+16195550100', '+16195550200', '+16195550300', '+16195550400']);
    expect(got).toEqual(new Map([
      ['+16195550100', 'opted_out'],
      ['+16195550200', 'blocked'],
      ['+16195550300', 'dnc'],
    ]));
  });

  it('runs no query for an empty list', async () => {
    const db = fakeDb();
    expect(await blockedTargets(db, 'O1', [])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  it('opt-out beats the block list beats DNC', async () => {
    const n = '+16195550100';
    expect((await blockedTargets(fakeDb({ optOuts: [n], blocked: [n], dnc: [n] }), 'O1', [n])).get(n)).toBe('opted_out');
    expect((await blockedTargets(fakeDb({ blocked: [n], dnc: [n] }), 'O1', [n])).get(n)).toBe('blocked');
  });

  it('scopes opt-outs and blocks to the org; reads federal DNC with no org scope', async () => {
    const numbers = ['+16195550100', '+12135550200'];
    const db = fakeDb();
    await blockedTargets(db, 'ORG-1', numbers);
    const optOut = render(db._cond(schema.optOuts));
    expect(optOut.sql).toContain('"opt_outs"."org_id" = $1');
    expect(optOut.params).toEqual(['ORG-1', ...numbers]);
    const blocked = render(db._cond(schema.blockedNumbers));
    expect(blocked.sql).toContain('"blocked_numbers"."org_id" = $1');
    expect(blocked.params).toEqual(['ORG-1', ...numbers]);
    const dnc = render(db._cond(schema.federalDncEntries));
    expect(dnc.sql).toContain('"federal_dnc_entries"."e164" in ($1, $2)');
    expect(dnc.sql).not.toContain('org_id');
    expect(dnc.params).toEqual(numbers);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { schema } from '@cti/db';
import { blockedTargets, blockedTargetsSafe } from './consent-check.js';

type Rows = { optOuts?: string[]; blocked?: string[]; dnc?: string[] };

/**
 * Minimal fake of the three `select().from(table).where(cond)` reads, keyed by
 * table so a test can both stub each list's rows and capture each predicate.
 */
function fakeDb(rows: Rows = {}, fail = false) {
  const conds = new Map<unknown, SQL>();
  const db = {
    _cond: (t: unknown) => conds.get(t)!,
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: async (cond: SQL) => {
          conds.set(table, cond);
          if (fail) throw new Error('pg down');
          const key = table === schema.optOuts ? 'optOuts' : table === schema.blockedNumbers ? 'blocked' : 'dnc';
          return (rows[key] ?? []).map((e164) => ({ e164 }));
        },
      }),
    })),
  };
  return db as unknown as Parameters<typeof blockedTargets>[0] & typeof db;
}

const render = (cond: SQL) => new PgDialect().sqlToQuery(cond);

describe('blockedTargets', () => {
  it('maps each list to its own outcome and leaves clean numbers out of the map', async () => {
    const db = fakeDb({ optOuts: ['+16195550100'], blocked: ['+16195550200'], dnc: ['+16195550300'] });
    const got = await blockedTargets(db, 'O1', ['+16195550100', '+16195550200', '+16195550300', '+16195550400']);
    expect(got).toEqual(new Map([
      ['+16195550100', 'opted_out'],
      ['+16195550200', 'blocked'],
      ['+16195550300', 'dnc'],
    ]));
    expect(got.has('+16195550400')).toBe(false);
  });

  it('short-circuits to an empty map with no candidate numbers (no query at all)', async () => {
    const db = fakeDb();
    expect(await blockedTargets(db, 'O1', [])).toEqual(new Map());
    expect(db.select).not.toHaveBeenCalled();
  });

  /**
   * One value per number, so when a number sits on more than one list the order
   * IS the feature: the rep must be shown the same reason click-to-dial would
   * show, i.e. the firewall's own check order (opt-out :364 → block list :379 →
   * federal DNC :728).
   */
  it('opt-out beats the block list beats DNC when one number is on all three', async () => {
    const n = '+16195550100';
    const all = await blockedTargets(fakeDb({ optOuts: [n], blocked: [n], dnc: [n] }), 'O1', [n]);
    expect(all.get(n)).toBe('opted_out');

    const two = await blockedTargets(fakeDb({ blocked: [n], dnc: [n] }), 'O1', [n]);
    expect(two.get(n)).toBe('blocked');
  });

  /**
   * The predicates ARE the gate: a dropped org scope would silently apply
   * another tenant's opt-outs (or miss our own), and a number dropped from the
   * IN (...) would be dialed with no check at all. Rendering the captured
   * conditions to real SQL (the PgDialect trick already used in
   * already-worked.test.ts) pins all of it.
   */
  it('scopes opt-outs and the block list to the org, and batches EVERY candidate number', async () => {
    const numbers = ['+16195550100', '+12135550200'];
    const db = fakeDb();
    await blockedTargets(db, 'ORG-1', numbers);

    const optOut = render(db._cond(schema.optOuts));
    expect(optOut.sql).toContain('"opt_outs"."org_id" = $1');
    expect(optOut.sql).toContain('"opt_outs"."e164" in ($2, $3)');
    expect(optOut.params).toEqual(['ORG-1', ...numbers]);

    const blocked = render(db._cond(schema.blockedNumbers));
    expect(blocked.sql).toContain('"blocked_numbers"."org_id" = $1');
    expect(blocked.sql).toContain('"blocked_numbers"."e164" in ($2, $3)');
    expect(blocked.params).toEqual(['ORG-1', ...numbers]);
  });

  /**
   * The federal cache is deliberately NOT org-scoped and NOT filtered on
   * `source` — byte-for-byte the firewall's `dncHit` read (index.ts:730), which
   * blocks a listed number in EVERY dnc_mode. `external_prescrubbed` (this
   * org's mode) is a policy label on a MISS, so it can neither add nor remove a
   * skip here: there is no mode branch in this query to drift.
   */
  it('reads the federal DNC cache exactly as the firewall does — no org scope, no source filter, no mode branch', async () => {
    const numbers = ['+16195550100', '+12135550200'];
    const db = fakeDb();
    await blockedTargets(db, 'ORG-1', numbers);

    const dnc = render(db._cond(schema.federalDncEntries));
    expect(dnc.sql).toContain('"federal_dnc_entries"."e164" in ($1, $2)');
    expect(dnc.sql).not.toContain('org_id');
    expect(dnc.sql).not.toContain('source');
    expect(dnc.params).toEqual(numbers);
  });
});

describe('blockedTargetsSafe — fails OPEN, like the already-worked read', () => {
  it('a query error yields an empty map and one distinctly-tagged warn, never a throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const got = await blockedTargetsSafe(fakeDb({}, true), 'O1', ['+16195550100']);
      expect(got).toEqual(new Map());
      expect(warn).toHaveBeenCalledTimes(1);
      // Distinct from '[already-worked]': the two open gates must be
      // distinguishable in a log search.
      expect(String(warn.mock.calls[0]![0])).toContain('[consent-check]');
    } finally {
      warn.mockRestore();
    }
  });
});

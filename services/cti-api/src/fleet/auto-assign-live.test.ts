/**
 * Pins the SQL the starter-number claim actually sends to Postgres.
 *
 * Rendered, not faked. Every clause here is a safety property: drop the org
 * filter and one tenant's new hire is handed another tenant's numbers; drop
 * `assigned_user_id is null` and a sign-in steals numbers from a working rep;
 * drop SKIP LOCKED and two people signing in the same second get the same six.
 * A fake DB would let any of those through.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { claimReserveSql } from './auto-assign-live.js';

const ARGS = { orgId: 'org-1', userId: 'user-1', codes: ['213', '323'], n: 6, label: 'Agent hudson LA' };
const render = () => new PgDialect().sqlToQuery(claimReserveSql(ARGS));
const flat = () => render().sql.replace(/\s+/g, ' ').trim();

describe('claimReserveSql — the statement Postgres actually receives', () => {
  it("is scoped to the rep's OWN org", () => {
    expect(flat()).toMatch(/where org_id = \$1/);
    expect(render().params[0]).toBe('org-1');
  });

  it('only ever takes UNASSIGNED numbers — it must never steal from a working rep', () => {
    expect(flat()).toContain('assigned_user_id is null');
  });

  it('only takes usable reserve: agent kind, active, not flagged', () => {
    expect(flat()).toContain("kind = 'agent'");
    expect(flat()).toMatch(/and active and/);
    expect(flat()).toContain("health not in ('degraded', 'spam_likely')");
  });

  it('filters to the requested area codes, bound as parameters', () => {
    expect(flat()).toMatch(/substring\(e164 from 3 for 3\) in \(\$2, \$3\)/);
    expect(render().params).toEqual(expect.arrayContaining(['213', '323']));
  });

  // Two new hires signing in the same second must get DIFFERENT numbers.
  it('locks the rows it picks and skips ones another claimer holds', () => {
    expect(flat()).toContain('for update skip locked');
  });

  // `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` can be re-run per
  // outer row and return more than n. A locking CTE is materialized once.
  it('picks inside a CTE, so the limit holds', () => {
    expect(flat()).toMatch(/^with picked as \( select id from outbound_numbers/);
    expect(flat()).toMatch(/limit \$4 for update skip locked \)/);
    expect(flat()).toMatch(/from picked where o\.id = picked\.id/);
    expect(render().params[3]).toBe(6);
  });

  it('writes the owner and the label, and returns what it claimed', () => {
    expect(flat()).toMatch(/set assigned_user_id = \$5, label = \$6/);
    expect(flat()).toMatch(/returning o\.e164$/);
    expect(render().params.slice(4)).toEqual(['user-1', 'Agent hudson LA']);
  });

  it('is deterministic about WHICH numbers it takes', () => {
    expect(flat()).toContain('order by e164');
  });
});

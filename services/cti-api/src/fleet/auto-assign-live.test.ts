/**
 * Pins the SQL the starter-number path actually sends to Postgres.
 *
 * Rendered, not faked. Every clause is a safety property: drop the org filter
 * and one tenant's new hire is handed another tenant's numbers; drop
 * `assigned_user_id is null` and a sign-in steals numbers from a working rep;
 * drop SKIP LOCKED and two people signing in the same second get the same six.
 * A fake DB would let any of those through.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { claimedE164s, claimReserveSql, holdingsWhere, userLockSql } from './auto-assign-live.js';

const dialect = new PgDialect();
const flatten = (s: string) => s.replace(/\s+/g, ' ').trim();

const ARGS = { orgId: 'org-1', userId: 'user-1', codes: ['213', '323'], n: 6, label: 'Agent hudson LA' };
const claim = () => dialect.sqlToQuery(claimReserveSql(ARGS));
const flat = () => flatten(claim().sql);

describe('claimReserveSql — the statement Postgres actually receives', () => {
  it("is scoped to the rep's OWN org", () => {
    expect(flat()).toMatch(/where org_id = \$1/);
    expect(claim().params[0]).toBe('org-1');
  });

  it('only ever takes UNASSIGNED numbers — it must never steal from a working rep', () => {
    expect(flat()).toContain('assigned_user_id is null');
  });

  it('only takes usable reserve: agent kind, active, not flagged', () => {
    expect(flat()).toContain("kind = 'agent'");
    expect(flat()).toMatch(/and active and/);
    expect(flat()).toContain("health not in ('degraded', 'spam_likely')");
  });

  // classifyArea is a strict +1 + 10 digits regex. Without this the SQL would
  // claim a malformed number the planner then refuses to count.
  it('only takes well-formed +1 numbers, agreeing with classifyArea', () => {
    expect(flat()).toContain("e164 like '+1%' and length(e164) = 12");
  });

  it('filters to the requested area codes, bound as parameters', () => {
    expect(flat()).toMatch(/substring\(e164 from 3 for 3\) in \(\$2, \$3\)/);
    expect(claim().params).toEqual(expect.arrayContaining(['213', '323']));
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
    expect(claim().params[3]).toBe(6);
  });

  it('writes the owner and the label, and returns what it claimed', () => {
    expect(flat()).toMatch(/set assigned_user_id = \$5, label = \$6/);
    expect(flat()).toMatch(/returning o\.e164$/);
    expect(claim().params.slice(4)).toEqual(['user-1', 'Agent hudson LA']);
  });

  it('is deterministic about WHICH numbers it takes', () => {
    expect(flat()).toContain('order by e164');
  });
});

describe('userLockSql', () => {
  // Transaction-scoped: released on commit OR rollback, nothing to clean up.
  it('takes a transaction-scoped advisory lock', () => {
    expect(flatten(dialect.sqlToQuery(userLockSql('user-1')).sql)).toBe(
      'select pg_advisory_xact_lock(hashtext($1))',
    );
  });

  // Keyed per user: one rep's two tabs serialize, two different reps do not.
  it('keys the lock on the user, so different reps never wait on each other', () => {
    const a = dialect.sqlToQuery(userLockSql('user-1')).params[0];
    const b = dialect.sqlToQuery(userLockSql('user-2')).params[0];
    expect(a).toContain('user-1');
    expect(a).not.toBe(b);
  });
});

describe('holdingsWhere — which numbers count as the rep\'s', () => {
  const where = () => dialect.sqlToQuery(holdingsWhere({ orgId: 'org-1', userId: 'user-1' }));

  it('is scoped to the org, like the claim — the two halves must agree', () => {
    expect(where().sql).toMatch(/"org_id" = \$/);
    expect(where().params).toContain('org-1');
  });

  it("is scoped to this user's assigned numbers", () => {
    expect(where().sql).toMatch(/"assigned_user_id" = \$/);
    expect(where().params).toContain('user-1');
  });

  // A rep once handed a pool number must not be treated as already equipped.
  it('counts agent numbers only, never the shared dialer pool', () => {
    expect(where().sql).toMatch(/"kind" = \$/);
    expect(where().params).toContain('agent');
  });

  // buyPlanForRep owns the definition of "usable". Filtering here would
  // pre-empt it and the two would drift.
  it('does NOT filter on health or active — that is buyPlanForRep\'s job', () => {
    expect(where().sql).not.toMatch(/health|active/);
  });
});

describe('claimedE164s', () => {
  // Mapping the wrong column returns six `undefined`s, the count still reads 6,
  // and the system reports a clean success over twelve really-claimed numbers.
  it('reads the e164 column, not any other', () => {
    expect(claimedE164s({ rows: [{ e164: '+12135550001', id: 'x' }, { e164: '+12135550002', id: 'y' }] }))
      .toEqual(['+12135550001', '+12135550002']);
  });

  it('drops anything that is not a string rather than counting it as claimed', () => {
    expect(claimedE164s({ rows: [{ id: 'x' }, { e164: null }, { e164: '+12135550003' }] })).toEqual(['+12135550003']);
  });

  it('is empty for an empty result', () => {
    expect(claimedE164s({ rows: [] })).toEqual([]);
  });
});

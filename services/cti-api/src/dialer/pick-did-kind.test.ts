/**
 * The pool picker's KIND boundary: `pickPoolDid` serves both the power dialer
 * (`dialer_pool`, the default) and the AI voice agent (`ai_pool`), and every
 * read and claim it makes must be pinned to the caller's kind so neither can
 * ever dial from the other's numbers — even through a sticky row that points
 * at a number of another kind. The WHEREs are rendered to SQL (PgDialect) so
 * the filter itself is pinned, not just the call order.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { attemptIncrement, pickPoolDid, type Db } from './pick-did.js';
import { poolNumbersWhere } from './pool.js';

const dialect = new PgDialect();
const render = (cond: SQL) => dialect.sqlToQuery(cond);

interface Seen {
  stickyReads: number;
  findFirstWhere: SQL[];
  updateWhere: SQL[];
}

/** Records every WHERE; the sticky row, the sticky re-read and the claims are configurable. */
function recordingDb(cfg: { stickyE164?: string; stickyRow?: object; claims?: boolean[] }): Db & { seen: Seen } {
  const seen: Seen = { stickyReads: 0, findFirstWhere: [], updateWhere: [] };
  const claims = [...(cfg.claims ?? [])];
  const db = {
    seen,
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            seen.stickyReads += 1;
            return cfg.stickyE164 ? [{ e164: cfg.stickyE164 }] : [];
          },
        }),
      }),
    }),
    query: {
      outboundNumbers: {
        findFirst: async (opts: { where: SQL }) => {
          seen.findFirstWhere.push(opts.where);
          return cfg.stickyRow;
        },
      },
    },
    update: () => ({
      set: () => ({
        where: (cond: SQL) => ({
          returning: async () => {
            seen.updateWhere.push(cond);
            return claims.shift() ? [{ id: 'row' }] : [];
          },
        }),
      }),
    }),
  };
  return db as unknown as Db & { seen: Seen };
}

const row = (e164: string) =>
  ({ e164, firstUsedAt: null, warmupOverrideCap: 50 }) as unknown as Awaited<
    ReturnType<typeof import('./pool.js').dialerPoolNumbers>
  >[number];

const ARGS = { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' };

describe('poolNumbersWhere — the pool listing is pinned to one kind', () => {
  it.each(['dialer_pool', 'ai_pool'] as const)('%s: org + active + kind', (kind) => {
    const { sql, params } = render(poolNumbersWhere('org1', kind));
    expect(sql).toBe(
      '("outbound_numbers"."org_id" = $1 and "outbound_numbers"."active" = $2 and "outbound_numbers"."kind" = $3)',
    );
    expect(params).toEqual(['org1', true, kind]);
  });
});

describe('pickPoolDid — kind', () => {
  it('defaults to dialer_pool: the sticky re-read, the listing and the claim all say dialer_pool', async () => {
    const db = recordingDb({ stickyE164: '+16195550101', stickyRow: row('+16195550101'), claims: [false, true] });
    const list = vi.fn(async () => [row('+16195550202')]);
    expect(await pickPoolDid(db, ARGS, { dialerPoolNumbers: list })).toEqual({ e164: '+16195550202' });
    expect(list).toHaveBeenCalledWith('org1', 'dialer_pool');
    expect(render(db.seen.findFirstWhere[0]!).params).toContain('dialer_pool');
    for (const w of db.seen.updateWhere) expect(render(w).params[3]).toBe('dialer_pool');
  });

  it('ai_pool: lists, re-reads and claims ONLY ai_pool numbers', async () => {
    const db = recordingDb({ claims: [true] });
    const list = vi.fn(async () => [row('+16197244374')]);
    const result = await pickPoolDid(db, { ...ARGS, kind: 'ai_pool' }, { dialerPoolNumbers: list });
    expect(result).toEqual({ e164: '+16197244374' });
    expect(list).toHaveBeenCalledWith('org1', 'ai_pool');
    const claim = render(db.seen.updateWhere[0]!);
    expect(claim.sql).toContain('"outbound_numbers"."kind" = $4');
    expect(claim.params[3]).toBe('ai_pool');
  });

  it('ai_pool: a sticky pointing at a rep number is re-read WITH kind = ai_pool, so it can never be claimed', async () => {
    // The rep's click-to-dial wrote (rep1, recipient) -> their agent number. The
    // re-read's WHERE carries kind = ai_pool, so Postgres finds nothing (undefined).
    const db = recordingDb({ stickyE164: '+16195550001', stickyRow: undefined, claims: [true] });
    const list = vi.fn(async () => [row('+16197244374')]);
    const result = await pickPoolDid(db, { ...ARGS, kind: 'ai_pool' }, { dialerPoolNumbers: list });
    expect(result).toEqual({ e164: '+16197244374' });
    const reread = render(db.seen.findFirstWhere[0]!);
    expect(reread.sql).toContain('"outbound_numbers"."kind" = $4');
    expect(reread.params).toEqual(['org1', '+16195550001', true, 'ai_pool']);
    expect(db.seen.updateWhere).toHaveLength(1); // only the pool candidate was claimed
  });

  it('a stickyE164 dep replaces the sticky_numbers read (the AI keeps its own stickiness)', async () => {
    const db = recordingDb({ stickyRow: row('+16197244374'), claims: [true] });
    const list = vi.fn(async () => [row('+16197240000')]);
    const stickyE164 = vi.fn(async () => '+16197244374');
    const result = await pickPoolDid(db, { ...ARGS, kind: 'ai_pool' }, { dialerPoolNumbers: list, stickyE164 });
    expect(result).toEqual({ e164: '+16197244374' });
    expect(db.seen.stickyReads).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(render(db.seen.findFirstWhere[0]!).params).toEqual(['org1', '+16197244374', true, 'ai_pool']);
  });

  it('fails closed (null) when no ai_pool number is claimable', async () => {
    const db = recordingDb({ claims: [false] });
    const list = vi.fn(async () => [row('+16197244374')]);
    expect(await pickPoolDid(db, { ...ARGS, kind: 'ai_pool' }, { dialerPoolNumbers: list })).toBeNull();
  });
});

describe('attemptIncrement — ai_pool', () => {
  it('pins kind = ai_pool in the atomic claim', async () => {
    const db = recordingDb({ claims: [true] });
    await attemptIncrement(db, 'ORG-1', '+16197244374', 40, 'ai_pool');
    const { sql, params } = render(db.seen.updateWhere[0]!);
    expect(sql).toContain('"outbound_numbers"."kind" = $4');
    expect(params[3]).toBe('ai_pool');
  });
});

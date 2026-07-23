import { describe, expect, it, vi } from 'vitest';
import { pickPoolDid, withinCallingHours, parseCallingHoursExempt, type Db } from './pick-did.js';

describe('parseCallingHoursExempt', () => {
  it('parses a comma-separated E.164 allowlist (trims, drops empties)', () => {
    const s = parseCallingHoursExempt(' +12054303297 , +16195550100 ,');
    expect(s.has('+12054303297')).toBe(true);
    expect(s.has('+16195550100')).toBe(true);
    expect(s.size).toBe(2);
  });
  it('is empty for undefined or blank — no exemptions by default', () => {
    expect(parseCallingHoursExempt(undefined).size).toBe(0);
    expect(parseCallingHoursExempt('').size).toBe(0);
    expect(parseCallingHoursExempt('  ,  ').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// withinCallingHours
// ---------------------------------------------------------------------------

describe('withinCallingHours', () => {
  const SD_NUMBER = '+16195551234'; // 619 -> America/Los_Angeles

  it('allows a Pacific number at 10:00 local (mid-day)', () => {
    // 2026-07-13 is PDT (UTC-7): 17:00Z == 10:00 local.
    expect(withinCallingHours(SD_NUMBER, new Date('2026-07-13T17:00:00Z'))).toBe(true);
  });

  it('blocks a Pacific number at 23:00 local (late night)', () => {
    // 2026-07-14 06:00Z == 2026-07-13 23:00 PDT local.
    expect(withinCallingHours(SD_NUMBER, new Date('2026-07-14T06:00:00Z'))).toBe(false);
  });

  it('allows the 8:00 local boundary (window opens)', () => {
    // 15:00Z == 08:00 PDT.
    expect(withinCallingHours(SD_NUMBER, new Date('2026-07-13T15:00:00Z'))).toBe(true);
  });

  it('allows 20:59 local (window still open through the 20th hour)', () => {
    // 03:59Z (next day) == 20:59 PDT.
    expect(withinCallingHours(SD_NUMBER, new Date('2026-07-14T03:59:00Z'))).toBe(true);
  });

  it('blocks 21:00 local (window closed)', () => {
    // 04:00Z (next day) == 21:00 PDT.
    expect(withinCallingHours(SD_NUMBER, new Date('2026-07-14T04:00:00Z'))).toBe(false);
  });

  it('blocks 07:59 local (window not yet open)', () => {
    // 14:59Z == 07:59 PDT.
    expect(withinCallingHours(SD_NUMBER, new Date('2026-07-13T14:59:00Z'))).toBe(false);
  });

  it('fails open (true) for a number with an unresolvable timezone', () => {
    // Non-NANP number -> timezoneForNumber returns null.
    expect(withinCallingHours('+442071838750', new Date('2026-07-14T04:00:00Z'))).toBe(true);
    // Toll-free (non-geographic) NANP number -> also null.
    expect(withinCallingHours('+18005551234', new Date('2026-07-14T04:00:00Z'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pickPoolDid
// ---------------------------------------------------------------------------

/**
 * Minimal fake of the Drizzle surface pickPoolDid uses:
 *  - `select().from(stickyNumbers).where().limit()` -> the sticky row (if any)
 *  - `query.outboundNumbers.findFirst()` -> the sticky candidate's full row
 *    (undefined simulates "not found / not an active dialer_pool DID", since
 *    the real query's WHERE already filters on active + kind='dialer_pool')
 *  - `update(outboundNumbers).set().where().returning()` -> the atomic
 *    warmup+velocity increment. Outcomes are consumed IN CALL ORDER (sticky's
 *    attempt first, if any, then each pool candidate in order) so tests don't
 *    need to parse the generated SQL/where expression to know which e164 is
 *    being incremented — the call order alone determines it, mirroring
 *    rotation.test.ts / engine.test.ts's approach of ignoring `where` and
 *    asserting on the observable sequence instead.
 */
function fakeDb(cfg: {
  stickyE164?: string | null;
  stickyOutbound?: { e164: string; firstUsedAt: Date | null; warmupOverrideCap: number | null } | undefined;
  incrementOutcomes?: boolean[];
}): Db {
  const outcomes = [...(cfg.incrementOutcomes ?? [])];
  let cursor = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (cfg.stickyE164 ? [{ e164: cfg.stickyE164 }] : []),
        }),
      }),
    }),
    query: {
      outboundNumbers: {
        findFirst: async () => cfg.stickyOutbound,
      },
    },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            const ok = outcomes[cursor] ?? false;
            cursor += 1;
            return ok ? [{ id: 'row-id' }] : [];
          },
        }),
      }),
    }),
  } as unknown as Db;
}

const poolRow = (e164: string) => ({
  e164,
  firstUsedAt: null,
  warmupOverrideCap: 50,
}) as unknown as Awaited<ReturnType<typeof import('./pool.js').dialerPoolNumbers>>[number];

describe('pickPoolDid', () => {
  it('prefers the sticky DID when it is eligible, without touching the pool', async () => {
    const db = fakeDb({
      stickyE164: '+16195550101',
      stickyOutbound: { e164: '+16195550101', firstUsedAt: null, warmupOverrideCap: 50 },
      incrementOutcomes: [true],
    });
    const dialerPoolNumbers = vi.fn(async () => [poolRow('+16195550202')]);
    const result = await pickPoolDid(
      db,
      { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' },
      { dialerPoolNumbers },
    );
    expect(result).toEqual({ e164: '+16195550101' });
    expect(dialerPoolNumbers).not.toHaveBeenCalled();
  });

  it('falls back to the pool when the sticky DID is capped/ineligible', async () => {
    const db = fakeDb({
      stickyE164: '+16195550101',
      stickyOutbound: { e164: '+16195550101', firstUsedAt: null, warmupOverrideCap: 5 },
      incrementOutcomes: [false, true], // sticky fails, first pool candidate succeeds
    });
    const dialerPoolNumbers = vi.fn(async () => [poolRow('+16195550202'), poolRow('+16195550303')]);
    const result = await pickPoolDid(
      db,
      { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' },
      { dialerPoolNumbers },
    );
    expect(result).toEqual({ e164: '+16195550202' });
  });

  it('ignores a sticky DID that is no longer an active dialer_pool number (falls back to pool)', async () => {
    const db = fakeDb({
      stickyE164: '+16195550101',
      stickyOutbound: undefined, // simulates the findFirst WHERE (active + kind=dialer_pool) matching nothing
      incrementOutcomes: [true], // consumed by the first (only) pool candidate
    });
    const dialerPoolNumbers = vi.fn(async () => [poolRow('+16195550202')]);
    const result = await pickPoolDid(
      db,
      { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' },
      { dialerPoolNumbers },
    );
    expect(result).toEqual({ e164: '+16195550202' });
  });

  it('skips a capped pool DID and tries the next one in order', async () => {
    const db = fakeDb({ stickyE164: null, incrementOutcomes: [false, true] });
    const dialerPoolNumbers = vi.fn(async () => [poolRow('+16195550202'), poolRow('+16195550303')]);
    const result = await pickPoolDid(
      db,
      { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' },
      { dialerPoolNumbers },
    );
    expect(result).toEqual({ e164: '+16195550303' });
  });

  it('returns null (fail-closed) when no sticky and no pool DID is eligible', async () => {
    const db = fakeDb({ stickyE164: null, incrementOutcomes: [false, false] });
    const dialerPoolNumbers = vi.fn(async () => [poolRow('+16195550202'), poolRow('+16195550303')]);
    const result = await pickPoolDid(
      db,
      { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' },
      { dialerPoolNumbers },
    );
    expect(result).toBeNull();
  });

  it('returns null when there is no sticky and the pool is empty', async () => {
    const db = fakeDb({ stickyE164: null });
    const dialerPoolNumbers = vi.fn(async () => []);
    const result = await pickPoolDid(
      db,
      { orgId: 'org1', userId: 'rep1', toE164: '+16195559999' },
      { dialerPoolNumbers },
    );
    expect(result).toBeNull();
  });
});

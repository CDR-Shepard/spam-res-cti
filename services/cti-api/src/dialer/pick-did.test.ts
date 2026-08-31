import { describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { attemptIncrement, pickPoolDid, withinCallingHours, parseCallingHoursExempt, type Db } from './pick-did.js';

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

  /**
   * Weekend-calling ruling (2026-08-31, Evren): Saturday/Sunday dialing is on
   * globally, except where a state restricts it. The dialer's pre-filter has
   * no campaign/SF context — only the dialed number — so it derives state from
   * the SAME area code it already uses for tz (firewall/tz.ts stateForAreaCode)
   * and applies the identical state-calling-rules.ts overlay the firewall gate
   * uses, so the two enforcement sites cannot disagree about a state's Sunday
   * rule any more than they can about the hour boundary above.
   */
  describe('the per-state overlay (parity with the firewall gate)', () => {
    const AL_NUMBER = '+12055551234'; // 205 -> America/Chicago, AL (bans Sunday)
    const TX_NUMBER = '+12145551234'; // 214 -> America/Chicago, TX (Sunday from noon)

    it('blocks an AL number on Sunday (AL bans Sunday) even though the system window would allow the hour', () => {
      // 2026-07-12 is a Sunday; 15:00Z == 10:00 CDT.
      expect(withinCallingHours(AL_NUMBER, new Date('2026-07-12T15:00:00Z'))).toBe(false);
    });

    it('allows an AL number on Tuesday at the same local hour', () => {
      // 2026-07-14 is a Tuesday; 15:00Z == 10:00 CDT.
      expect(withinCallingHours(AL_NUMBER, new Date('2026-07-14T15:00:00Z'))).toBe(true);
    });

    it('blocks a TX number Sunday morning, before the noon start (Tex. Bus. & Com. § 304.052)', () => {
      // 2026-07-12 Sunday 11:00 CDT == 16:00Z.
      expect(withinCallingHours(TX_NUMBER, new Date('2026-07-12T16:00:00Z'))).toBe(false);
    });

    it('allows a TX number Sunday afternoon, at 13:00 local', () => {
      // 2026-07-12 Sunday 13:00 CDT == 18:00Z.
      expect(withinCallingHours(TX_NUMBER, new Date('2026-07-12T18:00:00Z'))).toBe(true);
    });
  });

  /**
   * FIX-9: an NPA missing from the tz/state maps (e.g. NANPA assigns a new
   * geographic area code before we add it) used to fail OPEN unconditionally
   * — which, after the weekend-calling ruling, would let a ban-state's Sunday
   * slip through for any number in that not-yet-mapped area code. '555' is a
   * geographic-looking, deliberately unassigned NANP area code (never a real
   * NPA, never toll-free) standing in for "assigned by NANPA, not yet in our
   * map". Fix applies the conservative UNKNOWN_STATE_RULE with a central-US
   * approximation tz: banned on Sunday, otherwise gated the same 08:00-21:00
   * window every other NPA already gets — NOT the old unconditional `true`.
   */
  describe('an unmapped (but NANP-shaped) NPA fails closed on the state overlay, per FIX-9', () => {
    const UNMAPPED_NUMBER = '+15555551234'; // 555 -> not in NPA_TZ_GROUPS / NPA_TO_STATE

    it('blocks on Sunday (unknown-state rule bans Sunday, Central-US approximation)', () => {
      // 2026-07-12 is a Sunday; 15:00Z == 10:00 CDT.
      expect(withinCallingHours(UNMAPPED_NUMBER, new Date('2026-07-12T15:00:00Z'))).toBe(false);
    });

    it('allows Tuesday 10:00 CT (unknown-state rule permits Mon-Sat within 08:00-21:00)', () => {
      // 2026-07-14 is a Tuesday; 15:00Z == 10:00 CDT.
      expect(withinCallingHours(UNMAPPED_NUMBER, new Date('2026-07-14T15:00:00Z'))).toBe(true);
    });

    it('still gates the hour on an allowed day (blocked before 08:00 CT)', () => {
      // 2026-07-14 Tuesday 07:00 CDT == 12:00Z.
      expect(withinCallingHours(UNMAPPED_NUMBER, new Date('2026-07-14T12:00:00Z'))).toBe(false);
    });

    it('a genuinely non-geographic NANP number (toll-free) is UNCHANGED — still fails open, not treated as an unmapped NPA', () => {
      // Toll-free ranges can never correspond to a recipient's state, unlike a
      // simply-not-yet-mapped geographic NPA — this must keep failing open
      // exactly as before FIX-9 (same case already covered above, re-pinned
      // here for the direct side-by-side against the new unmapped-NPA case).
      expect(withinCallingHours('+18005551234', new Date('2026-07-12T15:00:00Z'))).toBe(true);
    });
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

// ---------------------------------------------------------------------------
// attemptIncrement — the enforcement SQL itself
// ---------------------------------------------------------------------------

/**
 * The `< 10` velocity clause and its window CASE are the ONLY thing that
 * actually refuses the 11th dial in a rolling minute — and prod has never
 * exceeded 3/min, so live telemetry proves the permit half and nothing else.
 * Every other test in this file (and in pick-agent-did / routes-calls) mocks
 * `attemptIncrement` or the db layer away, so the predicate had zero coverage
 * (spam-defense audit §6). Its sibling gate in this same UPDATE — the daily
 * warmup cap — once shipped to prod silently broken for exactly that reason.
 *
 * Rendering the captured WHERE to real SQL (the PgDialect trick used in
 * already-worked.test.ts) pins the arithmetic without a database.
 */
function captureDb() {
  const seen: SQL[] = [];
  const db = {
    _where: seen,
    update: () => ({
      set: () => ({
        where: (cond: SQL) => ({ returning: async () => { seen.push(cond); return [{ id: 'row-id' }]; } }),
      }),
    }),
  } as unknown as Db;
  return db as Db & { _where: SQL[] };
}

describe('attemptIncrement — rendered WHERE clause', () => {
  it.each(['dialer_pool', 'agent'] as const)('pins the <10-per-minute cap and the kind filter for %s DIDs', async (kind) => {
    const db = captureDb();
    await attemptIncrement(db, 'ORG-1', '+16195550100', 40, kind);

    const { sql, params } = new PgDialect().sqlToQuery(db._where[0]!);

    // The velocity clause, whole: a window older than a minute resets the
    // effective count to 0, otherwise the stored count stands — and either way
    // it must be UNDER ten before this dial is allowed to claim the number.
    expect(sql).toContain(
      "(case when \"outbound_numbers\".\"last_minute_window_start\" is null or now() - \"outbound_numbers\".\"last_minute_window_start\" > interval '1 minute' then 0 else \"outbound_numbers\".\"last_minute_dial_count\" end) < 10",
    );
    // Not `<=`: at a stored count of 10 the claim must fail, so the 11th dial
    // in the minute is the one refused.
    expect(sql).not.toContain('last_minute_dial_count end) <= 10');

    // The cap only means anything alongside the rest of the claim's guards.
    expect(sql).toContain('"outbound_numbers"."org_id" = $1');
    expect(sql).toContain('"outbound_numbers"."e164" = $2');
    expect(sql).toContain('"outbound_numbers"."active" = $3');
    // kind is pinned per call so neither path can ever burn the other's DIDs.
    expect(sql).toContain('"outbound_numbers"."kind" = $4');
    expect(params[3]).toBe(kind);
    expect(sql).toContain('"outbound_numbers"."health" not in ($5, $6)');
    expect(params.slice(4, 6)).toEqual(['spam_likely', 'degraded']);
    // ...and the sibling daily warmup cap, in the same atomic claim.
    expect(sql).toContain('"outbound_numbers"."dials_today" else 0 end) <');
    expect(params).toContain(40);
  });
});

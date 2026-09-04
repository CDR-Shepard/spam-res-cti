import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import { RecipientLookupUnauthorizedError } from './errors.js';
import { evaluate } from './evaluate.js';

/**
 * Minimal fake DB in the repo's convention: `where` clauses are not
 * introspected; each query returns the fixture configured for its table.
 *
 * Two shapes are covered here: the no-campaign path (the smallest path that
 * still exercises the recipient-address port, the DNC/consent gates, and the
 * audit insert) and, with `{ campaign }`, the campaign-row path that additionally
 * walks the attempt, calling-hours, and recording-consent gates. NEITHER shape
 * exercises the per-DID reputation gates (warmup, velocity, neighbor_spoof,
 * attestation, answer_rate, engagement) — those only run once an outbound
 * number is actually picked, and the fake pool here is always empty (see
 * `select` below), so `outboundNumberRow` stays null and gate 7's block is
 * skipped end to end. Covering those gates needs a fixture with a real
 * `outboundNumbers` row in the pool — tracked as a follow-up.
 */
function fakeDb(opts: { campaign?: Record<string, unknown> } = {}) {
  const inserted: unknown[] = [];
  const findFirst = <T,>(value: T) => async () => value;
  // Chainable query-builder stand-in for `db.select(...)`. Every builder
  // method returns the same chain object so callers can stop at whichever
  // step their real query stops at (`.where()` for rotation's pool query,
  // `.groupBy()` for customerAttemptCounts, `.orderBy().limit()` for the
  // attestation sample) — and the chain is itself thenable, resolving to an
  // empty row set, so `await` at any of those points just works.
  function chain(rows: unknown[] = []) {
    const c: Record<string, unknown> = {
      from: () => c,
      where: () => c,
      groupBy: () => c,
      orderBy: () => c,
      limit: () => c,
      then: (resolve: (v: unknown) => void) => resolve(rows),
    };
    return c;
  }
  const db = {
    query: {
      optOuts: { findFirst: findFirst(undefined) },
      blockedNumbers: { findFirst: findFirst(undefined) },
      campaignConfigs: { findFirst: findFirst(opts.campaign) },
      outboundNumbers: { findFirst: findFirst(undefined) },
      stateCallingRules: { findFirst: findFirst(undefined) },
      federalDncEntries: { findFirst: findFirst(undefined) },
      organizations: { findFirst: findFirst({ dncMode: 'registry' }) },
      consentRecords: { findFirst: findFirst(undefined) },
      rndLookups: { findFirst: findFirst(undefined) },
    },
    select: () => chain([]),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { returning: async () => [{ id: 'audit-1' }] };
      },
    }),
  };
  return { db: db as unknown as Db, inserted };
}

const CAMPAIGN = {
  id: 'C1',
  orgId: 'O1',
  key: 'default',
  name: 'Default Campaign',
  paused: false,
  maxAttempts: 5,
  attemptWindowDays: 14,
  perCustomerMaxAttempts: 15,
  followupDailyCap: 100,
  callingHoursStart: '08:00',
  callingHoursEnd: '20:00',
  callingDays: [1, 2, 3, 4, 5, 6, 7],
  recordingConsentMode: 'two_party',
  requiredScriptId: null,
};

const base = { orgId: 'O1', userId: 'U1' };

afterEach(() => vi.restoreAllMocks());

describe('evaluate — characterization', () => {
  it('BLOCKs an unparseable number, persists the audit, and never consults the port', async () => {
    const { db, inserted } = fakeDb();
    const port = vi.fn();
    const res = await evaluate(db, { ...base, toNumberRaw: 'not-a-number', recipientRecordId: '00Q000000000001AAA' }, { fetchRecipientAddress: port });
    expect(res.decision).toBe('BLOCK');
    expect(res.checks[0]).toMatchObject({ name: 'phone_parse', reasonCode: 'PHONE_INVALID' });
    expect(res.auditId).toBe('audit-1');
    expect(res.normalizedTo).toBeNull();
    expect(inserted).toHaveLength(1);
    expect(port).not.toHaveBeenCalled();
  });

  it('with no campaign and no numbers returns REQUIRE_REVIEW with the expected gate set', async () => {
    const { db } = fakeDb();
    const res = await evaluate(db, { ...base, toNumberRaw: '(619) 555-9999' });
    expect(res.decision).toBe('REQUIRE_REVIEW');
    expect(res.normalizedTo).toBe('+16195559999');
    const byName = Object.fromEntries(res.checks.map((c) => [c.name, c.reasonCode]));
    expect(byName).toMatchObject({
      phone_parse: 'PHONE_PARSED',
      opt_out: 'NOT_OPTED_OUT',
      blocklist: 'NOT_BLOCKED',
      campaign: 'CAMPAIGN_MISSING',
      outbound_number: 'OUTBOUND_NUMBER_MISSING',
      federal_dnc: 'FEDERAL_DNC_NOT_LOADED',
      consent_record: 'TCPA_CONSENT_NOT_FOUND',
      recording_consent: 'RECORDING_CONSENT_OK',
    });
  });

  it('consults the recipient-address port for timezone and again for state rules', async () => {
    const { db } = fakeDb();
    const port = vi.fn(async () => ({ state: 'CA', country: 'US', postalCode: null, objectType: 'Lead' }));
    await evaluate(db, { ...base, toNumberRaw: '+16195559999', recipientRecordId: '00Q000000000001AAA' }, { fetchRecipientAddress: port });
    expect(port).toHaveBeenCalledTimes(2);
    expect(port).toHaveBeenCalledWith('U1', '00Q000000000001AAA');
  });

  it('ignores recipientRecordId when no port is supplied', async () => {
    const { db } = fakeDb();
    const res = await evaluate(db, { ...base, toNumberRaw: '+16195559999', recipientRecordId: '00Q000000000001AAA' });
    expect(res.decision).toBe('REQUIRE_REVIEW');
  });

  it('treats an unauthorized lookup as skipped, not fatal', async () => {
    const { db } = fakeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const port = vi.fn(async () => { throw new RecipientLookupUnauthorizedError(); });
    const res = await evaluate(db, { ...base, toNumberRaw: '+16195559999', recipientRecordId: '00Q000000000001AAA' }, { fetchRecipientAddress: port });
    expect(res.decision).toBe('REQUIRE_REVIEW');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('recipient address lookup skipped: not authorized'),
      expect.objectContaining({ userId: 'U1' }),
    );
  });

  /**
   * With a campaign row present, `evaluate` additionally walks the attempt
   * gate (customerAttemptCounts + attemptGateChecks), the calling-hours gate,
   * and the recording-consent gate. The outbound pool is still empty (see
   * `fakeDb`), so this does NOT reach the per-DID gates (warmup, velocity,
   * neighbor_spoof, attestation, answer_rate, engagement) — those need
   * `outboundNumberRow` to be non-null, which needs an actual pool row.
   */
  it('with a campaign row, walks the attempt, calling-hours, and recording gates', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-09T17:00:00Z') }); // Wed 10:00 America/Los_Angeles
    try {
      const { db } = fakeDb({ campaign: CAMPAIGN });
      const res = await evaluate(db, {
        ...base,
        toNumberRaw: '(619) 555-9999',
        recipientTimezone: 'America/Los_Angeles',
      });
      expect(res.decision).toBe('REQUIRE_REVIEW');
      const reasonCodes = res.checks.map((c) => c.reasonCode);
      expect(reasonCodes).toEqual(
        expect.arrayContaining([
          'CAMPAIGN_ACTIVE',
          'CUSTOMER_LIMIT_OK',
          'CALLING_HOURS_OK',
          'RECORDING_CONSENT_REVIEW',
          'OUTBOUND_NUMBER_MISSING',
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

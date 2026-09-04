import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '@cti/db';
import { RecipientLookupUnauthorizedError } from './errors.js';
import { evaluate } from './evaluate.js';

/**
 * Minimal fake DB in the repo's convention: `where` clauses are not
 * introspected; each query returns the fixture configured for its table.
 * Shape covers exactly what `evaluate` touches when no campaign row exists,
 * which is the smallest path that still exercises the recipient-address port,
 * the DNC/consent gates, and the audit insert.
 */
function fakeDb() {
  const inserted: unknown[] = [];
  const findFirst = <T,>(value: T) => async () => value;
  const db = {
    query: {
      optOuts: { findFirst: findFirst(undefined) },
      blockedNumbers: { findFirst: findFirst(undefined) },
      campaignConfigs: { findFirst: findFirst(undefined) },
      outboundNumbers: { findFirst: findFirst(undefined) },
      stateCallingRules: { findFirst: findFirst(undefined) },
      federalDncEntries: { findFirst: findFirst(undefined) },
      organizations: { findFirst: findFirst({ dncMode: 'registry' }) },
      consentRecords: { findFirst: findFirst(undefined) },
      rndLookups: { findFirst: findFirst(undefined) },
    },
    // rotation's pool query: db.select().from(t).where(...) awaited directly
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({
      values: (v: unknown) => {
        inserted.push(v);
        return { returning: async () => [{ id: 'audit-1' }] };
      },
    }),
  };
  return { db: db as unknown as Db, inserted };
}

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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not authorized'), expect.objectContaining({ userId: 'U1' }));
  });
});

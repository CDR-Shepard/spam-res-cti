/**
 * findByPhone — converted-lead fix (see docs/superpowers converted-lead-fix
 * brief). Exercises the REAL findByPhone/soqlQuery implementation against a
 * fake transport: 'undici' is mocked at the module boundary (the only true
 * network call inside sfFetch), and '@cti/db' / '@cti/auth' / '../config.js'
 * are faked just enough for getActiveToken to resolve without a real
 * database or crypto key, following this package's existing fake-DB
 * convention (see routes/inbound.test.ts's `fakeDb()`).
 *
 * No mocking of './client.js' itself — findByPhone is the thing under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sfConn: {
    id: 'conn-1',
    userId: 'u1',
    accessTokenEnc: 'fake-access-token',
    refreshTokenEnc: null,
    instanceUrl: 'https://example.my.salesforce.com',
  } as Record<string, unknown> | null,
  mockRequest: vi.fn(),
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ SALESFORCE_API_VERSION: 'v60.0' }),
}));

// Identity encrypt/decrypt — the real @cti/auth crypto needs a 64-hex-char
// TOKEN_ENCRYPTION_KEY env var; these tests never touch a real token value.
vi.mock('@cti/auth', () => ({
  encryptString: (s: string) => s,
  decryptString: (s: string) => s,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () =>
      ({
        query: {
          salesforceConnections: { findFirst: async () => state.sfConn },
        },
      }) as unknown as ReturnType<typeof import('@cti/db').getDb>,
  };
});

// The one real network call inside sfFetch. Faked so findByPhone's SOSL/SOQL
// construction and record-preference logic run for real against canned HTTP
// responses instead of a live Salesforce org.
vi.mock('undici', () => ({ request: (...args: unknown[]) => state.mockRequest(...args) }));

import { findByPhone } from './client.js';

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { text: async () => JSON.stringify(body) } };
}

/** The `q` query-string param off a URL string passed to the fake `request`. */
function soqlOf(callIndex: number): string {
  const url = state.mockRequest.mock.calls[callIndex]?.[0] as string | undefined;
  if (!url) return '';
  return new URL(url).searchParams.get('q') ?? '';
}

const E164 = '+18432127339'; // digits 8432127339 → wildcarded 843*212*7339

const leadRecord = { attributes: { type: 'Lead' }, Id: '00QUS00000e95Fx2AI', Name: 'Ernesta Boykins' };
const contactRecord = {
  attributes: { type: 'Contact' },
  Id: '003US00000z7DewYAE',
  Name: 'Ernesta Boykins',
  AccountId: '001US00000vDIhSYAW',
};
const dealRecord = { attributes: { type: 'Deal__c' }, Id: 'a0JUS0000012345AAA', Name: 'Boykins Deal' };
const OPEN_OPPORTUNITY_ID = '006US00000i55dgYAA';

describe('findByPhone', () => {
  beforeEach(() => {
    state.mockRequest.mockReset();
    state.sfConn = {
      id: 'conn-1',
      userId: 'u1',
      accessTokenEnc: 'fake-access-token',
      refreshTokenEnc: null,
      instanceUrl: 'https://example.my.salesforce.com',
    };
  });

  describe('Fix 1 — never match a converted lead', () => {
    it('excludes converted leads from the primary (withDeal) SOSL', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [] }));
      await findByPhone('u1', E164);
      expect(state.mockRequest).toHaveBeenCalledTimes(1);
      expect(soqlOf(0)).toContain('Lead(Id, Name WHERE IsConverted = false)');
    });

    it('excludes converted leads from the standard-fallback SOSL after a 400', async () => {
      // withDeal rejected (e.g. org has no Deal__c phone field) → standard retry.
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'INVALID_FIELD' }]))
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [] }));
      await findByPhone('u1', E164);
      expect(state.mockRequest).toHaveBeenCalledTimes(2);
      expect(soqlOf(1)).toContain('Lead(Id, Name WHERE IsConverted = false)');
      expect(soqlOf(1)).not.toContain('Deal__c');
    });
  });

  describe('Fix 2 — Contact preferred over Lead', () => {
    it.each([
      ['Contact first in searchRecords', [contactRecord, leadRecord]],
      ['Lead first in searchRecords', [leadRecord, contactRecord]],
    ])('prefers the Contact over the Lead regardless of order (%s)', async (_label, records) => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: records }))
        .mockResolvedValueOnce(jsonResponse(200, { records: [] })); // no open Opportunity
      const match = await findByPhone('u1', E164);
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.ambiguous).toBe(true);
    });
  });

  describe('CRITICAL-1 — Opportunity preference is scoped to an explicit opt-in', () => {
    // findByPhone defaults to `preferOpenOpportunity: false` so every existing
    // call site (notably routes/inbound.ts, the live webhook path) keeps
    // today's behaviour byte for byte. Only sync.ts opts in, and only for
    // inbound calls — see sync.test.ts for that wiring. An Opportunity is
    // ownership-gated (ownership.ts) and an Account is not, so defaulting
    // this on for outbound would silently drop outbound Tasks whose Contact's
    // open Opportunity belongs to another rep.
    it('does NOT consult the Opportunity by default: whatId is the AccountId and the round-trip is never issued', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }));
      const match = await findByPhone('u1', E164);
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(contactRecord.AccountId);
      // Proves the round-trip is skipped outright, not just its result ignored.
      expect(state.mockRequest).toHaveBeenCalledTimes(1);
    });

    it('also skips the Opportunity round-trip when preferOpenOpportunity is explicitly false', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: false });
      expect(match?.whatId).toBe(contactRecord.AccountId);
      expect(state.mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('Fix 3 (opted in) — Contact match lands on its open Opportunity', () => {
    it('sets whatId to the primary open Opportunity when the Contact has one', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockResolvedValueOnce(jsonResponse(200, { records: [{ OpportunityId: OPEN_OPPORTUNITY_ID }] }));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: true });
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(OPEN_OPPORTUNITY_ID);
      expect(soqlOf(1)).toContain('FROM OpportunityContactRole');
      expect(soqlOf(1)).toContain(contactRecord.Id);
      expect(soqlOf(1)).toContain('Opportunity.IsClosed = false');
    });

    it('falls back to AccountId when the Contact has no open Opportunity', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockResolvedValueOnce(jsonResponse(200, { records: [] }));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: true });
      expect(match?.whatId).toBe(contactRecord.AccountId);
    });

    it('degrades to AccountId when the Opportunity lookup returns a non-2xx', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockResolvedValueOnce(jsonResponse(400, [{ message: 'no access to OpportunityContactRole' }]));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: true });
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(contactRecord.AccountId);
    });

    it('degrades to AccountId when the Opportunity lookup throws', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockRejectedValueOnce(new Error('socket hang up'));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: true });
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(contactRecord.AccountId);
    });
  });

  describe('IMPORTANT-2 — the Opportunity lookup is bounded so it degrades instead of hanging', () => {
    it('passes a 3s AbortSignal.timeout on the Opportunity lookup and degrades to AccountId on abort', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: true });
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(contactRecord.AccountId);
      expect(timeoutSpy).toHaveBeenCalledWith(3000);
      const secondCallInit = state.mockRequest.mock.calls[1]?.[1] as { signal?: AbortSignal } | undefined;
      expect(secondCallInit?.signal).toBeInstanceOf(AbortSignal);
      timeoutSpy.mockRestore();
    });
  });

  describe('IMPORTANT-4 — preference order pinned across all tiers: Contact, then Lead, then anything else', () => {
    it.each([
      ['Deal__c first', [dealRecord, contactRecord]],
      ['Contact first', [contactRecord, dealRecord]],
    ])('prefers the Contact over a Deal__c match (%s)', async (_label, records) => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: records }))
        .mockResolvedValueOnce(jsonResponse(200, { records: [] }));
      const match = await findByPhone('u1', E164, { preferOpenOpportunity: true });
      expect(match?.whoId).toBe(contactRecord.Id);
    });

    it.each([
      ['Deal__c first', [dealRecord, leadRecord]],
      ['Lead first', [leadRecord, dealRecord]],
    ])('prefers the Lead over a Deal__c match when no Contact is present (%s)', async (_label, records) => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: records }));
      const match = await findByPhone('u1', E164);
      expect(match?.whoId).toBe(leadRecord.Id);
      // Lead branch never triggers the Opportunity lookup.
      expect(state.mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('MINOR-5 — phone normalization actually drives the SOSL term', () => {
    it('wildcards the 10-digit number into 3-3-4 segments for the FIND term', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [] }));
      await findByPhone('u1', E164); // +18432127339 → strip '1' → 8432127339
      expect(soqlOf(0)).toContain('FIND {843*212*7339}');
    });

    it('strips the country code before wildcarding a different 11-digit +1 input', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [] }));
      await findByPhone('u1', '+14155552671'); // strip '1' → 4155552671
      expect(soqlOf(0)).toContain('FIND {415*555*2671}');
    });
  });

  describe('unchanged cases', () => {
    it('matches a Lead when no Contact is present (no Opportunity lookup performed)', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [leadRecord] }));
      const match = await findByPhone('u1', E164);
      expect(match).toEqual({ whoId: leadRecord.Id, name: leadRecord.Name, ambiguous: false });
      expect(state.mockRequest).toHaveBeenCalledTimes(1);
    });

    it('matches a Deal__c when it is the only record found', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [dealRecord] }));
      const match = await findByPhone('u1', E164);
      expect(match).toEqual({ whatId: dealRecord.Id, name: dealRecord.Name, ambiguous: false });
    });

    it('returns null when nothing matches', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { searchRecords: [] }));
      const match = await findByPhone('u1', E164);
      expect(match).toBeNull();
    });
  });
});

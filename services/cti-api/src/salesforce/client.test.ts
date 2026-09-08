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

  describe('Fix 3 — Contact match lands on its open Opportunity', () => {
    it('sets whatId to the primary open Opportunity when the Contact has one', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockResolvedValueOnce(jsonResponse(200, { records: [{ OpportunityId: OPEN_OPPORTUNITY_ID }] }));
      const match = await findByPhone('u1', E164);
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
      const match = await findByPhone('u1', E164);
      expect(match?.whatId).toBe(contactRecord.AccountId);
    });

    it('degrades to AccountId when the Opportunity lookup returns a non-2xx', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockResolvedValueOnce(jsonResponse(400, [{ message: 'no access to OpportunityContactRole' }]));
      const match = await findByPhone('u1', E164);
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(contactRecord.AccountId);
    });

    it('degrades to AccountId when the Opportunity lookup throws', async () => {
      state.mockRequest
        .mockResolvedValueOnce(jsonResponse(200, { searchRecords: [contactRecord] }))
        .mockRejectedValueOnce(new Error('socket hang up'));
      const match = await findByPhone('u1', E164);
      expect(match?.whoId).toBe(contactRecord.Id);
      expect(match?.whatId).toBe(contactRecord.AccountId);
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

/**
 * createCallTask — the CTI Origin marker and its degradation ladder.
 *
 * Same fake-transport convention as client.test.ts: 'undici' is mocked at the
 * module boundary so the REAL createCallTask runs against canned HTTP
 * responses. Nothing in './client.js' is mocked — it is the thing under test.
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

vi.mock('../config.js', () => ({ loadConfig: () => ({ SALESFORCE_API_VERSION: 'v60.0' }) }));
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
        query: { salesforceConnections: { findFirst: async () => state.sfConn } },
      }) as unknown as ReturnType<typeof import('@cti/db').getDb>,
  };
});
vi.mock('undici', () => ({ request: (...args: unknown[]) => state.mockRequest(...args) }));

import { createCallTask } from './client.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD } from './cti-origin.js';

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { text: async () => JSON.stringify(body) } };
}

/** The parsed JSON body of the Nth call to the fake transport. */
function bodyOf(callIndex: number): Record<string, unknown> {
  const opts = state.mockRequest.mock.calls[callIndex]?.[1] as { body?: string } | undefined;
  return opts?.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {};
}

const INVALID_FIELD = [
  { message: "No such column 'CTI_Origin__c' on entity 'Task'.", errorCode: 'INVALID_FIELD' },
];

const INPUT = {
  subject: 'Call — Jane Doe',
  whoId: '00Q1',
  customFields: { 'tdc_cti__Recording_URL__c': 'https://rec/1', 'tdc_cti__Call_Sid__c': 'CA1' },
};

describe('createCallTask — CTI Origin marker', () => {
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

  it('stamps the marker on the happy path, alongside the other custom fields', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW', success: true }));
    const out = await createCallTask('u1', INPUT);

    expect(out).toEqual({ taskId: '00TNEW' });
    expect(state.mockRequest).toHaveBeenCalledTimes(1);
    expect(bodyOf(0)[CTI_ORIGIN_FIELD]).toBe(CTI_ORIGIN.callLog);
    expect(bodyOf(0)['tdc_cti__Recording_URL__c']).toBe('https://rec/1');
  });

  // The marker must not be forgeable or clearable by a caller.
  it('wins over a customFields entry that tries to set the same key', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW', success: true }));
    await createCallTask('u1', {
      subject: 'x',
      customFields: { [CTI_ORIGIN_FIELD]: 'Typed by a person' },
    });
    expect(bodyOf(0)[CTI_ORIGIN_FIELD]).toBe(CTI_ORIGIN.callLog);
  });

  it('on INVALID_FIELD drops ONLY the marker and keeps the other custom fields', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW', success: true }));

    const out = await createCallTask('u1', INPUT);

    expect(out).toEqual({ taskId: '00TNEW', degradedFields: [CTI_ORIGIN_FIELD] });
    expect(state.mockRequest).toHaveBeenCalledTimes(2);
    const retry = bodyOf(1);
    expect(CTI_ORIGIN_FIELD in retry).toBe(false);
    // The whole point of the narrow retry: 360 CTI data survives.
    expect(retry['tdc_cti__Recording_URL__c']).toBe('https://rec/1');
    expect(retry['tdc_cti__Call_Sid__c']).toBe('CA1');
    expect(retry.Subject).toBe('Call — Jane Doe');
  });

  it('falls back to stripping every custom field when the marker-less retry also fails', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW', success: true }));

    const out = await createCallTask('u1', INPUT);

    expect(state.mockRequest).toHaveBeenCalledTimes(3);
    const stripped = bodyOf(2);
    expect(CTI_ORIGIN_FIELD in stripped).toBe(false);
    expect('tdc_cti__Recording_URL__c' in stripped).toBe(false);
    expect(stripped.Subject).toBe('Call — Jane Doe');
    expect(out.taskId).toBe('00TNEW');
    expect(out.degradedFields).toEqual(
      expect.arrayContaining([CTI_ORIGIN_FIELD, 'tdc_cti__Recording_URL__c', 'tdc_cti__Call_Sid__c']),
    );
  });

  it('does NOT retry on a non-INVALID_FIELD failure — it throws with the original body', async () => {
    state.mockRequest.mockResolvedValueOnce(
      jsonResponse(400, [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields missing' }]),
    );
    await expect(createCallTask('u1', INPUT)).rejects.toThrow(/REQUIRED_FIELD_MISSING/);
    expect(state.mockRequest).toHaveBeenCalledTimes(1);
  });

  // Before the marker existed, the FIRST INVALID_FIELD went straight to the
  // stripped payload. A flaky second call must not cost the caller that create.
  it('still reaches the strip-all fallback when the marker-less retry fails transiently', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(503, [{ errorCode: 'UNABLE_TO_LOCK_ROW' }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW', success: true }));

    const out = await createCallTask('u1', INPUT);

    expect(state.mockRequest).toHaveBeenCalledTimes(3);
    expect('tdc_cti__Recording_URL__c' in bodyOf(2)).toBe(false);
    expect(out.taskId).toBe('00TNEW');
  });

  it('names the offending column from the FIRST rejection when the stripped attempt also fails', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'STORAGE_LIMIT_EXCEEDED' }]));

    // The stripped attempt's error rarely says which field was wrong; the first
    // one does, and it is the only diagnostic worth having here.
    await expect(createCallTask('u1', INPUT)).rejects.toThrow(/CTI_Origin__c/);
  });

  it('throws when even the fully stripped payload is rejected', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(400, INVALID_FIELD))
      .mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'INVALID_FIELD' }]));
    await expect(createCallTask('u1', INPUT)).rejects.toThrow(/degraded/);
  });
});

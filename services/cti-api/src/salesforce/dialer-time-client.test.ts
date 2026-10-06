/**
 * dialer-time-client — the "Power Dialer Time" Task's create / patch / find.
 * Same fake-transport convention as create-call-task.test.ts: 'undici' is
 * mocked at the module boundary so the REAL client code runs against canned
 * HTTP responses.
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
vi.mock('@cti/auth', () => ({ encryptString: (s: string) => s, decryptString: (s: string) => s }));
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

import {
  DIALER_TIME_SUBJECT,
  buildDialerTimeTaskFields,
  createDialerTimeTask,
  dialerTimeDescription,
  findDialerTimeTask,
  updateDialerTimeTask,
} from './dialer-time-client.js';
import { CTI_ORIGIN, CTI_ORIGIN_FIELD } from './cti-origin.js';

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { text: async () => (body === undefined ? '' : JSON.stringify(body)) } };
}
function call(i: number): { url: string; method: string; body: Record<string, unknown> } {
  const [url, opts] = state.mockRequest.mock.calls[i] as [string, { method: string; body?: string }];
  return { url, method: opts.method, body: opts.body ? (JSON.parse(opts.body) as Record<string, unknown>) : {} };
}

beforeEach(() => {
  state.mockRequest.mockReset();
});

describe('dialerTimeDescription', () => {
  it('says the time counts only while dialing or talking, for that Pacific day', () => {
    expect(dialerTimeDescription('2026-10-05')).toBe(
      'Time on the power dialer on 2026-10-05, Pacific: counted while dialing or talking; quiet stretches over 15 minutes are left out. Kept up to date by the CTI.',
    );
  });
});

describe('buildDialerTimeTaskFields', () => {
  it('is a completed, non-call Task dated the Pacific day with the seconds as Call Duration', () => {
    expect(buildDialerTimeTaskFields('2026-10-02', 3254)).toEqual({
      Subject: 'Power Dialer Time',
      Status: 'Completed',
      Priority: 'Normal',
      TaskSubtype: 'Task',
      ActivityDate: '2026-10-02',
      CallDurationInSeconds: 3254,
      Description: dialerTimeDescription('2026-10-02'),
      [CTI_ORIGIN_FIELD]: CTI_ORIGIN.dialerTime,
    });
    expect(DIALER_TIME_SUBJECT).toBe('Power Dialer Time');
    expect(CTI_ORIGIN.dialerTime).toBe('Power Dialer Time');
  });

  it('never carries call or record fields', () => {
    const f = buildDialerTimeTaskFields('2026-10-02', 1);
    for (const k of ['CallType', 'CallDisposition', 'WhoId', 'WhatId']) expect(f).not.toHaveProperty(k);
  });
});

describe('createDialerTimeTask', () => {
  it('POSTs the Task as the rep and returns its id', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW1', success: true }));
    await expect(createDialerTimeTask('u1', '2026-10-02', 60)).resolves.toEqual({ taskId: '00TNEW1' });
    const c = call(0);
    expect(c.method).toBe('POST');
    expect(c.url).toBe('https://example.my.salesforce.com/services/data/v60.0/sobjects/Task');
    expect(c.body).toEqual(buildDialerTimeTaskFields('2026-10-02', 60));
  });

  it('retries once without the CTI marker when it is rejected as INVALID_FIELD', async () => {
    state.mockRequest
      .mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'INVALID_FIELD', message: 'No such column' }]))
      .mockResolvedValueOnce(jsonResponse(201, { id: '00TNEW2', success: true }));
    await expect(createDialerTimeTask('u1', '2026-10-02', 60)).resolves.toEqual({ taskId: '00TNEW2' });
    expect(call(1).body).not.toHaveProperty(CTI_ORIGIN_FIELD);
    expect(call(1).body.Subject).toBe('Power Dialer Time');
  });

  it('throws with the status in the message on any other rejection', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(400, [{ errorCode: 'REQUIRED_FIELD_MISSING' }]));
    await expect(createDialerTimeTask('u1', '2026-10-02', 60)).rejects.toThrow(
      /^Salesforce Power Dialer Time create failed \(400\): .*REQUIRED_FIELD_MISSING/,
    );
    expect(state.mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('updateDialerTimeTask', () => {
  it('PATCHes the Call Duration and the Description, nothing else', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(204, undefined));
    await expect(updateDialerTimeTask('u1', '00TX', '2026-10-02', 900)).resolves.toBe('updated');
    const c = call(0);
    expect(c.method).toBe('PATCH');
    expect(c.url).toBe('https://example.my.salesforce.com/services/data/v60.0/sobjects/Task/00TX');
    expect(c.body).toEqual({ CallDurationInSeconds: 900, Description: dialerTimeDescription('2026-10-02') });
  });

  it.each([
    [404, [{ errorCode: 'NOT_FOUND' }]],
    [404, [{ errorCode: 'ENTITY_IS_DELETED' }]],
    [400, [{ errorCode: 'ENTITY_IS_DELETED' }]],
  ])('reports a deleted Task as missing (%s)', async (status, body) => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(status, body));
    await expect(updateDialerTimeTask('u1', '00TX', '2026-10-02', 900)).resolves.toBe('missing');
  });

  it('throws on any other rejection', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(500, [{ errorCode: 'UNKNOWN_EXCEPTION' }]));
    await expect(updateDialerTimeTask('u1', '00TX', '2026-10-02', 900)).rejects.toThrow(/^Salesforce Power Dialer Time update failed \(500\): /);
  });
});

describe('findDialerTimeTask', () => {
  it('queries the rep-owned Task for that day, oldest first, and returns its id', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { records: [{ Id: '00TOLD' }] }));
    await expect(findDialerTimeTask('u1', '005ABC', '2026-10-02')).resolves.toBe('00TOLD');
    const q = new URL(call(0).url).searchParams.get('q');
    expect(q).toBe(
      "SELECT Id FROM Task WHERE Subject = 'Power Dialer Time' AND ActivityDate = 2026-10-02 AND OwnerId = '005ABC' ORDER BY CreatedDate ASC LIMIT 1",
    );
  });

  it('returns null when there is none', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { records: [] }));
    await expect(findDialerTimeTask('u1', '005ABC', '2026-10-02')).resolves.toBeNull();
  });

  it('escapes the owner id and refuses a malformed day without calling Salesforce', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { records: [] }));
    await findDialerTimeTask('u1', "005' OR Id != '", '2026-10-02');
    expect(new URL(call(0).url).searchParams.get('q')).toContain("OwnerId = '005\\' OR Id != \\''");
    await expect(findDialerTimeTask('u1', '005ABC', '2026-10-02 OR x')).rejects.toThrow(/invalid day/);
    expect(state.mockRequest).toHaveBeenCalledTimes(1);
  });
});

/**
 * createFeedItems — many Chatter posts in ONE sObject Collections request.
 *
 * Same fake-transport convention as client.test.ts / create-call-task.test.ts:
 * 'undici' is mocked at the module boundary so the REAL createFeedItems (and the
 * real sfFetch under it) run against canned HTTP responses. Nothing in
 * './client.js' is mocked — it is the thing under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  sfConn: {
    id: 'conn-1',
    userId: 'u1',
    accessTokenEnc: 'rep-access-token',
    refreshTokenEnc: null as string | null,
    instanceUrl: 'https://example.my.salesforce.com',
  } as Record<string, unknown> | null,
  mockRequest: vi.fn(),
  /** The connection lookup, recorded: it must be keyed on the rep, not on "whoever". */
  findFirst: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({ SALESFORCE_API_VERSION: 'v60.0' }) }));
vi.mock('@cti/auth', () => ({
  encryptString: (s: string) => s,
  decryptString: (s: string) => s,
}));
vi.mock('./oauth.js', () => ({ refreshAccessToken: (...args: unknown[]) => state.refresh(...args) }));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () =>
      ({
        query: { salesforceConnections: { findFirst: (...args: unknown[]) => state.findFirst(...args) } },
        // refreshAndPersist writes the refreshed token back; nothing here reads it.
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      }) as unknown as ReturnType<typeof import('@cti/db').getDb>,
  };
});
vi.mock('undici', () => ({ request: (...args: unknown[]) => state.mockRequest(...args) }));

import { FEED_ITEMS_PER_REQUEST, createFeedItems } from './client.js';

const dialect = new PgDialect();
const paramsOf = (where: unknown): unknown[] => dialect.sqlToQuery(where as SQL).params;
/** The rep's row comes back ONLY for a lookup keyed on the rep's user id — the
 *  way a real database would answer. A fake that ignored `where` would hand
 *  u1's token to any caller and prove nothing about "as the rep". */
function connectionsKeyedOnUser(): void {
  state.findFirst.mockImplementation(async (args: { where: unknown }) =>
    (paramsOf(args.where).includes('u1') ? state.sfConn : undefined));
}

function jsonResponse(statusCode: number, body: unknown) {
  return { statusCode, body: { text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) } };
}
function callOf(n: number): { url: string; method?: string; headers?: Record<string, string>; body: Record<string, unknown>; signal?: AbortSignal } {
  const [url, opts] = state.mockRequest.mock.calls[n] as [string, { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }];
  return { url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : {}, signal: opts.signal };
}

const LEAD = '00Q8X00000AbCdEUAV';
const OPP = '0068X00000AbCdEQAV';
const TEXT = 'No answer (Power Dialer) — 1 attempt: voicemail';

beforeEach(() => {
  state.mockRequest.mockReset();
  state.findFirst.mockReset();
  state.refresh.mockReset();
  state.sfConn!.refreshTokenEnc = null;
  connectionsKeyedOnUser();
});

describe('createFeedItems', () => {
  it('sends ONE collections request for the whole batch, as the rep, with the exact body', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [
      { id: '0D5A', success: true, errors: [] },
      { id: '0D5B', success: true, errors: [] },
    ]));
    const got = await createFeedItems('u1', [{ parentId: LEAD, body: TEXT }, { parentId: OPP, body: 'two' }]);

    expect(state.mockRequest).toHaveBeenCalledTimes(1);
    const call = callOf(0);
    expect(new URL(call.url).pathname).toBe('/services/data/v60.0/composite/sobjects');
    expect(call.method).toBe('POST');
    // Authored by the rep = sent on the rep's own token, not an integration user's.
    expect(call.headers?.authorization).toBe('Bearer rep-access-token');
    // …and that token was looked up BY the rep's user id, not by "whoever".
    expect(state.findFirst).toHaveBeenCalledTimes(1);
    expect(paramsOf((state.findFirst.mock.calls[0] as [{ where: unknown }])[0].where)).toEqual(['u1']);
    expect(call.body).toEqual({
      allOrNone: false,
      records: [
        { attributes: { type: 'FeedItem' }, ParentId: LEAD, Body: TEXT },
        { attributes: { type: 'FeedItem' }, ParentId: OPP, Body: 'two' },
      ],
    });
    expect(got).toEqual([{ ok: true, id: '0D5A' }, { ok: true, id: '0D5B' }]);
  });

  it('another user id does NOT get u1\'s token: no connection for them → SalesforceUnauthorizedError, and no request', async () => {
    await expect(createFeedItems('u2', [{ parentId: LEAD, body: TEXT }])).rejects.toThrow(/missing or revoked/);
    expect(paramsOf((state.findFirst.mock.calls[0] as [{ where: unknown }])[0].where)).toEqual(['u2']);
    expect(state.mockRequest).not.toHaveBeenCalled();
  });

  it('never touches the Connect API (per-user hourly rate limit, one call per post)', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [{ id: '0D5A', success: true, errors: [] }]));
    await createFeedItems('u1', [{ parentId: LEAD, body: TEXT }]);
    expect(callOf(0).url).not.toContain('/chatter/');
  });

  it('results are aligned BY INDEX: a per-record failure is reported for that record, the rest still succeed', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [
      { id: '0D5A', success: true, errors: [] },
      { success: false, errors: [
        { statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights on object id', fields: [] },
        { statusCode: 'SECOND_ERROR', message: 'ignored', fields: [] },
      ] },
      { id: '0D5C', success: true, errors: [] },
    ]));
    const got = await createFeedItems('u1', [
      { parentId: LEAD, body: 'a' }, { parentId: OPP, body: 'b' }, { parentId: LEAD, body: 'c' },
    ]);
    expect(got).toEqual([
      { ok: true, id: '0D5A' },
      { ok: false, statusCode: 'INSUFFICIENT_ACCESS_OR_READONLY', message: 'insufficient access rights on object id' },
      { ok: true, id: '0D5C' },
    ]);
  });

  it('a failure with no usable error entry still gets a terminal code (never undefined)', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [{ success: false, errors: [] }]));
    expect(await createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).toEqual([
      { ok: false, statusCode: 'UNKNOWN_ERROR', message: '' },
    ]);
  });

  it('a "success" with no id is reported as a failure code rather than stamped as a post with no id', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [{ success: true, errors: [] }]));
    expect(await createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).toEqual([
      { ok: false, statusCode: 'NO_ID_RETURNED', message: '' },
    ]);
  });

  it('a non-2xx response THROWS (transient for the whole chunk), status in the message', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(503, [{ errorCode: 'SERVER_UNAVAILABLE', message: 'try later' }]));
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).rejects.toThrow(/\(503\)/);
  });

  it('a 400 whose body is a 1-element error array for a 1-post request is a THROW with (400) — never a per-record stamp', async () => {
    // Salesforce's request-level error body is `[{message, errorCode}]`: an
    // array, and for a single post one of the same length as the request. Only
    // the status keeps it from being read as an index-aligned per-record answer.
    state.mockRequest.mockResolvedValueOnce(jsonResponse(400, [{ message: 'Cannot deserialize instance', errorCode: 'JSON_PARSER_ERROR' }]));
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).rejects.toThrow(/\(400\)/);
  });

  it('a 401 that survives the refresh is a THROW with (401) in the message, so isSalesforceAuthError can see it', async () => {
    state.sfConn!.refreshTokenEnc = 'rt';
    state.refresh.mockResolvedValueOnce({ access_token: 'refreshed-token' });
    const dead = jsonResponse(401, [{ message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' }]);
    state.mockRequest.mockResolvedValueOnce(dead).mockResolvedValueOnce(dead);
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).rejects.toThrow(/\(401\)/);
    expect(state.mockRequest).toHaveBeenCalledTimes(2);
    expect(callOf(1).headers?.authorization).toBe('Bearer refreshed-token');
  });

  it('a dead connection propagates as SalesforceUnauthorizedError (the worker\'s isSalesforceAuthError knows it)', async () => {
    // 401 + refreshTokenEnc null → sfFetch's refresh throws SalesforceUnauthorizedError.
    state.mockRequest.mockResolvedValueOnce(jsonResponse(401, [{ errorCode: 'INVALID_SESSION_ID' }]));
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).rejects.toThrow(/missing or revoked/);
  });

  it('a 2xx whose body is not an array THROWS — nothing can be aligned to it', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, { hasErrors: false }));
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).rejects.toThrow(/not an array/);
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, '<html>gateway</html>'));
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }])).rejects.toThrow(/not an array/);
  });

  it('an array of the WRONG LENGTH throws — index alignment is the whole contract', async () => {
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [{ id: '0D5A', success: true, errors: [] }]));
    await expect(createFeedItems('u1', [{ parentId: LEAD, body: 'a' }, { parentId: OPP, body: 'b' }]))
      .rejects.toThrow(/1 results for 2 records/);
  });

  it('refuses more than 200 records BEFORE any request — the caller chunks (and stamps between chunks)', async () => {
    expect(FEED_ITEMS_PER_REQUEST).toBe(200);
    const posts = Array.from({ length: 201 }, () => ({ parentId: LEAD, body: 'a' }));
    await expect(createFeedItems('u1', posts)).rejects.toThrow(/at most 200/);
    expect(state.mockRequest).not.toHaveBeenCalled();
  });

  it('exactly 200 is allowed', async () => {
    const posts = Array.from({ length: 200 }, () => ({ parentId: LEAD, body: 'a' }));
    state.mockRequest.mockResolvedValueOnce(jsonResponse(200, posts.map((_, i) => ({ id: `0D5${i}`, success: true, errors: [] }))));
    expect(await createFeedItems('u1', posts)).toHaveLength(200);
  });

  it('no posts → no request', async () => {
    expect(await createFeedItems('u1', [])).toEqual([]);
    expect(state.mockRequest).not.toHaveBeenCalled();
  });

  describe('abort — a timed-out request must not linger and land late (the duplicate chunk)', () => {
    it('the caller\'s AbortSignal reaches the HTTP request', async () => {
      const controller = new AbortController();
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [{ id: '0D5A', success: true, errors: [] }]));
      await createFeedItems('u1', [{ parentId: LEAD, body: 'a' }], { signal: controller.signal });
      expect(callOf(0).signal).toBe(controller.signal);
    });

    it('without one, no signal is attached (undici treats undefined as a no-op)', async () => {
      state.mockRequest.mockResolvedValueOnce(jsonResponse(200, [{ id: '0D5A', success: true, errors: [] }]));
      await createFeedItems('u1', [{ parentId: LEAD, body: 'a' }]);
      expect(callOf(0).signal).toBeUndefined();
    });

    it('an aborted request REJECTS — it is never read as a per-record terminal answer', async () => {
      const controller = new AbortController();
      // What undici does: reject at once on an already-aborted signal, or when
      // it fires mid-flight. Never a response body.
      state.mockRequest.mockImplementationOnce((_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'));
          if (opts.signal.aborted) abort(); else opts.signal.addEventListener('abort', abort);
        }));
      const p = createFeedItems('u1', [{ parentId: LEAD, body: 'a' }], { signal: controller.signal });
      const settled = expect(p).rejects.toThrow(/aborted/);
      await vi.waitFor(() => expect(state.mockRequest).toHaveBeenCalledTimes(1)); // in flight
      controller.abort();
      await settled;
    });
  });
});

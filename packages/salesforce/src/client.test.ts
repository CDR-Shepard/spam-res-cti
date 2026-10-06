import { describe, expect, it, vi } from 'vitest';
import { SALESFORCE_REQUEST_TIMEOUT_MS, SalesforceClient, type TokenSource } from './client.js';
import { QueryTooLargeError, SalesforceApiError, SalesforceAuthError } from './errors.js';
import { fakeFetch, type FakeScript } from './fake-fetch.js';

const INSTANCE = 'https://gg.my.salesforce.com';

function tokens(over: Partial<TokenSource> = {}): TokenSource {
  return {
    current: vi.fn(async () => ({ accessToken: 'old-token', instanceUrl: INSTANCE })),
    refresh: vi.fn(async () => ({ accessToken: 'new-token', instanceUrl: INSTANCE })),
    ...over,
  };
}

function client(script: FakeScript, t: TokenSource = tokens()) {
  const http = fakeFetch(script);
  return { sf: new SalesforceClient({ tokens: t, apiVersion: 'v60.0', fetchImpl: http.impl }), http, t };
}

describe('SalesforceClient.request', () => {
  it('calls /services/data/{version}{path} with the bearer token, query params, and a JSON body', async () => {
    const { sf, http } = client([{ status: 200, body: { ok: true } }]);
    const res = await sf.request('/sobjects/Task', { method: 'POST', body: { Subject: 'Hi' }, query: { a: '1 2' } });
    expect(res).toEqual({ status: 200, json: { ok: true } });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe(`${INSTANCE}/services/data/v60.0/sobjects/Task?a=1+2`);
    expect(http.calls[0]!.method).toBe('POST');
    expect(http.calls[0]!.headers.authorization).toBe('Bearer old-token');
    expect(http.calls[0]!.headers['content-type']).toBe('application/json');
    expect(http.calls[0]!.body).toBe('{"Subject":"Hi"}');
  });

  it('on 401 refreshes once and retries with the new token and instance URL', async () => {
    const t = tokens({ refresh: vi.fn(async () => ({ accessToken: 'new-token', instanceUrl: 'https://gg2.my.salesforce.com' })) });
    const { sf, http } = client([{ status: 401, body: [{ errorCode: 'INVALID_SESSION_ID' }] }, { status: 200, body: { id: 'x' } }], t);
    const res = await sf.request('/sobjects/Lead/describe');
    expect(res).toEqual({ status: 200, json: { id: 'x' } });
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(http.calls.map((c) => c.headers.authorization)).toEqual(['Bearer old-token', 'Bearer new-token']);
    expect(http.calls[1]!.url).toBe('https://gg2.my.salesforce.com/services/data/v60.0/sobjects/Lead/describe');
  });

  it('a second 401 after the refresh throws SalesforceAuthError', async () => {
    const { sf, http, t } = client([{ status: 401 }, { status: 401 }]);
    await expect(sf.request('/limits')).rejects.toBeInstanceOf(SalesforceAuthError);
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(http.calls).toHaveLength(2);
  });

  it('a failed refresh propagates and makes no second call', async () => {
    const t = tokens({ refresh: vi.fn(async () => { throw new SalesforceAuthError('refresh failed'); }) });
    const { sf, http } = client([{ status: 401 }], t);
    await expect(sf.request('/limits')).rejects.toThrow('refresh failed');
    expect(http.calls).toHaveLength(1);
  });

  it('returns other error statuses without refreshing', async () => {
    const { sf, t } = client([{ status: 400, body: [{ errorCode: 'MALFORMED_QUERY' }] }]);
    expect(await sf.request('/query', { query: { q: 'x' } })).toEqual({ status: 400, json: [{ errorCode: 'MALFORMED_QUERY' }] });
    expect(t.refresh).not.toHaveBeenCalled();
  });

  it('wraps a non-JSON body as { raw } and an empty body as null', async () => {
    const { sf } = client([{ status: 502, text: '<html>bad gateway</html>' }, { status: 204 }]);
    expect(await sf.request('/a')).toEqual({ status: 502, json: { raw: '<html>bad gateway</html>' } });
    expect(await sf.request('/b', { method: 'DELETE' })).toEqual({ status: 204, json: null });
  });
});

describe('SalesforceClient timeouts and network failures', () => {
  it('sends an abort signal on every request and honours the caller signal as well', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const impl = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const sf = new SalesforceClient({ tokens: tokens(), apiVersion: 'v60.0', fetchImpl: impl });
    await sf.request('/limits');
    const caller = new AbortController();
    await sf.request('/limits', { signal: caller.signal });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[0]!.aborted).toBe(false);
    expect(seen[1]!.aborted).toBe(false);
    caller.abort();
    expect(seen[1]!.aborted).toBe(true);
  });

  it('the default timeout is 30 seconds', () => {
    expect(SALESFORCE_REQUEST_TIMEOUT_MS).toBe(30_000);
  });

  it('wraps a rejected fetch (network failure or timeout) as a SalesforceApiError', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const sf = new SalesforceClient({ tokens: tokens(), apiVersion: 'v60.0', fetchImpl: impl });
    const err = await sf.request('/limits').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('wraps a body read that rejects as a SalesforceApiError', async () => {
    const impl = (async () => ({ status: 200, text: async () => { throw new TypeError('terminated'); } })) as unknown as typeof fetch;
    const sf = new SalesforceClient({ tokens: tokens(), apiVersion: 'v60.0', fetchImpl: impl });
    await expect(sf.request('/limits')).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

describe('SalesforceClient.query', () => {
  it('returns the first page only', async () => {
    const { sf, http } = client([
      { status: 200, body: { totalSize: 3, done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-2', records: [{ Id: 'a' }] } },
    ]);
    expect(await sf.query('SELECT Id FROM Lead')).toEqual([{ Id: 'a' }]);
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]!.url).searchParams.get('q')).toBe('SELECT Id FROM Lead');
  });

  it('throws SalesforceApiError carrying the status and Salesforce body on >= 400', async () => {
    const body = [{ message: "unexpected token: 'FORM'", errorCode: 'MALFORMED_QUERY' }];
    const { sf } = client([{ status: 400, body }]);
    const err = await sf.query('SELECT Id FORM Lead').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SalesforceApiError);
    expect((err as SalesforceApiError).status).toBe(400);
    expect((err as SalesforceApiError).body).toEqual(body);
    expect((err as SalesforceApiError).message).toContain('MALFORMED_QUERY');
  });
});

describe('SalesforceClient.queryIncludingArchived (final review OUT I-1)', () => {
  it('reads the first page of the REST queryAll resource, which also returns archived activities', async () => {
    const { sf, http } = client([
      { status: 200, body: { totalSize: 2, done: false, nextRecordsUrl: '/services/data/v60.0/queryAll/01g-2', records: [{ Id: 'a' }] } },
    ]);
    expect(await sf.queryIncludingArchived('SELECT Id FROM Task WHERE IsDeleted = false LIMIT 5')).toEqual([{ Id: 'a' }]);
    expect(http.calls).toHaveLength(1);
    const url = new URL(http.calls[0]!.url);
    expect(url.pathname).toBe('/services/data/v60.0/queryAll');
    expect(url.searchParams.get('q')).toBe('SELECT Id FROM Task WHERE IsDeleted = false LIMIT 5');
  });

  it('throws SalesforceApiError on >= 400', async () => {
    const { sf } = client([{ status: 400, body: [{ message: 'bad', errorCode: 'INVALID_FIELD' }] }]);
    await expect(sf.queryIncludingArchived('SELECT Nope FROM Task')).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

describe('SalesforceClient.queryAll', () => {
  const page = (records: unknown[], next: string | null, totalSize = 5) => ({
    status: 200,
    body: { totalSize, done: next === null, ...(next ? { nextRecordsUrl: next } : {}), records },
  });

  it('follows nextRecordsUrl across three pages, in order', async () => {
    const { sf, http } = client([
      page([{ Id: '1' }, { Id: '2' }], '/services/data/v60.0/query/01gXX-2000'),
      page([{ Id: '3' }, { Id: '4' }], '/services/data/v60.0/query/01gXX-4000'),
      page([{ Id: '5' }], null),
    ]);
    expect(await sf.queryAll('SELECT Id FROM Lead')).toEqual([{ Id: '1' }, { Id: '2' }, { Id: '3' }, { Id: '4' }, { Id: '5' }]);
    expect(http.calls.map((c) => c.url)).toEqual([
      `${INSTANCE}/services/data/v60.0/query?q=SELECT+Id+FROM+Lead`,
      `${INSTANCE}/services/data/v60.0/query/01gXX-2000`,
      `${INSTANCE}/services/data/v60.0/query/01gXX-4000`,
    ]);
  });

  it('throws QueryTooLargeError from totalSize before fetching more pages', async () => {
    const { sf, http } = client([page([{ Id: '1' }], '/services/data/v60.0/query/01gXX-2000', 50_001)]);
    const err = await sf.queryAll('SELECT Id FROM Lead').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryTooLargeError);
    expect((err as QueryTooLargeError).limit).toBe(50_000);
    expect(http.calls).toHaveLength(1);
  });

  it('throws QueryTooLargeError when the rows pass maxRecords even without a totalSize', async () => {
    const { sf } = client([
      { status: 200, body: { done: false, nextRecordsUrl: '/services/data/v60.0/query/01gXX-2', records: [{ Id: '1' }, { Id: '2' }] } },
      { status: 200, body: { done: true, records: [{ Id: '3' }] } },
    ]);
    await expect(sf.queryAll('SELECT Id FROM Lead', { maxRecords: 2 })).rejects.toBeInstanceOf(QueryTooLargeError);
  });

  it('allows exactly maxRecords', async () => {
    const { sf } = client([page([{ Id: '1' }, { Id: '2' }], null, 2)]);
    expect(await sf.queryAll('SELECT Id FROM Lead', { maxRecords: 2 })).toHaveLength(2);
  });

  it('refuses to follow a next-page URL outside /services/data/ (never sends the token elsewhere)', async () => {
    const { sf, http } = client([page([{ Id: '1' }], 'https://evil.example/steal')]);
    await expect(sf.queryAll('SELECT Id FROM Lead')).rejects.toBeInstanceOf(SalesforceApiError);
    expect(http.calls).toHaveLength(1);
  });

  it('a page error mid-way throws SalesforceApiError', async () => {
    const { sf } = client([page([{ Id: '1' }], '/services/data/v60.0/query/01gXX-2'), { status: 500, body: [{ errorCode: 'UNKNOWN' }] }]);
    await expect(sf.queryAll('SELECT Id FROM Lead')).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchResetDue, postResetComplete, RESET_COMPLETE_TIMEOUT_MS } from './use-cti-reset';

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as Response;
}

beforeEach(() => {
  localStorage.setItem('cti.session.v1', JSON.stringify({ token: 'tok', userId: 'u1', email: 'rep@x.com' }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('fetchResetDue', () => {
  it('GETs /auth/reset-signal with the session token, and is true only for resetDue === true', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ resetDue: true }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchResetDue()).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/auth\/reset-signal$/);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    for (const body of [{ resetDue: false }, {}, { resetDue: 'true' }, null]) {
      fetchMock.mockResolvedValueOnce(jsonResponse(body));
      await expect(fetchResetDue()).resolves.toBe(false);
    }
  });

  it('rejects on a 401, which the poller ignores (never a sign-out)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401)));
    await expect(fetchResetDue()).rejects.toMatchObject({ status: 401 });
  });
});

describe('postResetComplete', () => {
  it('POSTs /auth/reset-complete with the session token', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await postResetComplete();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/auth\/reset-complete$/);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('gives up after 5 s, so a hung network cannot leave the rep without a Device for long', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const done = expect(postResetComplete()).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(RESET_COMPLETE_TIMEOUT_MS);
    await done;
  });
});

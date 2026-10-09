import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, apiEmpty, ApiRequestError, apiSession, SESSION_STORAGE_KEY, setUnauthorizedHandler } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  apiSession.set(null);
  localStorage.clear();
  setUnauthorizedHandler(null);
});

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api', () => {
  it('sends the bearer and X-Org-Id and parses the response', async () => {
    apiSession.set({ token: 'tok', orgId: 'O2' });
    const f = stubFetch(200, { ok: true });
    await expect(api('/api/x', z.object({ ok: z.boolean() }))).resolves.toEqual({ ok: true });
    const headers = new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get('authorization')).toBe('Bearer tok');
    expect(headers.get('x-org-id')).toBe('O2');
  });
  it('turns an error envelope into ApiRequestError with the code', async () => {
    stubFetch(403, { error: 'Admin access required', code: 'ADMIN_ONLY', requestId: 'r1' });
    await expect(api('/api/x', z.any())).rejects.toMatchObject({ name: 'ApiRequestError', status: 403, code: 'ADMIN_ONLY' });
  });
  it("keeps the error envelope's details (a 429's retryAt)", async () => {
    stubFetch(429, { error: 'Slow down', code: 'RATE_LIMITED', details: { retryAt: '2026-10-06T18:00:00.000Z' } });
    await expect(api('/api/x', z.any())).rejects.toMatchObject({ status: 429, details: { retryAt: '2026-10-06T18:00:00.000Z' } });
  });
  it('apiEmpty accepts 204', async () => {
    stubFetch(204, undefined);
    await expect(apiEmpty('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
  it('a 401 from /api/team calls the unauthorized handler and clears the bearer', async () => {
    apiSession.set({ token: 'tok' });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stubFetch(401, { error: 'Session expired', code: 'UNAUTHENTICATED' });
    await expect(api('/api/team', z.any())).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(apiSession.get()).toBeNull();
  });
  it('a 401 from GET /api/auth/session does not clear the session or call the handler', async () => {
    apiSession.set({ token: 'tok' });
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    stubFetch(401, { error: 'no session', code: 'UNAUTHENTICATED' });
    await expect(api('/api/auth/session', z.any())).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
    expect(apiSession.get()).toEqual({ token: 'tok' });
  });
});

describe('apiSession persistence (stay signed in across reloads and browser restarts)', () => {
  it('writes the token to localStorage — not sessionStorage, which a browser restart drops — and set(null) removes it', () => {
    apiSession.set({ token: 'tok' });
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('tok');
    expect(sessionStorage.length).toBe(0);
    apiSession.set(null);
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(apiSession.get()).toBeNull();
  });
  it("persists only the token: a super admin's selected org stays per-tab and is gone after a reload", () => {
    apiSession.set({ token: 'tok', orgId: 'O2' });
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('tok');
    expect(apiSession.get()).toEqual({ token: 'tok', orgId: 'O2' });
    apiSession.set(null);
    localStorage.setItem(SESSION_STORAGE_KEY, 'tok');
    expect(apiSession.get()).toEqual({ token: 'tok' });
  });
  it('a reloaded page sees the stored token and sends it as the bearer', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    expect(apiSession.get()).toEqual({ token: 'stored-tok' });
    const f = stubFetch(200, { ok: true });
    await api('/api/x', z.object({ ok: z.boolean() }));
    expect(new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe('Bearer stored-tok');
  });
  it('another tab signing in as someone else wins: its token is used, and the old tab\'s org selection is not carried over', () => {
    apiSession.set({ token: 'mine', orgId: 'O2' });
    localStorage.setItem(SESSION_STORAGE_KEY, 'theirs');
    expect(apiSession.get()).toEqual({ token: 'theirs' });
  });
  it('a 401 clears the stored token too, so the next page load starts signed out', async () => {
    apiSession.set({ token: 'tok' });
    stubFetch(401, { error: 'Session expired', code: 'UNAUTHENTICATED' });
    await expect(api('/api/team', z.any())).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
  it('a 401 from GET /api/auth/session leaves the stored token alone, like it leaves the in-memory one', async () => {
    apiSession.set({ token: 'tok' });
    stubFetch(401, { error: 'no session', code: 'UNAUTHENTICATED' });
    await expect(api('/api/auth/session', z.any())).rejects.toMatchObject({ status: 401 });
    expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('tok');
  });

  describe('when storage throws (private mode, blocked cookies, quota)', () => {
    const denied = () => { throw new DOMException('denied', 'SecurityError'); };
    it('falls back to memory: the session still works for this tab and nothing throws', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied);
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied);
      vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(denied);
      expect(() => apiSession.set({ token: 'tok', orgId: 'O2' })).not.toThrow();
      expect(apiSession.get()).toEqual({ token: 'tok', orgId: 'O2' });
      const f = stubFetch(200, { ok: true });
      await api('/api/x', z.object({ ok: z.boolean() }));
      expect(new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe('Bearer tok');
      expect(() => apiSession.set(null)).not.toThrow();
      expect(apiSession.get()).toBeNull();
    });
    it('falls back to memory when merely touching localStorage throws', () => {
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(denied);
      expect(() => apiSession.set({ token: 'tok' })).not.toThrow();
      expect(apiSession.get()).toEqual({ token: 'tok' });
      apiSession.set(null);
      expect(apiSession.get()).toBeNull();
    });
  });
});

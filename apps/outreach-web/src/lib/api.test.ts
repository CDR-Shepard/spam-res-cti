import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, apiEmpty, ApiRequestError, apiSession, isSessionChangedElsewhere, SESSION_STORAGE_KEY, setUnauthorizedHandler } from './api';

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
  it('keeps the whole error body, for routes that answer in their own shape', async () => {
    stubFetch(400, { error: 'invalid_prompt', problems: ['Prompt is empty'] });
    await expect(api('/api/x', z.any())).rejects.toMatchObject({ status: 400, code: 'UNKNOWN', body: { error: 'invalid_prompt', problems: ['Prompt is empty'] } });
  });
  it('keeps no body when the error has none that reads as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502 })));
    const err = await api('/api/x', z.any()).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 502, code: 'UNKNOWN', message: 'HTTP 502', body: null });
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
    expect(apiSession.restore()).toEqual({ token: 'tok' });
  });
  it('a reloaded page restores the stored token and sends it as the bearer', async () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'stored-tok');
    expect(apiSession.get()).toBeNull();
    expect(apiSession.restore()).toEqual({ token: 'stored-tok' });
    expect(apiSession.get()).toEqual({ token: 'stored-tok' });
    const f = stubFetch(200, { ok: true });
    await api('/api/x', z.object({ ok: z.boolean() }));
    expect(new Headers((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get('authorization')).toBe('Bearer stored-tok');
  });
  it("never silently switches to another tab's token: this tab keeps its own session, selected org included, until it reloads", () => {
    apiSession.set({ token: 'mine', orgId: 'O2' });
    localStorage.setItem(SESSION_STORAGE_KEY, 'theirs');
    expect(apiSession.get()).toEqual({ token: 'mine', orgId: 'O2' });
  });
  it('a signed-out tab does not pick up another tab\'s sign-in by itself either', () => {
    localStorage.setItem(SESSION_STORAGE_KEY, 'theirs');
    expect(apiSession.get()).toBeNull();
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

  describe('a late 401 never undoes a newer sign-in', () => {
    /** A request sent with the current token whose 401 the test releases by hand. */
    function holdRequest() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.stubGlobal('fetch', vi.fn(async () => {
        await gate;
        return new Response(JSON.stringify({ error: 'Session expired', code: 'UNAUTHENTICATED' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }));
      return release;
    }
    it('this tab signed in again while the old token was in flight: the new token, storage and UI state survive', async () => {
      apiSession.set({ token: 'old' });
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      const release = holdRequest();
      const pending = api('/api/team', z.any());
      apiSession.set({ token: 'new' });
      release();
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(handler).not.toHaveBeenCalled();
      expect(apiSession.get()).toEqual({ token: 'new' });
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('new');
    });
    it("another tab stored a newer token: this tab drops its refused one, and the other tab's token in storage is left alone", async () => {
      apiSession.set({ token: 'old' });
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      const release = holdRequest();
      const pending = api('/api/team', z.any());
      localStorage.setItem(SESSION_STORAGE_KEY, 'theirs');
      release();
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(apiSession.get()).toBeNull();
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBe('theirs');
    });
    it('a 401 for a request that carried no token has no session to drop and does not sign anyone out', async () => {
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      const release = holdRequest();
      const pending = api('/api/team', z.any());
      apiSession.set({ token: 'signed-in-meanwhile' });
      release();
      await expect(pending).rejects.toMatchObject({ status: 401 });
      expect(handler).not.toHaveBeenCalled();
      expect(apiSession.get()).toEqual({ token: 'signed-in-meanwhile' });
    });
  });

  describe('isSessionChangedElsewhere (the storage event another tab fires)', () => {
    const event = (init: StorageEventInit) => new StorageEvent('storage', init);
    it('is true when another tab signed in as someone else, or signed out', () => {
      apiSession.set({ token: 'mine' });
      expect(isSessionChangedElsewhere(event({ key: SESSION_STORAGE_KEY, newValue: 'theirs', oldValue: 'mine' }))).toBe(true);
      expect(isSessionChangedElsewhere(event({ key: SESSION_STORAGE_KEY, newValue: null, oldValue: 'mine' }))).toBe(true);
    });
    it('is true when another tab signed in while this one is signed out', () => {
      expect(isSessionChangedElsewhere(event({ key: SESSION_STORAGE_KEY, newValue: 'theirs' }))).toBe(true);
    });
    it('is true when another tab cleared all of localStorage (key is null) while this one is signed in', () => {
      apiSession.set({ token: 'mine' });
      expect(isSessionChangedElsewhere(event({ key: null, newValue: null }))).toBe(true);
    });
    it('is false when the new value is this tab\'s own token, or both are signed out', () => {
      apiSession.set({ token: 'mine' });
      expect(isSessionChangedElsewhere(event({ key: SESSION_STORAGE_KEY, newValue: 'mine' }))).toBe(false);
      apiSession.set(null);
      expect(isSessionChangedElsewhere(event({ key: SESSION_STORAGE_KEY, newValue: null }))).toBe(false);
    });
    it('is false for any other key', () => {
      apiSession.set({ token: 'mine' });
      expect(isSessionChangedElsewhere(event({ key: 'theme', newValue: 'dark' }))).toBe(false);
    });
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

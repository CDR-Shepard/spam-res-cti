import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, apiEmpty, ApiRequestError, apiSession, setUnauthorizedHandler } from './api';

afterEach(() => { vi.unstubAllGlobals(); apiSession.set(null); setUnauthorizedHandler(null); });

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

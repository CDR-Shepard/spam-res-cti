import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { api, apiEmpty, ApiRequestError, apiSession } from './api';

afterEach(() => { vi.unstubAllGlobals(); apiSession.set(null); });

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
});

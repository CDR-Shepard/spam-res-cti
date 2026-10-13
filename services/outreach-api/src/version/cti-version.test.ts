import { describe, expect, it, vi } from 'vitest';
import { CTI_VERSION_CACHE_MS, CTI_VERSION_TIMEOUT_MS, ctiCommitReader } from './cti-version.js';

const BASE = 'http://ctiapi.railway.internal:4000';
const healthz = (over: Record<string, unknown> = {}) => ({ ok: true, ts: '2026-10-13T21:41:00.000Z', commit: '8a398bc', startedAt: '2026-10-13T21:00:00.000Z', ...over });

type Init = RequestInit & { headers?: Record<string, string> };
function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init?: Init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}
function reader(fetchImpl: unknown, over: { baseUrl?: string | undefined; now?: () => number } = {}) {
  return ctiCommitReader({ baseUrl: 'baseUrl' in over ? over.baseUrl : BASE, fetchImpl: fetchImpl as typeof fetch, ...(over.now ? { now: over.now } : {}) });
}

describe('ctiCommitReader', () => {
  it('reads the commit from cti-api /healthz over the private-network base URL, with the 2 second timeout and no credentials', async () => {
    const f = fetchReturning(200, healthz());
    expect(await reader(f)()).toEqual({ commit: '8a398bc' });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/healthz`);
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(CTI_VERSION_TIMEOUT_MS).toBe(2_000);
    expect(init?.headers ?? {}).toEqual({});
  });

  it('tolerates a trailing slash on the base URL', async () => {
    const f = fetchReturning(200, healthz());
    await reader(f, { baseUrl: `${BASE}/` })();
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/healthz`);
  });

  it('shortens a full sha and never echoes a value that is not one', async () => {
    expect(await reader(fetchReturning(200, healthz({ commit: '8a398bc1f0e2d4c6b8a7e9f01234567890abcdef' })))()).toEqual({ commit: '8a398bc' });
    expect(await reader(fetchReturning(200, healthz({ commit: 'sk-live-secret-value' })))()).toEqual({ commit: 'dev' });
  });

  it('answers only the commit: nothing else from /healthz is passed on', async () => {
    expect(Object.keys((await reader(fetchReturning(200, healthz({ token: 'x' })))())!)).toEqual(['commit']);
  });

  it.each([
    ['a non-200', () => fetchReturning(503, healthz())],
    ['a body that is not JSON', () => fetchReturning(200, '<html>oops</html>')],
    ['a /healthz without a commit (an older deploy)', () => fetchReturning(200, { ok: true, ts: 'x' })],
    ['a network error', () => vi.fn(async () => { throw new TypeError('fetch failed'); })],
  ])('is null on %s', async (_label, make) => {
    expect(await reader(make())()).toBeNull();
  });

  it('is null, and asks nothing, when there is no CTI_INTERNAL_URL', async () => {
    const f = fetchReturning(200, healthz());
    expect(await reader(f, { baseUrl: undefined })()).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('is null when cti-api does not answer within the timeout', async () => {
    const hang = vi.fn((_url: string, init?: Init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const slow = ctiCommitReader({ baseUrl: BASE, fetchImpl: hang as unknown as typeof fetch, timeoutMs: 20 });
    expect(await slow()).toBeNull();
  });

  it('caches the answer for about 30 seconds, then asks again', async () => {
    let t = 1_000_000;
    const f = fetchReturning(200, healthz());
    const read = reader(f, { now: () => t });
    await read();
    t += CTI_VERSION_CACHE_MS - 1;
    await read();
    expect(f).toHaveBeenCalledTimes(1);
    t += 2;
    await read();
    expect(f).toHaveBeenCalledTimes(2);
    expect(CTI_VERSION_CACHE_MS).toBe(30_000);
  });

  it('caches a failure too, so a down cti-api costs one timeout per 30 seconds, not one per request', async () => {
    let t = 1_000_000;
    const f = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const read = reader(f, { now: () => t });
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    t += CTI_VERSION_CACHE_MS + 1;
    await read();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('requests that arrive together share one fetch', async () => {
    const f = fetchReturning(200, healthz());
    const read = reader(f);
    const answers = await Promise.all([read(), read(), read()]);
    expect(answers).toEqual([{ commit: '8a398bc' }, { commit: '8a398bc' }, { commit: '8a398bc' }]);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

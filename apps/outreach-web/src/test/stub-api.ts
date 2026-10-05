import { vi } from 'vitest';

export interface StubCall { url: string; method: string; body: unknown }

/** An explicit status (and optional body) for a stubbed route; any other route value is sent as a 200 JSON body. */
export class StubResponse {
  constructor(readonly status: number, readonly body: unknown = null) {}
}
export const respond = (status: number, body: unknown = null): StubResponse => new StubResponse(status, body);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Replaces `fetch` with a table keyed by `"<METHOD> <path?query>"` and records every call.
 * Unknown routes answer 404 so a missing stub fails loudly in the page under test.
 */
export function stubApi(routes: Record<string, unknown>): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes[`${method} ${url}`];
    if (route === undefined) return jsonResponse(404, { error: `No stub for ${method} ${url}`, code: 'NOT_FOUND' });
    if (route instanceof StubResponse) return route.status === 204 ? new Response(null, { status: 204 }) : jsonResponse(route.status, route.body);
    return jsonResponse(200, route);
  }));
  return calls;
}

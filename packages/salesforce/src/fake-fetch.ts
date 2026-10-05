/**
 * Test helper: a scripted stand-in for `fetch`. Every package test passes
 * `fakeFetch(...).impl` as `fetchImpl`, so no test touches the network.
 * Not exported from the package index.
 */
export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeReply {
  status: number;
  /** Serialized with JSON.stringify. */
  body?: unknown;
  /** Sent as-is (wins over `body`). */
  text?: string;
}

export type FakeScript = FakeReply[] | ((call: FakeCall, index: number) => FakeReply);

export function fakeFetch(script: FakeScript): { impl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: FakeCall = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const index = calls.length - 1;
    const reply = typeof script === 'function' ? script(call, index) : script[index];
    if (!reply) throw new Error(`fakeFetch: no reply scripted for call #${index + 1}: ${call.method} ${call.url}`);
    const text = reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text === '' ? null : text, { status: reply.status });
  }) as typeof fetch;
  return { impl, calls };
}

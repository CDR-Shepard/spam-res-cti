import { describe, expect, it, vi } from 'vitest';
import { ResendError, httpResendClient, type ResendSendRequest } from './resend-client.js';

const API_KEY = 're_test_key_do_not_leak';
const REQUEST: ResendSendRequest = {
  from: 'Sam at GG Homes <sam@rethinkre.team>',
  to: 'delivered@resend.dev',
  subject: 'Your home',
  text: 'Hello there',
  html: '<p>Hello there</p>',
  replyTo: 'sam+abcdefghijklmnopqrstuvwxyz@reply.rethinkre.team',
  headers: { 'List-Unsubscribe': '<mailto:unsubscribe+abc@reply.rethinkre.team>' },
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake fetch that answers once and records the call. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const fetchImpl = vi.fn<typeof fetch>(async () => answer());
  const lastCall = () => {
    const [url, init] = fetchImpl.mock.calls.at(-1) ?? [];
    return { url: String(url), init: init as RequestInit };
  };
  return { fetchImpl, lastCall };
}

describe('httpResendClient.send', () => {
  it('POSTs the email with the bearer key, the idempotency key and a Resend-shaped JSON body', async () => {
    const { fetchImpl, lastCall } = fakeFetch(() => json(200, { id: 'e1' }));
    const client = httpResendClient({ apiKey: API_KEY, fetchImpl });
    await client.send(REQUEST, 'email:x');

    const { url, init } = lastCall();
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(headers.get('idempotency-key')).toBe('email:x');
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({
      from: REQUEST.from,
      to: ['delivered@resend.dev'],
      subject: REQUEST.subject,
      text: REQUEST.text,
      html: REQUEST.html,
      reply_to: REQUEST.replyTo,
      headers: REQUEST.headers,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('answers sent with the id on a 200', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { id: 'e1' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'sent', id: 'e1' });
  });

  it('retries a 200 whose body has no id: nothing says it was sent, and the idempotency key makes a repeat safe', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { nope: true }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'HTTP 200 bad_response' });
  });

  it('retries a 503', async () => {
    const { fetchImpl } = fakeFetch(() => json(503, { statusCode: 503, name: 'application_error', message: 'try later' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'HTTP 503 application_error' });
  });

  it('retries a 5xx whose body is not JSON, with no name in the reason', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'HTTP 502' });
  });

  it('retries a 429', async () => {
    const { fetchImpl } = fakeFetch(() => json(429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'slow down' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'HTTP 429 rate_limit_exceeded' });
  });

  it('retries a 409 concurrent_idempotent_requests: the first attempt is still in flight', async () => {
    const { fetchImpl } = fakeFetch(() => json(409, { statusCode: 409, name: 'concurrent_idempotent_requests', message: 'in flight' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({
      kind: 'retry',
      reason: 'HTTP 409 concurrent_idempotent_requests',
    });
  });

  it('rejects a 422 validation_error, with only the status and the name in the reason', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json(422, { statusCode: 422, name: 'validation_error', message: 'The `to` field delivered@resend.dev is not valid' }),
    );
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'rejected', reason: 'HTTP 422 validation_error' });
  });

  it('rejects a 409 that is not the concurrent-request case (a key reused for a different body)', async () => {
    const { fetchImpl } = fakeFetch(() => json(409, { statusCode: 409, name: 'invalid_idempotent_request', message: 'different payload' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({
      kind: 'rejected',
      reason: 'HTTP 409 invalid_idempotent_request',
    });
  });

  it.each([400, 401, 403, 404])('rejects a %i', async (status) => {
    const { fetchImpl } = fakeFetch(() => json(status, { statusCode: status, name: 'invalid_api_key', message: 'nope' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'rejected', reason: `HTTP ${status} invalid_api_key` });
  });

  it('drops an error name that is not [a-z_]+, so a body can never reach a reason', async () => {
    const { fetchImpl } = fakeFetch(() => json(422, { statusCode: 422, name: 'Sorry, delivered@resend.dev bounced', message: 'x' }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'rejected', reason: 'HTTP 422' });
    const { fetchImpl: nonString } = fakeFetch(() => json(422, { name: 42 }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl: nonString }).send(REQUEST, 'email:x')).toEqual({ kind: 'rejected', reason: 'HTTP 422' });
  });

  it('retries with reason timeout when the request is aborted', async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new DOMException('The operation was aborted', 'AbortError')));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'timeout' });
  });

  it('retries with reason timeout when AbortSignal.timeout fires', async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'timeout' });
  });

  it('really times out on a fetch that never answers (default and overridden timeout)', async () => {
    const hang = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const fetchImpl = vi.fn<typeof fetch>(hang as typeof fetch);
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl, timeoutMs: 20 }).send(REQUEST, 'email:x')).toEqual({ kind: 'retry', reason: 'timeout' });
  });

  it('retries with reason network on any other thrown error, never carrying its message', async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new TypeError(`fetch failed for ${API_KEY} delivered@resend.dev`)));
    const result = await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x');
    expect(result).toEqual({ kind: 'retry', reason: 'network' });
  });

  it('never puts the API key, an address or the text in any outcome', async () => {
    const bodies = [
      () => json(422, { name: 'validation_error', message: `${API_KEY} delivered@resend.dev Hello there` }),
      () => json(503, { name: 'application_error', message: `${API_KEY} delivered@resend.dev Hello there` }),
      () => Promise.reject(new Error(`${API_KEY} delivered@resend.dev Hello there`)),
    ];
    for (const answer of bodies) {
      const { fetchImpl } = fakeFetch(answer);
      const result = await httpResendClient({ apiKey: API_KEY, fetchImpl }).send(REQUEST, 'email:x');
      const text = JSON.stringify(result);
      for (const secret of [API_KEY, 'delivered@resend.dev', 'Hello there']) expect(text).not.toContain(secret);
    }
  });
});

describe('httpResendClient.getReceived', () => {
  const PAYLOAD = {
    object: 'email',
    id: 'in-1',
    to: ['sam+abcdefghijklmnopqrstuvwxyz@reply.rethinkre.team'],
    from: 'Jo Seller <jo@example.com>',
    created_at: '2026-10-20T12:00:00.000Z',
    subject: 'Re: Your home',
    html: '<p>Yes please</p>',
    text: 'Yes please',
    headers: { 'Message-ID': '<abc@example.com>', 'In-Reply-To': '<sent@rethinkre.team>', 'X-Count': 3 },
    bcc: [],
    cc: ['cc@example.com'],
    reply_to: ['jo@example.com'],
    received_for: ['sam+abcdefghijklmnopqrstuvwxyz@reply.rethinkre.team'],
    message_id: '<abc@example.com>',
    attachments: [],
    unknown_future_field: { a: 1 },
  };

  it('GETs /emails/receiving/{id} with the bearer key and maps the payload, lowercasing header names', async () => {
    const { fetchImpl, lastCall } = fakeFetch(() => json(200, PAYLOAD));
    const email = await httpResendClient({ apiKey: API_KEY, fetchImpl }).getReceived('in-1');

    const { url, init } = lastCall();
    expect(url).toBe('https://api.resend.com/emails/receiving/in-1');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(email).toEqual({
      id: 'in-1',
      from: 'Jo Seller <jo@example.com>',
      to: ['sam+abcdefghijklmnopqrstuvwxyz@reply.rethinkre.team'],
      cc: ['cc@example.com'],
      receivedFor: ['sam+abcdefghijklmnopqrstuvwxyz@reply.rethinkre.team'],
      subject: 'Re: Your home',
      text: 'Yes please',
      html: '<p>Yes please</p>',
      headers: { 'message-id': '<abc@example.com>', 'in-reply-to': '<sent@rethinkre.team>', 'x-count': '3' },
      messageId: '<abc@example.com>',
    });
  });

  it('treats every field defensively: missing arrays are empty, missing text/html/message_id are null, a null subject is empty', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { id: 'in-2', from: 'jo@example.com', subject: null, text: null, html: null, headers: null, message_id: null }));
    expect(await httpResendClient({ apiKey: API_KEY, fetchImpl }).getReceived('in-2')).toEqual({
      id: 'in-2',
      from: 'jo@example.com',
      to: [],
      cc: [],
      receivedFor: [],
      subject: '',
      text: null,
      html: null,
      headers: {},
      messageId: null,
    });
  });

  it('keeps the first of two header names that differ only in case', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { id: 'in-3', from: 'jo@example.com', headers: { 'X-A': 'first', 'x-a': 'second' } }));
    expect((await httpResendClient({ apiKey: API_KEY, fetchImpl }).getReceived('in-3')).headers).toEqual({ 'x-a': 'first' });
  });

  it('percent-encodes the id so it can never change the path', async () => {
    const { fetchImpl, lastCall } = fakeFetch(() => json(200, { id: 'x', from: 'jo@example.com' }));
    await httpResendClient({ apiKey: API_KEY, fetchImpl }).getReceived('../emails/abc?x=1');
    expect(lastCall().url).toBe('https://api.resend.com/emails/receiving/..%2Femails%2Fabc%3Fx%3D1');
  });

  it('throws ResendError(status) on a non-200, with nothing from the body in it', async () => {
    const { fetchImpl } = fakeFetch(() => json(404, { statusCode: 404, name: 'not_found', message: `no email for ${API_KEY} jo@example.com` }));
    const err = await httpResendClient({ apiKey: API_KEY, fetchImpl }).getReceived('missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResendError);
    expect((err as ResendError).status).toBe(404);
    expect((err as ResendError).message).toBe('HTTP 404 not_found');
    expect(String((err as ResendError).message)).not.toContain('jo@example.com');
    expect(String((err as ResendError).message)).not.toContain(API_KEY);
  });

  it('throws ResendError(200) when the 200 body is not the expected shape', async () => {
    const { fetchImpl } = fakeFetch(() => json(200, { hello: 'world' }));
    const err = await httpResendClient({ apiKey: API_KEY, fetchImpl }).getReceived('in-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResendError);
    expect((err as ResendError).status).toBe(200);
    expect((err as ResendError).message).toBe('HTTP 200 bad_response');
  });

  it('throws ResendError(0) with a transport reason on a timeout or a network error, never the underlying message', async () => {
    const aborted = fakeFetch(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    const t = await httpResendClient({ apiKey: API_KEY, fetchImpl: aborted.fetchImpl }).getReceived('in-1').catch((e: unknown) => e);
    expect(t).toBeInstanceOf(ResendError);
    expect((t as ResendError).status).toBe(0);
    expect((t as ResendError).message).toBe('timeout');

    const down = fakeFetch(() => Promise.reject(new TypeError(`connect ECONNREFUSED ${API_KEY}`)));
    const n = await httpResendClient({ apiKey: API_KEY, fetchImpl: down.fetchImpl }).getReceived('in-1').catch((e: unknown) => e);
    expect(n).toBeInstanceOf(ResendError);
    expect((n as ResendError).message).toBe('network');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_SIGNATURE_HEADER, INTERNAL_TIMESTAMP_HEADER, verifyInternalRequest } from '@cti/auth';
import { INTERNAL_AI_PROMPT_CHECK_PATH, type AgentPromptCheck, type InternalAiCallRequest } from '@cti/contracts';
import { PROMPT_CHECK_TIMEOUT_MS, TRIGGER_TIMEOUT_MS, httpCtiClient } from './cti-client.js';

const SECRET = 'm'.repeat(40);
const BASE = 'http://ctiapi.railway.internal:4000';
const CALL = '33333333-2222-4333-8444-555555555555';
const REQ: InternalAiCallRequest = {
  orgId: '99999999-2222-4333-8444-555555555555',
  userId: '11111111-2222-4333-8444-555555555555',
  idempotencyKey: 'touch:44444444-2222-4333-8444-555555555555:1',
  target: { kind: 'record', objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH', planText: 'Opener: hi' },
};

type Init = RequestInit & { headers: Record<string, string> };
function fetchReturning(status: number, body: unknown) {
  return vi.fn(async (_url: string, _init: Init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
}
const client = (fetchImpl: unknown, url = BASE) =>
  httpCtiClient({ CTI_INTERNAL_URL: url, OUTREACH_INTERNAL_SECRET: SECRET }, fetchImpl as typeof fetch);

describe('httpCtiClient.trigger', () => {
  it('1: POSTs the exact JSON body to /internal/ai-calls with headers cti-api verifies', async () => {
    const f = fetchReturning(200, { result: 'placed', aiCallId: CALL });
    await client(f).trigger(REQ);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/internal/ai-calls`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(REQ));
    const verdict = verifyInternalRequest(
      SECRET,
      { method: 'POST', path: '/internal/ai-calls', body: JSON.stringify(REQ) },
      { timestamp: init.headers[INTERNAL_TIMESTAMP_HEADER], signature: init.headers[INTERNAL_SIGNATURE_HEADER] },
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('2: a 200 with a valid response is the response', async () => {
    const answer = { result: 'blocked', reason: 'calling_hours', aiCallId: CALL };
    expect(await client(fetchReturning(200, answer)).trigger(REQ)).toEqual({ kind: 'response', response: answer });
  });

  it.each([
    ['an unknown result', { result: 'maybe' }],
    ['a block reason that is not one', { result: 'blocked', reason: 'twilio_error', aiCallId: CALL }],
    ['not JSON', '<html>oops</html>'],
  ])('3: a 200 with %s is a transport error bad_response', async (_label, body) => {
    expect(await client(fetchReturning(200, body)).trigger(REQ)).toEqual({ kind: 'transport', error: 'bad_response' });
  });

  it.each([
    [401, { error: 'bad_signature' }, 'HTTP 401 bad_signature'],
    [404, { error: 'not_found' }, 'HTTP 404 not_found'],
    [429, { statusCode: 429, message: 'Rate limit exceeded' }, 'HTTP 429'],
    [503, { error: 'internal_disabled' }, 'HTTP 503 internal_disabled'],
    [500, 'not json', 'HTTP 500'],
  ])('4: HTTP %i is a transport error naming the status and the body error', async (status, body, error) => {
    expect(await client(fetchReturning(status, body)).trigger(REQ)).toEqual({ kind: 'transport', error });
  });

  it('M-3: HTTP 409 is an idempotency conflict, not a transport error: cti-api already holds or answered the key', async () => {
    expect(await client(fetchReturning(409, { error: 'idempotency_conflict' })).trigger(REQ)).toEqual({ kind: 'conflict' });
    expect(await client(fetchReturning(409, 'not json')).trigger(REQ)).toEqual({ kind: 'conflict' });
  });

  it('5: passes a timeout signal; a timeout or abort is "timeout"', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const f = vi.fn(async (_url: string, init: Init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await client(f).trigger(REQ)).toEqual({ kind: 'transport', error: 'timeout' });
    expect(timeout).toHaveBeenCalledWith(TRIGGER_TIMEOUT_MS);
    expect(TRIGGER_TIMEOUT_MS).toBe(20_000);
    const aborted = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    expect(await client(aborted).trigger(REQ)).toEqual({ kind: 'transport', error: 'timeout' });
    timeout.mockRestore();
  });

  it('5: a refused connection is "network"', async () => {
    const f = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    });
    expect(await client(f).trigger(REQ)).toEqual({ kind: 'transport', error: 'network' });
  });

  it('7: a trailing slash on CTI_INTERNAL_URL is tolerated', async () => {
    const f = fetchReturning(200, { result: 'placed', aiCallId: CALL });
    await client(f, `${BASE}//`).trigger(REQ);
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/internal/ai-calls`);
  });
});

describe('httpCtiClient.availability', () => {
  it('6: a signed GET over an empty body, parsed', async () => {
    const f = fetchReturning(200, { available: true, testNumbers: ['+15125550100'] });
    expect(await client(f).availability()).toEqual({ available: true, testNumbers: ['+15125550100'] });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/internal/ai-calls/availability`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers['content-type']).toBeUndefined();
    const verdict = verifyInternalRequest(
      SECRET,
      { method: 'GET', path: '/internal/ai-calls/availability', body: '' },
      { timestamp: init.headers[INTERNAL_TIMESTAMP_HEADER], signature: init.headers[INTERNAL_SIGNATURE_HEADER] },
    );
    expect(verdict).toEqual({ ok: true });
  });

  it.each([
    ['a 503', fetchReturning(503, { error: 'internal_disabled' })],
    ['a body that does not parse', fetchReturning(200, { available: 'yes' })],
    ['not JSON', fetchReturning(200, 'nope')],
    ['a network error', vi.fn(async () => { throw new TypeError('fetch failed'); })],
  ])('6: %s is null', async (_label, f) => {
    expect(await client(f).availability()).toBeNull();
  });
});

describe('httpCtiClient.availability with the org (final review I-1)', () => {
  const ORG = REQ.orgId;
  it("sends ?orgId=<org> and signs path and query together, as cti-api verifies them over req.url, so the org's test phones come back", async () => {
    const f = fetchReturning(200, { available: true, testNumbers: ['+15125550100', '+16195550142'] });
    expect(await client(f).availability(ORG)).toEqual({ available: true, testNumbers: ['+15125550100', '+16195550142'] });
    const [url, init] = f.mock.calls[0]!;
    const path = `/internal/ai-calls/availability?orgId=${ORG}`;
    expect(url).toBe(`${BASE}${path}`);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const signed = { timestamp: init.headers[INTERNAL_TIMESTAMP_HEADER], signature: init.headers[INTERNAL_SIGNATURE_HEADER] };
    expect(verifyInternalRequest(SECRET, { method: 'GET', path, body: '' }, signed)).toEqual({ ok: true });
    // A signature over the bare path would not cover the org (cti-api refuses it).
    expect(verifyInternalRequest(SECRET, { method: 'GET', path: '/internal/ai-calls/availability', body: '' }, signed)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('encodes the org into the query', async () => {
    const f = fetchReturning(200, { available: true, testNumbers: [] });
    await client(f).availability('a b&c');
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/internal/ai-calls/availability?orgId=a%20b%26c`);
  });

  it('without an org: the bare path, exactly as before', async () => {
    const f = fetchReturning(200, { available: true, testNumbers: [] });
    await client(f).availability();
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/internal/ai-calls/availability`);
  });
});

describe('httpCtiClient.availability, plan 1E', () => {
  it('passes browserCalls through (absent from an older cti-api)', async () => {
    expect(await client(fetchReturning(200, { available: true, testNumbers: [], browserCalls: true })).availability()).toEqual({ available: true, testNumbers: [], browserCalls: true });
    expect(await client(fetchReturning(200, { available: true, testNumbers: [] })).availability()).not.toHaveProperty('browserCalls');
  });
});

describe('httpCtiClient.browserToken (plan 1E)', () => {
  const TOKEN_REQ = { orgId: REQ.orgId, userId: REQ.userId };
  const IDENTITY = `aitest_${REQ.userId.replace(/-/g, '')}_a1b2c3d4e5f6`;
  const MINTED = { token: 'eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl', identity: IDENTITY, expiresAt: '2026-10-06T18:20:00.000Z' };

  it('12: a 200 is the token', async () => {
    expect(await client(fetchReturning(200, MINTED)).browserToken(TOKEN_REQ)).toEqual({ kind: 'token', ...MINTED });
  });

  it.each([
    [403, 'not_admin'],
    [403, 'unknown_user'],
    [503, 'browser_calls_unavailable'],
  ] as const)('13: HTTP %i %s is refused with that code', async (status, code) => {
    expect(await client(fetchReturning(status, { error: code })).browserToken(TOKEN_REQ)).toEqual({ kind: 'refused', code });
  });

  it.each([
    ['a 503 with another error', fetchReturning(503, { error: 'internal_disabled' }), 'HTTP 503 internal_disabled'],
    ['a 200 that is not a token', fetchReturning(200, { token: 'x', identity: 'rep_abc', expiresAt: 'x' }), 'bad_response'],
    ['a refused connection', vi.fn(async () => { throw new TypeError('fetch failed'); }), 'network'],
  ])('14: %s is transport', async (_label, f, error) => {
    expect(await client(f).browserToken(TOKEN_REQ)).toEqual({ kind: 'transport', error });
  });

  it('14: a timeout is transport "timeout"', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await client(f).browserToken(TOKEN_REQ)).toEqual({ kind: 'transport', error: 'timeout' });
  });

  it('15: POSTs { orgId, userId } to the token path, signed over that body', async () => {
    const f = fetchReturning(200, MINTED);
    await client(f).browserToken(TOKEN_REQ);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/internal/ai-calls/browser-token`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(TOKEN_REQ));
    const verdict = verifyInternalRequest(
      SECRET,
      { method: 'POST', path: '/internal/ai-calls/browser-token', body: JSON.stringify(TOKEN_REQ) },
      { timestamp: init.headers[INTERNAL_TIMESTAMP_HEADER], signature: init.headers[INTERNAL_SIGNATURE_HEADER] },
    );
    expect(verdict).toEqual({ ok: true });
  });
});

describe('httpCtiClient.checkPrompt (editable agent prompts)', () => {
  const CHECK_REQ = { kind: 'voicemail', template: 'Hi {{sellerFirstName}}, call us back.' } as const;
  const CHECKED: AgentPromptCheck = {
    defaultTemplate: 'Hi {{sellerFirstName}}.',
    placeholders: [{ name: 'sellerFirstName', kind: 'text', description: 'The seller first name' }],
    rendered: 'Hi Sam, call us back.',
    problems: [],
  };

  it('a 200 is the check; the request is a signed POST of the exact body to the prompt-check path', async () => {
    const f = fetchReturning(200, CHECKED);
    expect(await client(f).checkPrompt(CHECK_REQ)).toEqual({ kind: 'check', check: CHECKED });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(INTERNAL_AI_PROMPT_CHECK_PATH).toBe('/internal/ai-calls/prompt-check');
    expect(url).toBe(`${BASE}${INTERNAL_AI_PROMPT_CHECK_PATH}`);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify(CHECK_REQ));
    const verdict = verifyInternalRequest(
      SECRET,
      { method: 'POST', path: INTERNAL_AI_PROMPT_CHECK_PATH, body: JSON.stringify(CHECK_REQ) },
      { timestamp: init.headers[INTERNAL_TIMESTAMP_HEADER], signature: init.headers[INTERNAL_SIGNATURE_HEADER] },
    );
    expect(verdict).toEqual({ ok: true });
  });

  it('a check that found problems (rendered null) is still a check, not a transport error', async () => {
    const refused = { ...CHECKED, rendered: null, problems: ['{{nope}} is not a placeholder.'] };
    expect(await client(fetchReturning(200, refused)).checkPrompt(CHECK_REQ)).toEqual({ kind: 'check', check: refused });
  });

  it('a null template (the built-in default) is sent as null', async () => {
    const f = fetchReturning(200, { ...CHECKED, problems: [] });
    await client(f).checkPrompt({ kind: 'instructions', template: null });
    expect(f.mock.calls[0]![1].body).toBe(JSON.stringify({ kind: 'instructions', template: null }));
  });

  it.each([
    ['a body that is not a check', fetchReturning(200, { rendered: 'x' })],
    ['problems that are not strings', fetchReturning(200, { ...CHECKED, problems: [1] })],
    ['not JSON', fetchReturning(200, '<html>oops</html>')],
  ])('a 200 with %s is a transport error bad_response', async (_label, f) => {
    expect(await client(f).checkPrompt(CHECK_REQ)).toEqual({ kind: 'transport', error: 'bad_response' });
  });

  it.each([
    [401, { error: 'bad_signature' }, 'HTTP 401 bad_signature'],
    [503, { error: 'internal_disabled' }, 'HTTP 503 internal_disabled'],
    [500, 'not json', 'HTTP 500'],
  ])('HTTP %i is a transport error naming the status and the body error', async (status, body, error) => {
    expect(await client(fetchReturning(status, body)).checkPrompt(CHECK_REQ)).toEqual({ kind: 'transport', error });
  });

  it('never throws and never puts the template in the error: network failure is "network", a timeout is "timeout"', async () => {
    const network = vi.fn(async () => {
      throw new TypeError(`fetch failed for ${CHECK_REQ.template}`);
    });
    expect(await client(network).checkPrompt(CHECK_REQ)).toEqual({ kind: 'transport', error: 'network' });
    const timeout = vi.fn(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await client(timeout).checkPrompt(CHECK_REQ)).toEqual({ kind: 'transport', error: 'timeout' });
  });

  it('gives up after 5 seconds, not the 20 the call trigger waits', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    await client(fetchReturning(200, CHECKED)).checkPrompt(CHECK_REQ);
    expect(timeout).toHaveBeenCalledWith(PROMPT_CHECK_TIMEOUT_MS);
    expect(PROMPT_CHECK_TIMEOUT_MS).toBe(5_000);
    timeout.mockRestore();
  });
});

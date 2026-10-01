/**
 * Route-level (app.inject) tests for the two Twilio webhook wirings the final
 * whole-branch review flagged as untested at this level (M7): the recording
 * route's signature gate over the FULL URL including its query string (the
 * "Twilio signs the full URL incl. query string" gotcha from memory), and the
 * dialer-status route's try/finally — the connect hang-up stamp must run even
 * when onDialerStatus throws. The pure handlers themselves (onDialerRecording,
 * endConnectOnTerminalStatus, onDialerStatus) are exhaustively covered in
 * dialer-webhook.test.ts; this file proves the ROUTE wiring around them.
 *
 * Harness: real Fastify + registerDialerRoutes, and the REAL Twilio provider
 * (telephony/twilio.js via telephony/index.js) so `twilio.validateRequest` /
 * `getExpectedTwilioSignature` exercise the actual signing math — only
 * config, the DB, the connect-log writes, and the engine's outcome handler
 * are mocked (same convention as routes/dialer.test.ts and
 * telephony/webhooks.test.ts). Twilio posts application/x-www-form-urlencoded;
 * app.inject needs a REAL raw body for the signature to validate — the same
 * content-type-parser mirror routes/inbound.test.ts uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import twilio from 'twilio';

const TOKEN = `test-auth-token-${'x'.repeat(16)}`;
const API = 'https://api.test';

const state = vi.hoisted(() => ({
  cfg: {
    API_PUBLIC_URL: 'https://api.test',
    TELEPHONY_PROVIDER: 'twilio' as const,
    TWILIO_AUTH_TOKEN: `test-auth-token-${'x'.repeat(16)}`,
    TWILIO_SKIP_SIGNATURE_CHECK: false,
  },
  stampConnectEnded: vi.fn((..._args: unknown[]) => Promise.resolve([] as unknown[])),
  storeConnectRecording: vi.fn((..._args: unknown[]) => Promise.resolve([{ id: 'row-1' }] as unknown[])),
  handleDialOutcomeThrows: false,
}));

vi.mock('../config.js', () => ({ loadConfig: () => state.cfg }));

vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => null,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => ({}) };
});

// Only the writes matter here — the route's own wiring (signature, query
// parsing, the try/finally), not connect-log.ts's SQL (pinned elsewhere).
vi.mock('../dialer/connect-log.js', () => ({
  stampConnectEnded: (...args: unknown[]) => state.stampConnectEnded(...args),
  storeConnectRecording: (...args: unknown[]) => state.storeConnectRecording(...args),
}));

vi.mock('../dialer/live-deps.js', () => ({
  buildEngineDeps: () => ({}) as never,
}));

// Everything else in engine.js stays real; only the outcome handler is
// swapped so the dialer-status test can make it throw on demand (mirrors
// routes/dialer.test.ts's partial mock of the same module).
vi.mock('../dialer/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/engine.js')>()),
  handleDialOutcome: async (..._args: unknown[]) => {
    if (state.handleDialOutcomeThrows) throw new Error('boom');
  },
}));

import { registerDialerRoutes } from './dialer.js';

/** Twilio posts application/x-www-form-urlencoded; app.inject serializes an
 *  object payload as JSON regardless of content-type, so encode for real
 *  (same helper as routes/inbound.test.ts). */
function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

let app: FastifyInstance;
beforeEach(async () => {
  state.cfg = {
    API_PUBLIC_URL: API,
    TELEPHONY_PROVIDER: 'twilio',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_SKIP_SIGNATURE_CHECK: false,
  };
  state.stampConnectEnded.mockClear();
  state.storeConnectRecording.mockClear();
  state.handleDialOutcomeThrows = false;
  app = Fastify();
  // Mirrors server.ts's raw-body capturing parser (routes/inbound.test.ts):
  // the routes read `req.rawBody` for webhook signature validation.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as unknown as { rawBody?: string }).rawBody = body as string;
      const parsed: Record<string, string> = {};
      new URLSearchParams(body as string).forEach((v, k) => {
        parsed[k] = v;
      });
      done(null, parsed);
    },
  );
  await registerDialerRoutes(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe('POST /telephony/twilio/dialer-recording — signature over the FULL URL incl. the query string', () => {
  const CONNECT = '11111111-2222-4333-8444-555555555555';
  const SID = `CA${'a'.repeat(32)}`;
  const MEDIA = 'https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/RE123';
  const path = `/telephony/twilio/dialer-recording?connectId=${CONNECT}`;
  const body = { CallSid: SID, RecordingStatus: 'completed', RecordingUrl: MEDIA };

  const post = (signature: string) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: form(body),
    });

  it('a bad signature is 403, and nothing is stored', async () => {
    const res = await post('not-even-close');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('<Reject/>');
    expect(state.storeConnectRecording).not.toHaveBeenCalled();
  });

  it('a signature computed over the full URL — including the query string — is accepted', async () => {
    const full = `${API}${path}`;
    const sig = twilio.getExpectedTwilioSignature(TOKEN, full, body);
    const res = await post(sig);
    expect(res.statusCode).toBe(200);
    expect(state.storeConnectRecording).toHaveBeenCalledWith(expect.anything(), CONNECT, SID, `${MEDIA}.mp3`, expect.any(Date));
  });

  // The regression this route exists to prevent (webhooks.test.ts pins the
  // same gotcha at the signedCallbackUrl level): a signature computed WITHOUT
  // the query string — what the bug used to validate against — must still
  // 403, never silently accept a mis-signed request.
  it('a signature computed WITHOUT the query string (the original bug) is rejected', async () => {
    const withoutQuery = `${API}/telephony/twilio/dialer-recording`;
    const sig = twilio.getExpectedTwilioSignature(TOKEN, withoutQuery, body);
    const res = await post(sig);
    expect(res.statusCode).toBe(403);
    expect(state.storeConnectRecording).not.toHaveBeenCalled();
  });
});

describe('POST /telephony/twilio/dialer-status — the connect stamp runs even when onDialerStatus throws', () => {
  // `cfg` (including TWILIO_SKIP_SIGNATURE_CHECK) is captured ONCE by
  // registerDialerRoutes at registration time — a per-test override of
  // state.cfg after `beforeEach` has no effect, so these sign for real
  // instead, the same as the recording-route tests above.
  const statusUrl = '/telephony/twilio/dialer-status';
  const post = (fields: Record<string, string>) => {
    const payload = form(fields);
    const sig = twilio.getExpectedTwilioSignature(TOKEN, `${API}${statusUrl}`, fields);
    return app.inject({
      method: 'POST',
      url: statusUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
      payload,
    });
  };

  it("the hang-up stamp still runs in the route's finally", async () => {
    state.handleDialOutcomeThrows = true;
    const SID = `CA${'d'.repeat(32)}`;
    const res = await post({ CallSid: SID, CallStatus: 'completed' });
    // onDialerStatus's error propagates past the try/finally — there is no
    // catch at the route level (a separate, accepted follow-up: P2T6-1, no
    // global error handler for raw Error.message on /admin/* and friends).
    // What this test pins is that the finally's stamp still ran regardless.
    expect(res.statusCode).toBe(500);
    expect(state.stampConnectEnded).toHaveBeenCalledWith(expect.anything(), SID, expect.any(Date));
  });

  it('the stamp also runs on the ordinary, non-throwing path', async () => {
    const SID = `CA${'e'.repeat(32)}`;
    const res = await post({ CallSid: SID, CallStatus: 'busy' });
    expect(res.statusCode).toBe(200);
    expect(state.stampConnectEnded).toHaveBeenCalledWith(expect.anything(), SID, expect.any(Date));
  });
});

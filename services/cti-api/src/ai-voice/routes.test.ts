/**
 * Route-level (app.inject) tests for the AI voice REST routes and Twilio
 * webhooks: auth, validation, signature gates, and the happy paths, with the
 * store / Twilio / gate / Salesforce faked (testing.ts). Harness mirrors
 * routes/dialer-webhook-routes.test.ts: real Fastify, server.ts's raw-body
 * urlencoded parser, the REAL Twilio provider for signature math, and mocks
 * of ../config.js, @cti/auth and @cti/db.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import twilio from 'twilio';

const TOKEN = `test-auth-token-${'x'.repeat(16)}`;
const API = 'https://api.test';

const state = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  sessions: new Map<string, Record<string, unknown>>(),
  lookups: 0,
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: () => state.cfg,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async (h: string | undefined) => {
    state.lookups += 1;
    return h ? state.sessions.get(h) ?? null : null;
  },
}));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => ({}),
}));

import { registerAiVoiceRoutes } from './routes.js';
import { claimClose, clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import { activeEntry, CALL_SID, fakeStore, fakeTwilio, type FakeStore, type FakeTwilio } from './testing.js';
import type { AiGateResult } from './gate.js';
import { defaultToolEffects, type ToolCtx } from './service-tools.js';

const ORG = 'oooooooo-0000-4000-8000-000000000001';
const REP = 'aaaaaaaa-0000-4000-8000-000000000001';
const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000002';
const ID = '11111111-2222-4333-8444-555555555555';
const REP_AUTH = 'Bearer rep';
const ADMIN_AUTH = 'Bearer admin';
const NOW = new Date('2026-10-05T18:00:00Z');

let app: FastifyInstance;
let store: FakeStore;
let tw: FakeTwilio;
let gateResult: AiGateResult;
let afterCall: ReturnType<typeof vi.fn>;
let transferFailed: ReturnType<typeof vi.fn>;
let bridge: { start: ReturnType<typeof vi.fn>; silence: ReturnType<typeof vi.fn>; waitForPlayback: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

async function build(withRateLimit = false) {
  app = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    const parsed: Record<string, string> = {};
    new URLSearchParams(body as string).forEach((v, k) => {
      parsed[k] = v;
    });
    done(null, parsed);
  });
  if (withRateLimit) await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await registerAiVoiceRoutes(app, {
    store,
    twilio: tw,
    loadRecord: async () => ({
      objectType: 'Lead',
      recordId: '00Q5e00000AbCdEFGH',
      name: 'Jane Doe',
      firstName: 'Jane',
      phones: ['+16195550100'],
      consentAiCall: true,
      consentFieldMissing: false,
      address: null,
      notes: '',
      ownerSfUserId: null,
    }),
    gate: async () => gateResult,
    now: () => NOW,
    afterCall: (row) => afterCall(row),
    effects: { ...defaultToolEffects, transferFailed: (ctx, info) => transferFailed(ctx, info) },
  });
  await app.ready();
}

beforeEach(async () => {
  state.cfg = {
    API_PUBLIC_URL: API,
    TELEPHONY_PROVIDER: 'twilio',
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_SKIP_SIGNATURE_CHECK: false,
    SESSION_SECRET: 's'.repeat(40),
    OPENAI_API_KEY: 'sk-test',
    AI_VOICE: 'on',
    OUTREACH_KILL_SWITCH: 'off',
    AI_VOICE_TEST_NUMBERS: '+16195550199',
    AI_VOICE_AGENT_NAME: 'Alex',
    AI_VOICE_MAX_CALL_SECONDS: 600,
    AI_VOICE_MODEL: 'gpt-realtime-2.1',
    AI_VOICE_VOICE: 'marin',
    AI_VOICE_REASONING: 'low',
    AI_VOICE_VAD_EAGERNESS: 'auto',
  };
  const base = { orgId: ORG, email: 'x@example.com', powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
  state.sessions = new Map([
    [REP_AUTH, { ...base, userId: REP, isAdmin: false }],
    [ADMIN_AUTH, { ...base, userId: ADMIN, isAdmin: true }],
  ]);
  store = fakeStore();
  tw = fakeTwilio();
  gateResult = { ok: true, toE164: '+16195550100', fromE164: '+16195550000' };
  bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(async () => {}), stop: vi.fn() };
  afterCall = vi.fn(async () => {});
  transferFailed = vi.fn(async (ctx: ToolCtx, info: { finalized: boolean }) => defaultToolEffects.transferFailed(ctx, info));
  await build();
});
afterEach(async () => {
  clearActiveCalls();
  await app.close();
});

const form = (p: Record<string, string>) => new URLSearchParams(p).toString();

function signedPost(path: string, body: Record<string, string>, signature?: string) {
  return app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signature ?? twilio.getExpectedTwilioSignature(TOKEN, `${API}${path}`, body),
    },
    payload: form(body),
  });
}

async function liveCall(status = 'in_progress', over: Parameters<typeof activeEntry>[0] = {}) {
  await store.insert({ id: ID, orgId: ORG, startedBy: REP, toE164: '+16195550100', fromE164: '+16195550000', status, callSid: CALL_SID });
  registerActiveCall(activeEntry({ aiCallId: ID, orgId: ORG, callSid: CALL_SID, bridge, ...over }));
}

describe('the softphone-only AI call routes are gone (plan 1C: campaigns start calls through the internal trigger)', () => {
  it.each([
    ['POST', '/ai-calls', { testTo: '+16195550199' }],
    ['GET', '/ai-calls', undefined],
    ['GET', `/ai-calls/${ID}`, undefined],
    ['GET', '/ai-calls/availability', undefined],
  ] as const)('%s %s answers 404 even for a signed-in admin', async (method, url, payload) => {
    const res = await app.inject({ method, url, headers: { authorization: ADMIN_AUTH }, ...(payload ? { payload } : {}) });
    expect(res.statusCode).toBe(404);
  });

  it('the internal trigger is still registered: an unsigned POST /internal/ai-calls is 401 bad_signature, not 404', async () => {
    state.cfg = { ...state.cfg, OUTREACH_INTERNAL_SECRET: 'k'.repeat(40) };
    const res = await app.inject({ method: 'POST', url: '/internal/ai-calls', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'bad_signature' });
  });

  it('and its availability route answers 401 unsigned, 503 internal_disabled with no secret (outside production)', async () => {
    state.cfg = { ...state.cfg, OUTREACH_INTERNAL_SECRET: 'k'.repeat(40) };
    expect((await app.inject({ method: 'GET', url: '/internal/ai-calls/availability' })).statusCode).toBe(401);
    state.cfg = { ...state.cfg, OUTREACH_INTERNAL_SECRET: undefined };
    const off = await app.inject({ method: 'GET', url: '/internal/ai-calls/availability' });
    expect(off.statusCode).toBe(503);
    expect(off.json()).toEqual({ error: 'internal_disabled' });
  });
});

describe('POST /telephony/twilio/ai-voice/amd', () => {
  const path = `/telephony/twilio/ai-voice/amd?aiCallId=${ID}`;

  it('403 on a bad signature', async () => {
    await liveCall();
    const res = await signedPost(path, { CallSid: CALL_SID, AnsweredBy: 'machine_end_beep' }, 'nope');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('<Reject/>');
    expect(tw.redirects).toHaveLength(0);
  });

  it('a machine after the beep: silence the agent, leave the voicemail, outcome voicemail', async () => {
    await liveCall();
    const res = await signedPost(path, { CallSid: CALL_SID, AnsweredBy: 'machine_end_beep' });
    expect(res.statusCode).toBe(200);
    expect(bridge.silence).toHaveBeenCalled();
    expect(tw.redirects).toHaveLength(1);
    expect(tw.redirects[0]!.twiml).toContain('<Pause length="1"/><Say voice="Polly.Joanna-Neural">Hi Jane, this is Alex, an AI assistant calling for GG Homes');
    expect(tw.redirects[0]!.twiml).toContain('You can reach us at 619-555-0000.');
    expect(store.rows.get(ID)).toMatchObject({ answeredBy: 'machine_end_beep', outcome: 'voicemail' });
  });

  it('no voicemail if a tool already owns the end of the call', async () => {
    await liveCall();
    claimClose(ID);
    await signedPost(path, { CallSid: CALL_SID, AnsweredBy: 'machine_end_silence' });
    expect(tw.redirects).toHaveLength(0);
    expect(store.rows.get(ID)?.answeredBy).toBe('machine_end_silence');
  });

  it('a fax is hung up', async () => {
    await liveCall();
    await signedPost(path, { CallSid: CALL_SID, AnsweredBy: 'fax' });
    expect(tw.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)?.outcome).toBe('wrong_number');
    expect(store.optOuts).toEqual([{ orgId: ORG, e164: '+16195550100', note: 'fax' }]);
  });

  it('a human only records answered_by', async () => {
    await liveCall();
    await signedPost(path, { CallSid: CALL_SID, AnsweredBy: 'human' });
    expect(tw.redirects).toHaveLength(0);
    expect(tw.hangups).toHaveLength(0);
    expect(store.rows.get(ID)?.answeredBy).toBe('human');
  });

  it('a callback for another call sid is rejected (403) and changes nothing', async () => {
    await liveCall();
    const res = await signedPost(path, { CallSid: `CA${'f'.repeat(32)}`, AnsweredBy: 'machine_end_beep' });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('<Reject/>');
    expect(tw.redirects).toHaveLength(0);
    expect(store.rows.get(ID)?.answeredBy).toBeNull();
  });
});

describe('Twilio AI-voice callbacks must carry the call sid', () => {
  const OTHER = `CA${'f'.repeat(32)}`;
  const cases = [
    ['amd', { AnsweredBy: 'machine_end_beep' }],
    ['status', { CallStatus: 'completed', CallDuration: '30' }],
    ['transfer-result', { DialCallStatus: 'no-answer' }],
  ] as const;

  for (const [name, body] of cases) {
    const path = `/telephony/twilio/ai-voice/${name}?aiCallId=${ID}`;

    it(`${name}: 400 without a CallSid, and nothing changes`, async () => {
      await liveCall('in_progress');
      await store.update(ID, { outcome: 'qualified_transferred' });
      const before = { ...store.rows.get(ID) };
      const res = await signedPost(path, body);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('<Reject/>');
      expect(store.rows.get(ID)).toEqual(before);
      expect(tw.redirects).toHaveLength(0);
      expect(transferFailed).not.toHaveBeenCalled();
    });

    it(`${name}: 403 for another call's sid, and nothing changes`, async () => {
      await liveCall('in_progress');
      await store.update(ID, { outcome: 'qualified_transferred' });
      const before = { ...store.rows.get(ID) };
      const res = await signedPost(path, { CallSid: OTHER, ...body });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('<Reject/>');
      expect(store.rows.get(ID)).toEqual(before);
      expect(transferFailed).not.toHaveBeenCalled();
    });
  }
});

describe('POST /telephony/twilio/ai-voice/status', () => {
  const path = `/telephony/twilio/ai-voice/status?aiCallId=${ID}`;

  it('403 on a bad signature', async () => {
    await liveCall('ringing');
    expect((await signedPost(path, { CallSid: CALL_SID, CallStatus: 'completed' }, 'bad')).statusCode).toBe(403);
    expect(store.rows.get(ID)?.endedAt).toBeNull();
  });

  it('in-progress moves a ringing row on; a later ringing never moves it back', async () => {
    await liveCall('ringing');
    await signedPost(path, { CallSid: CALL_SID, CallStatus: 'in-progress' });
    expect(store.rows.get(ID)?.status).toBe('in_progress');
    await signedPost(path, { CallSid: CALL_SID, CallStatus: 'ringing' });
    expect(store.rows.get(ID)?.status).toBe('in_progress');
  });

  it('a terminal status finalizes once (idempotent) and tears down the live call', async () => {
    await liveCall('ringing');
    const body = { CallSid: CALL_SID, CallStatus: 'no-answer', CallDuration: '0' };
    expect((await signedPost(path, body)).statusCode).toBe(200);
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'no_answer', durationSeconds: 0, endedAt: NOW });
    expect(getActiveCall(ID)).toBeNull();
    expect(bridge.stop).toHaveBeenCalled();
    await signedPost(path, { ...body, CallStatus: 'completed', CallDuration: '9' });
    expect(store.rows.get(ID)).toMatchObject({ outcome: 'no_answer', durationSeconds: 0 });
  });

  it('replies at once and leaves the summary / Salesforce work running behind it', async () => {
    await liveCall('in_progress');
    afterCall = vi.fn(() => new Promise<void>(() => {})); // never finishes
    const res = await signedPost(path, { CallSid: CALL_SID, CallStatus: 'completed', CallDuration: '30' });
    expect(res.statusCode).toBe(200);
    expect(afterCall).toHaveBeenCalledTimes(1);
    expect(store.ctiCalls.size).toBe(1);
    expect(store.rows.get(ID)?.ctiCallId).toBeTruthy();
  });

  it('stores the CallSid from the callback when the row never got one', async () => {
    await store.insert({ id: ID, orgId: ORG, startedBy: REP, toE164: '+16195550100', fromE164: '+16195550000', status: 'queued' });
    await signedPost(path, { CallSid: CALL_SID, CallStatus: 'ringing' });
    expect(store.rows.get(ID)).toMatchObject({ callSid: CALL_SID, status: 'ringing' });
  });

  it('a skip-signature dev flag lets an unsigned callback through', async () => {
    state.cfg = { ...state.cfg, TWILIO_SKIP_SIGNATURE_CHECK: true };
    await liveCall('ringing');
    expect((await signedPost(path, { CallSid: CALL_SID, CallStatus: 'in-progress' }, 'unsigned')).statusCode).toBe(200);
  });
});

describe('POST /telephony/twilio/ai-voice/transfer-result', () => {
  const path = `/telephony/twilio/ai-voice/transfer-result?aiCallId=${ID}`;

  it('403 on a bad signature', async () => {
    await liveCall('transferring');
    const res = await signedPost(path, { CallSid: CALL_SID, DialCallStatus: 'no-answer' }, 'bad');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('<Reject/>');
  });

  it('the rep answered: hang up when they are done, status transferred, outcome stays qualified_transferred', async () => {
    await liveCall('transferring');
    await store.update(ID, { outcome: 'qualified_transferred' });
    const res = await signedPost(path, { CallSid: CALL_SID, DialCallStatus: 'completed' });
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Response><Hangup/></Response>');
    expect(store.rows.get(ID)).toMatchObject({ status: 'transferred', outcome: 'qualified_transferred' });
  });

  it('a late "completed" (the status callback finalized first) still upgrades the row to transferred', async () => {
    await liveCall('transferring');
    await store.update(ID, { outcome: 'qualified_transferred' });
    await signedPost(`/telephony/twilio/ai-voice/status?aiCallId=${ID}`, { CallSid: CALL_SID, CallStatus: 'completed', CallDuration: '300' });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'qualified_transferred' });
    await signedPost(path, { CallSid: CALL_SID, DialCallStatus: 'completed' });
    expect(store.rows.get(ID)?.status).toBe('transferred');
  });

  it('a late "no-answer" after finalize: transfer_failed, and the effect is told the call is finalized', async () => {
    await liveCall('transferring');
    await store.update(ID, { outcome: 'qualified_transferred' });
    await signedPost(`/telephony/twilio/ai-voice/status?aiCallId=${ID}`, { CallSid: CALL_SID, CallStatus: 'completed', CallDuration: '40' });
    await signedPost(path, { CallSid: CALL_SID, DialCallStatus: 'no-answer' });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'transfer_failed' });
    expect(transferFailed).toHaveBeenCalledWith(expect.objectContaining({ aiCallId: ID }), { finalized: true });
  });

  it('no rep: the caller hears the callback promise, outcome transfer_failed, a callback is requested', async () => {
    await liveCall('transferring');
    await store.update(ID, { outcome: 'qualified_transferred' });
    const res = await signedPost(path, { CallSid: CALL_SID, DialCallStatus: 'no-answer' });
    expect(res.body).toContain("they'll call you right back");
    expect(res.body).toContain('<Hangup/>');
    expect(store.rows.get(ID)?.outcome).toBe('transfer_failed');
    expect(store.rows.get(ID)?.summary).toContain('call them back');
    expect(transferFailed).toHaveBeenCalledWith(expect.objectContaining({ aiCallId: ID }), { finalized: false });
    expect(store.rows.get(ID)?.status).toBe('transferring');
  });

  it('an unknown call still gets valid TwiML that ends the call', async () => {
    const res = await signedPost(path, { CallSid: CALL_SID, DialCallStatus: 'no-answer' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Hangup/>');
  });
});

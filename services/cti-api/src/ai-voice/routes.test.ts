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

describe('POST /ai-calls', () => {
  const post = (payload: unknown, auth = REP_AUTH) =>
    app.inject({ method: 'POST', url: '/ai-calls', headers: { authorization: auth }, payload: payload as object });

  it('401 without a session', async () => {
    expect((await post({ testTo: '+16195550199' }, '')).statusCode).toBe(401);
  });

  it('400 for a body that is neither a record nor a test number', async () => {
    expect((await post({ objectType: 'Account', recordId: '001000000000001' })).statusCode).toBe(400);
    expect((await post({ objectType: 'Lead', recordId: 'bad id!' })).statusCode).toBe(400);
    expect((await post({})).statusCode).toBe(400);
  });

  it('201 with the call id when the call is placed', async () => {
    const res = await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { aiCallId: string; status: string };
    expect(body.status).toBe('ringing');
    expect(store.rows.get(body.aiCallId)?.callSid).toBe(CALL_SID);
    expect(tw.placed).toHaveLength(1);
  });

  it('409 with the block reason and the row id when the gate refuses', async () => {
    gateResult = { ok: false, reason: 'no_consent' };
    const res = await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'no_consent', aiCallId: expect.any(String) });
    expect(tw.placed).toHaveLength(0);
  });

  it('502 twilio_error when Twilio refuses', async () => {
    tw.failPlace = true;
    const res = await post({ testTo: '+16195550199' }, ADMIN_AUTH);
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'twilio_error' });
  });

  it('rate limits a user to 10 starts a minute', async () => {
    await app.close();
    await build(true);
    gateResult = { ok: false, reason: 'no_consent' };
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) codes.push((await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 409)).toBe(true);
    expect(codes[10]).toBe(429);
    // Another user has their own bucket.
    expect((await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, ADMIN_AUTH)).statusCode).toBe(409);
  });

  it('the bucket is the signed-in user, not the bearer token, and the session is looked up once per request', async () => {
    await app.close();
    await build(true);
    gateResult = { ok: false, reason: 'no_consent' };
    state.sessions.set('Bearer rep-second-device', { ...state.sessions.get(REP_AUTH)! });
    for (let i = 0; i < 10; i += 1) await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' });
    state.lookups = 0;
    expect((await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, 'Bearer rep-second-device')).statusCode).toBe(429);
    expect(state.lookups).toBe(1);
    state.lookups = 0;
    expect((await post({ objectType: 'Lead', recordId: '00Q5e00000AbCdEFGH' }, ADMIN_AUTH)).statusCode).toBe(409);
    expect(state.lookups).toBe(1);
  });
});

describe('GET /ai-calls, /ai-calls/:id, /ai-calls/availability', () => {
  beforeEach(async () => {
    await store.insert({ id: ID, orgId: ORG, startedBy: REP, toE164: '+16195550100', status: 'completed', transcript: [{ role: 'agent', text: 'Hi', at: 'x' }] });
    await store.insert({ orgId: ORG, startedBy: ADMIN, toE164: '+16195550101', status: 'completed' });
    await store.insert({ orgId: 'other-org', startedBy: 'someone', toE164: '+16195550102', status: 'completed' });
  });
  const get = (url: string, auth = REP_AUTH) => app.inject({ method: 'GET', url, headers: { authorization: auth } });

  it('401 without a session', async () => {
    expect((await get('/ai-calls', '')).statusCode).toBe(401);
    expect((await get(`/ai-calls/${ID}`, '')).statusCode).toBe(401);
    expect((await get('/ai-calls/availability', '')).statusCode).toBe(401);
  });

  it('a rep lists their own calls; an admin lists the org', async () => {
    expect((await get('/ai-calls')).json().aiCalls).toHaveLength(1);
    expect((await get('/ai-calls', ADMIN_AUTH)).json().aiCalls).toHaveLength(2);
  });

  it('400 for a bad limit', async () => {
    expect((await get('/ai-calls?limit=0')).statusCode).toBe(400);
    expect((await get('/ai-calls?limit=500')).statusCode).toBe(400);
  });

  it('one call in the same org, with its transcript; 404 otherwise', async () => {
    const res = await get(`/ai-calls/${ID}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: ID, transcript: [{ role: 'agent', text: 'Hi' }] });
    expect((await get('/ai-calls/22222222-2222-4333-8444-555555555555')).statusCode).toBe(404);
    expect((await get('/ai-calls/not-a-uuid')).statusCode).toBe(404);
  });

  it('a rep reads only calls they started or were handed; an admin reads any in the org', async () => {
    const theirs = '33333333-2222-4333-8444-555555555555';
    const handed = '44444444-2222-4333-8444-555555555555';
    await store.insert({ id: theirs, orgId: ORG, startedBy: ADMIN, toE164: '+16195550103', status: 'completed' });
    await store.insert({ id: handed, orgId: ORG, startedBy: ADMIN, handoffUserId: REP, toE164: '+16195550104', status: 'completed' });
    const res = await get(`/ai-calls/${theirs}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
    expect((await get(`/ai-calls/${handed}`)).statusCode).toBe(200);
    expect((await get(`/ai-calls/${theirs}`, ADMIN_AUTH)).statusCode).toBe(200);
  });

  it('availability shows test numbers to admins only', async () => {
    expect((await get('/ai-calls/availability')).json()).toEqual({ available: true, testNumbers: [] });
    expect((await get('/ai-calls/availability', ADMIN_AUTH)).json()).toEqual({ available: true, testNumbers: ['+16195550199'] });
    state.cfg = { ...state.cfg, AI_VOICE: 'off' };
    expect((await get('/ai-calls/availability')).json().available).toBe(false);
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

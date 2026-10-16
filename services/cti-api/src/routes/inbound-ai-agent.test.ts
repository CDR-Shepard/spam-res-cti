/**
 * Inbound agent testing (plan 2026-10-16): a phone on the org's test-phones list calling an AI-pool number gets the AI
 * agent (`<Connect><Stream>`), with no `calls` row and no Salesforce work. Every other caller keeps today's routing
 * byte for byte (rep ring or voicemail), as does everyone when the switch is off, AI voice is unavailable, the caller
 * is anonymous, or the list lookup fails. The TwiML literals below were captured from the route before the branch
 * existed. Harness: inbound-ai-pool.test.ts (Fastify + fake DB by table, form-encoded body).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const AI_DID = '+16197244374';
const CALLER = '+13105550002';
const AI_CALL_ID = '44444444-2222-4333-8444-555555555555';
const ADMIN = '22222222-2222-4333-8444-555555555555';

const state = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  owned: null as Record<string, unknown> | null,
  aiRep: null as string | null,
  aiCallbackRep: vi.fn(),
  findTestPhone: vi.fn(),
  findByPhone: vi.fn(async () => null),
  enqueueSyncForCall: vi.fn(async () => {}),
  callValues: [] as Record<string, unknown>[],
  aiCallValues: [] as Record<string, unknown>[],
}));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  // The route reads its config once, at registration: a live view lets a test switch a setting afterwards.
  loadConfig: () => new Proxy({}, { get: (_target, key) => state.cfg[key as string] }),
}));
vi.mock('../salesforce/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../salesforce/client.js')>()),
  findByPhone: state.findByPhone,
  findPrimaryOpenOpportunityId: async () => null,
}));
vi.mock('../salesforce/sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../salesforce/sync.js')>()),
  enqueueSyncForCall: state.enqueueSyncForCall,
}));
vi.mock('../ai-voice/number-pool.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-voice/number-pool.js')>()),
  aiCallbackRep: state.aiCallbackRep,
}));
vi.mock('../ai-voice/test-phones.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-voice/test-phones.js')>()),
  findTestPhone: state.findTestPhone,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  /** A select chain: the inbound rows written so far for ai_calls (a replay's lookup), else no rows (saved prompts, org name). */
  const none = () => {
    let rows: unknown[] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ['where', 'orderBy', 'limit']) chain[m] = () => chain;
    chain.from = (table: unknown) => {
      if (table === actual.schema.aiCalls) rows = state.aiCallValues.map((v) => ({ id: AI_CALL_ID, endedAt: null, ...v }));
      return chain;
    };
    chain.then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return chain;
  };
  return {
    ...actual,
    getDb: () => ({
      query: {
        outboundNumbers: { findFirst: async () => state.owned },
        users: { findFirst: async () => ({ id: 'org-fallback', noAnswerForwardE164: null }) },
        salesforceConnections: { findFirst: async () => null },
        calls: { findFirst: async () => null },
      },
      select: none,
      selectDistinctOn: none,
      insert(table: unknown) {
        return {
          values(v: Record<string, unknown>) {
            // ai_calls_call_sid_unique, as Postgres enforces it.
            if (table === actual.schema.aiCalls && state.aiCallValues.some((r) => r.callSid === v.callSid)) {
              return { returning: async () => Promise.reject(new Error('duplicate key value violates unique constraint "ai_calls_call_sid_unique"')) };
            }
            if (table === actual.schema.calls) state.callValues.push(v);
            if (table === actual.schema.aiCalls) state.aiCallValues.push(v);
            const id = table === actual.schema.aiCalls ? AI_CALL_ID : 'call-db-1';
            const returning = async () => [{ id, ...v }];
            return { returning, onConflictDoNothing: () => ({ returning }) };
          },
        };
      },
      update: () => ({ set: () => ({ where: async () => {} }) }),
    }),
  };
});

import { clearActiveCalls, getActiveCall } from '../ai-voice/registry.js';
import { registerInboundRoutes } from './inbound.js';

const BASE_CFG = {
  API_PUBLIC_URL: 'https://api.example.com',
  TELEPHONY_PROVIDER: 'twilio',
  TWILIO_SKIP_SIGNATURE_CHECK: true,
  TWILIO_RECORD_CALLS: false,
  TWILIO_AUTH_TOKEN: undefined,
  SESSION_SECRET: 's'.repeat(40),
  OPENAI_API_KEY: 'sk-test',
  AI_VOICE: 'on',
  OUTREACH_KILL_SWITCH: 'off',
  AI_VOICE_INBOUND: 'on',
  AI_VOICE_AGENT_NAME: 'Sam',
  AI_VOICE_MAX_CALL_SECONDS: 600,
};
const OWNED = {
  id: 'num-ai', orgId: 'org-1', e164: AI_DID, provider: 'twilio', kind: 'ai_pool', inboundEnabled: true,
  inboundGreeting: null, inboundMatchedGreeting: null, inboundRecordSeconds: 60, inboundTranscribe: false,
  inboundForwardToE164: null, assignedUserId: null,
};

/** Today's TwiML (captured before the branch existed): the AI call's hand-off rep rings… */
const REP_RING_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="+13105550002" timeout="25" answerOnBridge="true" action="https://api.example.com/telephony/twilio/inbound/dial-result?callDbId=call-db-1" method="POST"><Client>rep_repowner</Client></Dial></Response>';
/** …or, with nobody to ring, voicemail with <Record>. */
const VOICEMAIL_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna">Hi, thanks for calling. We didn\'t recognize this number — please leave a brief message describing how we can help, and someone will reach out shortly.</Say><Record maxLength="60" playBeep="true" timeout="5" trim="trim-silence" recordingStatusCallback="https://api.example.com/telephony/twilio/inbound/recording?callDbId=call-db-1" recordingStatusCallbackEvent="completed" action="https://api.example.com/telephony/twilio/inbound/voicemail-done?callDbId=call-db-1" method="POST"/><Say voice="Polly.Joanna">Thanks, your message has been received. Goodbye.</Say><Hangup/></Response>';

let app: FastifyInstance;
let logs: Array<Record<string, unknown>>;

beforeEach(async () => {
  state.cfg = { ...BASE_CFG };
  state.owned = { ...OWNED };
  state.aiRep = null;
  state.aiCallbackRep.mockReset().mockImplementation(async () => state.aiRep);
  state.findTestPhone.mockReset().mockResolvedValue(null);
  state.findByPhone.mockClear();
  state.enqueueSyncForCall.mockClear();
  state.callValues = [];
  state.aiCallValues = [];
  logs = [];
  app = Fastify({ logger: { level: 'warn', stream: { write: (line: string) => void logs.push(JSON.parse(line)) } } });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  await registerInboundRoutes(app);
  await app.ready();
});
afterEach(async () => {
  clearActiveCalls();
  await app.close();
});

const ring = (from = CALLER) =>
  app.inject({
    method: 'POST',
    url: '/telephony/twilio/inbound',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ From: from, To: AI_DID, CallSid: `CA${'a'.repeat(32)}` }).toString(),
  });
const listed = () => state.findTestPhone.mockResolvedValue({ id: 'phone-1', addedBy: ADMIN, label: 'Evren' });
const notStarted = () => logs.filter((l) => l.msg === 'ai-voice: inbound test call not started');

describe('POST /telephony/twilio/inbound — a test phone calling an AI number', () => {
  it('gets the agent: <Connect><Stream>, an inbound ai_calls row, no calls row and no Salesforce work', async () => {
    listed();
    const res = await ring();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Connect><Stream url="wss://api.example.com/telephony/twilio/ai-voice/stream">');
    expect(res.body).toContain(`<Parameter name="aiCallId" value="${AI_CALL_ID}"/>`);
    expect(state.findTestPhone).toHaveBeenCalledWith(expect.anything(), 'org-1', CALLER);
    expect(state.aiCallValues).toEqual([expect.objectContaining({ direction: 'inbound', isTest: true, toE164: CALLER, fromE164: AI_DID, startedBy: ADMIN })]);
    expect(getActiveCall(AI_CALL_ID)?.direction).toBe('inbound');
    expect(state.callValues).toEqual([]);
    expect(state.findByPhone).not.toHaveBeenCalled();
    expect(state.enqueueSyncForCall).not.toHaveBeenCalled();
    // Real callback routing is never consulted for it.
    expect(state.aiCallbackRep).not.toHaveBeenCalled();
    expect(notStarted()).toEqual([]);
  });
});

describe('POST /telephony/twilio/inbound — a replayed webhook for a test call (final review M-3)', () => {
  it('the same CallSid again gets the same stream for the same row: no calls row, no Salesforce work, no second row', async () => {
    listed();
    const first = await ring();
    expect(first.body).toContain('<Connect><Stream');
    const again = await ring();
    expect(again.statusCode).toBe(200);
    expect(again.body).toBe(first.body);
    expect(state.aiCallValues).toHaveLength(1);
    expect(getActiveCall(AI_CALL_ID)?.direction).toBe('inbound');
    expect(state.callValues).toEqual([]);
    expect(state.findByPhone).not.toHaveBeenCalled();
    expect(state.enqueueSyncForCall).not.toHaveBeenCalled();
    expect(state.aiCallbackRep).not.toHaveBeenCalled();
    expect(notStarted()).toEqual([]);
  });
});

describe("POST /telephony/twilio/inbound — everyone else keeps today's routing, byte for byte", () => {
  it('a caller not on the list: the hand-off rep rings, with a calls row', async () => {
    state.aiRep = 'rep-owner';
    const res = await ring();
    expect(res.body).toBe(REP_RING_TWIML);
    expect(state.callValues).toHaveLength(1);
    expect(state.aiCallValues).toEqual([]);
    expect(notStarted()).toEqual([]);
  });

  it('a caller not on the list with nobody to ring: voicemail, with a calls row', async () => {
    const res = await ring();
    expect(res.body).toBe(VOICEMAIL_TWIML);
    expect(state.callValues).toHaveLength(1);
  });

  it('an anonymous caller: voicemail, no list lookup', async () => {
    listed();
    const res = await ring('anonymous');
    expect(res.body).toBe(VOICEMAIL_TWIML);
    expect(state.findTestPhone).not.toHaveBeenCalled();
    expect(state.callValues).toHaveLength(1);
    // It can never be on the list: nothing to warn about.
    expect(notStarted()).toEqual([]);
  });

  it('AI_VOICE_INBOUND=off: a listed phone rings the rep as today, no list lookup and no warning', async () => {
    listed();
    state.cfg = { ...BASE_CFG, AI_VOICE_INBOUND: 'off' };
    state.aiRep = 'rep-owner';
    const res = await ring();
    expect(res.body).toBe(REP_RING_TWIML);
    expect(state.findTestPhone).not.toHaveBeenCalled();
    expect(state.aiCallValues).toEqual([]);
    expect(notStarted()).toEqual([]);
  });

  it('AI voice unavailable: a listed phone gets voicemail as today, with a warning', async () => {
    listed();
    state.cfg = { ...BASE_CFG, OPENAI_API_KEY: undefined };
    const res = await ring();
    expect(res.body).toBe(VOICEMAIL_TWIML);
    expect(state.aiCallValues).toEqual([]);
    expect(notStarted()).toEqual([expect.objectContaining({ reason: 'ai_unavailable' })]);
  });

  it('AI voice unavailable: a caller not on the list gets voicemail as today, with no warning', async () => {
    state.cfg = { ...BASE_CFG, AI_VOICE: 'off' };
    const res = await ring();
    expect(res.body).toBe(VOICEMAIL_TWIML);
    expect(state.callValues).toHaveLength(1);
    expect(notStarted()).toEqual([]);
  });

  it('the list lookup throwing: today\'s routing and a warning with a code only', async () => {
    state.findTestPhone.mockRejectedValue(new Error(`timeout reading ${CALLER}`));
    const res = await ring();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(VOICEMAIL_TWIML);
    expect(state.callValues).toHaveLength(1);
    expect(notStarted()).toEqual([expect.objectContaining({ reason: 'lookup_failed' })]);
    expect(JSON.stringify(logs)).not.toContain(CALLER);
  });

  it('an agent-kind number never consults the list', async () => {
    listed();
    state.owned = { ...OWNED, kind: 'agent', assignedUserId: 'rep-1' };
    await ring();
    expect(state.findTestPhone).not.toHaveBeenCalled();
    expect(state.callValues).toHaveLength(1);
  });
});

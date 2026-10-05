/**
 * The media-stream WebSocket route over a real upgrade on a loopback port
 * (`injectWS` is decorated on the plugin's encapsulated scope, out of reach
 * from the root): the signature gate on the handshake, and a start frame
 * reaching the bridge. OpenAI and the bridge are fakes; nothing leaves
 * 127.0.0.1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import twilio from 'twilio';
import WebSocket from 'ws';

const TOKEN = `test-auth-token-${'x'.repeat(16)}`;
const API = 'https://api.test';
const WSS = 'wss://api.test/telephony/twilio/ai-voice/stream';

const state = vi.hoisted(() => ({ cfg: {} as Record<string, unknown> }));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  loadConfig: () => state.cfg,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => null,
}));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => ({}),
}));

import { registerAiVoiceRoutes } from './routes.js';
import { validStreamSignature } from './routes-stream.js';
import { clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import { activeEntry, CALL_SID, fakeSocket, fakeStore, fakeTwilio, type FakeStore, type FakeTwilio } from './testing.js';
import { streamToken } from './twilio.js';
import type { BridgeOptions } from './bridge.js';

const SECRET = 's'.repeat(40);
const ID = '11111111-2222-4333-8444-555555555555';

let app: FastifyInstance;
let store: FakeStore;
let tw: FakeTwilio;
let bridgeOpts: BridgeOptions | null;
let bridgeStarted: Promise<void>;
let markStarted: () => void;
let base: string;

function connect(signature?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}/telephony/twilio/ai-voice/stream`, {
      headers: signature ? { 'x-twilio-signature': signature } : {},
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

beforeEach(async () => {
  state.cfg = {
    API_PUBLIC_URL: API,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_SKIP_SIGNATURE_CHECK: false,
    SESSION_SECRET: SECRET,
    OPENAI_API_KEY: 'sk-test',
    AI_VOICE: 'on',
    OUTREACH_KILL_SWITCH: 'off',
    AI_VOICE_MODEL: 'gpt-realtime-2.1',
    AI_VOICE_VOICE: 'marin',
    AI_VOICE_REASONING: 'low',
    AI_VOICE_VAD_EAGERNESS: 'auto',
    AI_VOICE_MAX_CALL_SECONDS: 600,
  };
  store = fakeStore();
  tw = fakeTwilio();
  bridgeOpts = null;
  bridgeStarted = new Promise((r) => (markStarted = r));
  app = Fastify();
  await registerAiVoiceRoutes(app, {
    store,
    twilio: tw,
    openRealtime: () => fakeSocket(0),
    createBridge: (opts) => {
      bridgeOpts = opts;
      return { start: () => markStarted(), silence: vi.fn(), waitForPlayback: vi.fn(async () => {}), stop: vi.fn() };
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterEach(async () => {
  clearActiveCalls();
  await app.close();
});

const sign = (url = WSS) => twilio.getExpectedTwilioSignature(TOKEN, url, {});

describe('validStreamSignature', () => {
  const cfg = { API_PUBLIC_URL: API, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_SKIP_SIGNATURE_CHECK: false };
  it('accepts the wss URL with or without a trailing slash, nothing else', () => {
    expect(validStreamSignature(cfg, sign())).toBe(true);
    expect(validStreamSignature(cfg, sign(`${WSS}/`))).toBe(true);
    expect(validStreamSignature(cfg, sign('https://api.test/telephony/twilio/ai-voice/stream'))).toBe(false);
    expect(validStreamSignature(cfg, sign('wss://evil.test/telephony/twilio/ai-voice/stream'))).toBe(false);
    expect(validStreamSignature(cfg, undefined)).toBe(false);
    expect(validStreamSignature({ ...cfg, TWILIO_SKIP_SIGNATURE_CHECK: true }, undefined)).toBe(true);
  });
});

describe('GET /telephony/twilio/ai-voice/stream (WebSocket)', () => {
  it('refuses the upgrade with 403 on a bad signature', async () => {
    await expect(connect('nope')).rejects.toThrow('Unexpected server response: 403');
    await expect(connect()).rejects.toThrow('Unexpected server response: 403');
    // Signed for another host (what a Host-header rebuild would accept): still 403.
    await expect(connect(sign('wss://127.0.0.1/telephony/twilio/ai-voice/stream'))).rejects.toThrow('403');
  });

  it('a signed upgrade + a good start frame starts the bridge for that call', async () => {
    await store.insert({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100', status: 'ringing', callSid: CALL_SID });
    registerActiveCall(activeEntry({ aiCallId: ID, callSid: CALL_SID }));
    const ws = await connect(sign());
    ws.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
    ws.send(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ9',
        start: { streamSid: 'MZ9', callSid: CALL_SID, customParameters: { aiCallId: ID, token: streamToken(ID, SECRET) } },
      }),
    );
    await bridgeStarted;
    expect(bridgeOpts).toMatchObject({ streamSid: 'MZ9', model: 'gpt-realtime-2.1', voice: 'marin' });
    expect(bridgeOpts?.instructions).toContain('AI assistant calling for GG Homes');
    expect(getActiveCall(ID)?.bridge).not.toBeNull();
    ws.terminate();
  });

  it('a signed upgrade with a forged token is closed and the call hung up', async () => {
    registerActiveCall(activeEntry({ aiCallId: ID, callSid: CALL_SID }));
    const ws = await connect(sign());
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.send(JSON.stringify({ event: 'start', start: { streamSid: 'MZ9', callSid: CALL_SID, customParameters: { aiCallId: ID, token: '0'.repeat(64) } } }));
    await closed;
    await vi.waitFor(() => expect(tw.hangups).toEqual([CALL_SID]));
    expect(bridgeOpts).toBeNull();
  });

  it('leaves every other route alone: plain HTTP still works, an upgrade elsewhere is dropped as before (Node default)', async () => {
    const plain = await app.inject({ method: 'GET', url: '/ai-calls/availability' });
    expect(plain.statusCode).toBe(401);
    const noUpgrade = await app.inject({ method: 'GET', url: '/telephony/twilio/ai-voice/stream' });
    expect(noUpgrade.statusCode).toBe(403);
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${base}/ai-calls/availability`);
        ws.once('open', resolve);
        ws.once('error', reject);
      }),
    ).rejects.toThrow('socket hang up');
  });
});

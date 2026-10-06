import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import type { BridgeHooks, BridgeOptions } from './bridge.js';
import type { AppointmentSlot } from '@cti/contracts';
import { AI_CALL_TOOLS, type RealtimeFunctionTool } from './prompt.js';
import { claimClose, clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import { finalizeAiCall } from './service-finalize.js';
import { defaultToolEffects } from './service-tools.js';
import { runStreamSession, type StreamSessionDeps } from './stream-session.js';
import {
  activeEntry,
  CALL_SID,
  fakeSocket,
  fakeStore,
  fakeTwilio,
  silentLog,
  type FakeSocket,
  type FakeStore,
  type FakeTwilio,
} from './testing.js';
import { streamToken } from './twilio.js';

const SECRET = 's'.repeat(40);
const ID = '11111111-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-05T18:00:00Z');
const cfg = {
  API_PUBLIC_URL: 'https://api.test',
  SESSION_SECRET: SECRET,
  OPENAI_API_KEY: 'sk-test',
  AI_VOICE: 'on',
  OUTREACH_KILL_SWITCH: 'off',
  AI_VOICE_MODEL: 'gpt-realtime-2.1',
  AI_VOICE_VOICE: 'marin',
  AI_VOICE_REASONING: 'low',
  AI_VOICE_VAD_EAGERNESS: 'auto',
  AI_VOICE_MAX_CALL_SECONDS: 600,
} as AppConfig;

let store: FakeStore;
let twilio: FakeTwilio;
let twilioWs: FakeSocket;
let openaiWs: FakeSocket;
let bridge: { start: ReturnType<typeof vi.fn>; silence: ReturnType<typeof vi.fn>; waitForPlayback: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
let captured: { opts: BridgeOptions; hooks: BridgeHooks } | null;
let deps: StreamSessionDeps & { openRealtime: ReturnType<typeof vi.fn> };

const settle = () => new Promise((r) => setTimeout(r, 0));
const startFrame = (over: { aiCallId?: string; token?: string; callSid?: string } = {}) =>
  JSON.stringify({
    event: 'start',
    sequenceNumber: '1',
    streamSid: 'MZ1',
    start: {
      streamSid: 'MZ1',
      callSid: over.callSid ?? CALL_SID,
      customParameters: { aiCallId: over.aiCallId ?? ID, token: over.token ?? streamToken(over.aiCallId ?? ID, SECRET) },
    },
  });

beforeEach(async () => {
  store = fakeStore();
  twilio = fakeTwilio();
  twilioWs = fakeSocket();
  openaiWs = fakeSocket(0);
  captured = null;
  bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(async () => {}), stop: vi.fn() };
  await store.insert({ id: ID, orgId: 'o1', startedBy: 'u1', toE164: '+16195550100', status: 'ringing', callSid: CALL_SID });
  registerActiveCall(activeEntry({ aiCallId: ID, callSid: CALL_SID }));
  deps = {
    cfg,
    store,
    twilio,
    effects: defaultToolEffects,
    openRealtime: vi.fn(() => openaiWs),
    createBridge: (opts, hooks) => {
      captured = { opts, hooks };
      return bridge;
    },
    now: () => NOW,
    log: silentLog,
  };
});
afterEach(() => clearActiveCalls());

async function begin(frame = startFrame()) {
  const done = runStreamSession(twilioWs, deps);
  twilioWs.emit('message', JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  twilioWs.emit('message', frame);
  return done;
}

describe('runStreamSession — the start frame', () => {
  it('a good start opens OpenAI and starts the bridge with this call’s instructions and options', async () => {
    expect(await begin()).toBe('started');
    expect(deps.openRealtime).toHaveBeenCalledWith('wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1', 'sk-test');
    expect(captured?.opts).toMatchObject({
      twilio: twilioWs,
      openai: openaiWs,
      streamSid: 'MZ1',
      tools: AI_CALL_TOOLS,
      voice: 'marin',
      model: 'gpt-realtime-2.1',
      reasoningEffort: 'low',
      vadEagerness: 'auto',
      maxCallMs: 600_000,
    });
    expect(captured?.opts.instructions).toContain('an AI assistant calling for GG Homes on a recorded line');
    expect(captured?.opts.instructions).toContain('Monday 11:00 AM');
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(store.rows.get(ID)).toMatchObject({ status: 'in_progress', startedAt: NOW });
    expect(getActiveCall(ID)?.bridge).toBe(bridge);
    expect(twilio.hangups).toEqual([]);
  });

  it('a bad token closes the stream and hangs up, and touches no row', async () => {
    expect(await begin(startFrame({ token: 'f'.repeat(64) }))).toBe('bad_token');
    expect(twilioWs.closed).toBe(true);
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)?.status).toBe('ringing');
    expect(deps.openRealtime).not.toHaveBeenCalled();
  });

  it('a malformed call id is a bad token', async () => {
    expect(await begin(startFrame({ aiCallId: 'nope', token: streamToken('nope', SECRET) }))).toBe('bad_token');
    expect(twilio.hangups).toEqual([CALL_SID]);
  });

  it('no registry entry (e.g. after a restart) closes, hangs up and marks the row failed', async () => {
    clearActiveCalls();
    expect(await begin()).toBe('no_call');
    expect(twilioWs.closed).toBe(true);
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)).toMatchObject({ status: 'failed', outcome: 'failed' });
  });

  it('a start for a different call sid is refused', async () => {
    const other = `CA${'c'.repeat(32)}`;
    expect(await begin(startFrame({ callSid: other }))).toBe('sid_mismatch');
    expect(twilio.hangups).toEqual([other]);
    expect(store.rows.get(ID)?.status).toBe('ringing');
  });

  it('a second stream for a call that already has a bridge is dropped without hanging up', async () => {
    expect(await begin()).toBe('started');
    const second = fakeSocket();
    const done = runStreamSession(second, deps);
    second.emit('message', startFrame());
    expect(await done).toBe('duplicate');
    expect(second.closed).toBe(true);
    expect(twilioWs.closed).toBe(false);
    expect(twilio.hangups).toEqual([]);
    expect(bridge.start).toHaveBeenCalledTimes(1);
  });

  it('a queued row (its post-create write failed) is still a placed call and starts', async () => {
    await store.update(ID, { status: 'queued' });
    expect(await begin()).toBe('started');
    expect(store.rows.get(ID)).toMatchObject({ status: 'in_progress', startedAt: NOW });
    expect(twilio.hangups).toEqual([]);
  });

  it('a row that is no longer live is refused', async () => {
    await store.update(ID, { status: 'completed' });
    expect(await begin()).toBe('not_live');
    expect(twilioWs.closed).toBe(true);
    expect(twilio.hangups).toEqual([CALL_SID]);
  });

  it('AI voice switched off since placing: refused and failed', async () => {
    deps.cfg = { ...cfg, OUTREACH_KILL_SWITCH: 'on' } as AppConfig;
    expect(await begin()).toBe('unavailable');
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)?.status).toBe('failed');
  });

  it('a failure opening OpenAI closes, hangs up and fails the call', async () => {
    deps.openRealtime.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(await begin()).toBe('error');
    expect(twilioWs.closed).toBe(true);
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)?.status).toBe('failed');
  });

  it('no start frame in time closes the stream', async () => {
    deps.startTimeoutMs = 5;
    const done = runStreamSession(twilioWs, deps);
    expect(await done).toBe('timeout');
    expect(twilioWs.closed).toBe(true);
  });

  it('frames after the start are left to the bridge (one session per stream)', async () => {
    await begin();
    twilioWs.emit('message', startFrame());
    await settle();
    expect(bridge.start).toHaveBeenCalledTimes(1);
  });
});

describe('runStreamSession — bridge hooks', () => {
  it('an OpenAI-side failure marks the call failed, hangs up, and stops the bridge', async () => {
    await begin();
    captured!.hooks.onEnd('error', 'openai: boom');
    await settle();
    expect(store.rows.get(ID)).toMatchObject({ status: 'failed', outcome: 'failed' });
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(bridge.stop).toHaveBeenCalled();
  });

  it('the time limit hangs up without marking the call failed', async () => {
    await begin();
    captured!.hooks.onEnd('max_duration');
    await settle();
    expect(store.rows.get(ID)?.status).toBe('in_progress');
    expect(twilio.hangups).toEqual([CALL_SID]);
  });

  it('a bridge end while a tool is already closing the call leaves the closer alone', async () => {
    await begin();
    expect(claimClose(ID)).toBe(true);
    captured!.hooks.onEnd('openai_closed');
    await settle();
    expect(twilio.hangups).toEqual([]);
    expect(store.rows.get(ID)?.status).toBe('in_progress');
  });

  it('the stream closing (call over / redirected) only flushes the transcript', async () => {
    await begin();
    captured!.hooks.onTranscript({ role: 'caller', text: 'Hello?', at: NOW });
    captured!.hooks.onEnd('twilio_closed');
    await settle();
    expect(twilio.hangups).toEqual([]);
    expect(store.rows.get(ID)?.transcript).toEqual([{ role: 'caller', text: 'Hello?', at: NOW.toISOString() }]);
  });

  it('end_call through the hook hangs this call up after playback', async () => {
    await begin();
    const res = await captured!.hooks.onTool('end_call', { outcome: 'not_interested', summary: 'no' });
    expect(res.then).toBe('hangup');
    await settle();
    expect(bridge.waitForPlayback).toHaveBeenCalled();
    expect(twilio.hangups).toEqual([CALL_SID]);
  });

  it('transfer_to_rep through the hook rings the hand-off rep with the prospect as caller', async () => {
    await begin();
    await captured!.hooks.onTool('transfer_to_rep', { reason: 'interested', summary: 'hot' });
    await settle();
    const twiml = twilio.redirects[0]?.twiml ?? '';
    expect(twiml).toContain('callerId="+16195550100"');
    expect(twiml).toContain('<Identity>rep_u1</Identity>');
    expect(twiml).toContain(`action="https://api.test/telephony/twilio/ai-voice/transfer-result?aiCallId=${ID}"`);
    expect(twiml).toContain('<Parameter name="aiTransfer" value="interested"/>');
  });
});

describe('runStreamSession — appointment times (plan 1D)', () => {
  const SLOTS: AppointmentSlot[] = [
    {
      id: 'p1', kind: 'phone', start: '2026-10-07T18:00:00.000Z', end: '2026-10-07T18:15:00.000Z',
      specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
    },
    {
      id: 'w1', kind: 'walkthrough', start: '2026-10-08T16:00:00.000Z', end: '2026-10-08T17:00:00.000Z',
      specialistSfUserId: '0058X00000Fsx39QAB', specialistFirstName: 'Grant', timeZone: 'America/Los_Angeles',
    },
  ];
  const withSlots = () => {
    const base = activeEntry({ aiCallId: ID, callSid: CALL_SID });
    registerActiveCall({ ...base, prompt: { ...base.prompt, slots: SLOTS, sellerTimeZone: 'America/Los_Angeles' } });
  };
  const toolNamed = (name: string) => (captured!.opts.tools as RealtimeFunctionTool[]).find((t) => t.name === name);

  it('with slots the tools add book_appointment, whose slot_id enum is the slot ids, and end_call allows appointment_set', async () => {
    withSlots();
    expect(await begin()).toBe('started');
    const book = toolNamed('book_appointment');
    expect((book?.parameters as { properties: { slot_id: { enum: string[] } } }).properties.slot_id.enum).toEqual(['p1', 'w1']);
    expect((toolNamed('end_call')?.parameters as { properties: { outcome: { enum: string[] } } }).properties.outcome.enum).toContain('appointment_set');
    expect(captured!.opts.instructions).toContain('# Booking an appointment');
  });

  it('book_appointment through the hook books from this call’s slots', async () => {
    withSlots();
    await begin();
    const res = await captured!.hooks.onTool('book_appointment', { slot_id: 'p1', address_confirmed: false, note: '' });
    expect(res.then).toBe('continue');
    expect(store.rows.get(ID)?.appointment).toMatchObject({ slotId: 'p1', start: SLOTS[0]!.start });
  });

  it('Fix 1 I-1: booked, then the time limit ends the call: it finalizes as appointment_set', async () => {
    withSlots();
    await begin();
    await captured!.hooks.onTool('book_appointment', { slot_id: 'p1', address_confirmed: false, note: '' });
    captured!.hooks.onEnd('max_duration');
    await settle();
    expect(twilio.hangups).toEqual([CALL_SID]);
    await finalizeAiCall({ store, log: silentLog }, ID, { callStatus: 'completed', durationSeconds: 600, endedAt: NOW, answeredBy: 'human' });
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'appointment_set' });
  });

  it('Fix 1 M-2: a slot the prompt drops (a zone this runtime cannot format) is neither in the tool enum nor bookable', async () => {
    const base = activeEntry({ aiCallId: ID, callSid: CALL_SID });
    const bad: AppointmentSlot = { ...SLOTS[1]!, timeZone: 'Mars/Olympus_Mons' };
    registerActiveCall({ ...base, prompt: { ...base.prompt, slots: [SLOTS[0]!, bad], sellerTimeZone: 'America/Los_Angeles' } });
    await begin();
    expect((toolNamed('book_appointment')?.parameters as { properties: { slot_id: { enum: string[] } } }).properties.slot_id.enum).toEqual(['p1']);
    expect(captured!.opts.instructions).not.toContain('- w1:');
    const res = await captured!.hooks.onTool('book_appointment', { slot_id: 'w1', address_confirmed: true, note: '' });
    expect(res.output).toMatch(/not on your list/);
  });

  it('without slots the tools are unchanged, and book_appointment books nothing', async () => {
    await begin();
    expect(captured!.opts.tools).toEqual(AI_CALL_TOOLS);
    const res = await captured!.hooks.onTool('book_appointment', { slot_id: 'p1', address_confirmed: false, note: '' });
    expect(res.output).toMatch(/not on your list/);
    expect(store.rows.get(ID)?.appointment ?? null).toBeNull();
  });
});

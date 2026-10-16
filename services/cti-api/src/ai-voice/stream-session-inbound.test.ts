/**
 * The stream session for an INBOUND call (plan 2026-10-16 inbound agent testing): the same start checks as an
 * outbound call, then the inbound instructions (+ the fixed line rules), the inbound tools and the quick inbound
 * opener. Twilio sends no status callback for an inbound call, so its row is finalized when the conversation ends:
 * completed, outcome = the saved status (else incomplete), and never a calls row, a Salesforce Task or an opt-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import type { BridgeHooks, BridgeOptions } from './bridge.js';
import { INBOUND_OPENER } from './bridge-session.js';
import { DEFAULT_INBOUND_TEMPLATE } from './prompt-default-inbound.js';
import { AI_CALL_TOOLS, INBOUND_LINE_RULES } from './prompt.js';
import { INBOUND_TOOLS } from './prompt-tools.js';
import { clearActiveCalls, getActiveCall, registerActiveCall } from './registry.js';
import { defaultToolEffects } from './service-tools.js';
import { runStreamSession, type StreamSessionDeps } from './stream-session.js';
import { activeEntry, CALL_SID, fakeSocket, fakeStore, fakeTwilio, silentLog, type FakeSocket, type FakeStore, type FakeTwilio } from './testing.js';
import { streamToken } from './twilio.js';

const SECRET = 's'.repeat(40);
const ID = '11111111-2222-4333-8444-555555555555';
const CALLER = '+16195550142';
const AI_NUMBER = '+16197244374';
const STARTED = new Date('2026-10-16T18:00:00Z');
/** The fixed line rules, then the number the caller is calling from. */
const RULES = `${INBOUND_LINE_RULES}\n- The caller is calling from 619-555-0142.`;
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
  AI_VOICE_BARGE_IN: 'gate',
  AI_VOICE_TRANSCRIBE_MODEL: 'gpt-live-transcribe',
  AI_VOICE_MAX_CALL_SECONDS: 600,
} as AppConfig;

let store: FakeStore;
let twilio: FakeTwilio;
let twilioWs: FakeSocket;
let now: Date;
let bridge: { start: ReturnType<typeof vi.fn>; silence: ReturnType<typeof vi.fn>; waitForPlayback: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
let captured: { opts: BridgeOptions; hooks: BridgeHooks } | null;
let deps: StreamSessionDeps;

const settle = () => new Promise((r) => setTimeout(r, 0));
const startFrame = () =>
  JSON.stringify({
    event: 'start',
    start: { streamSid: 'MZ1', callSid: CALL_SID, customParameters: { aiCallId: ID, token: streamToken(ID, SECRET) } },
  });

const inboundEntry = () =>
  activeEntry({
    aiCallId: ID,
    direction: 'inbound',
    startedBy: 'admin-1',
    handoffUserId: 'admin-1',
    callSid: CALL_SID,
    toE164: CALLER,
    fromE164: AI_NUMBER,
    isTest: true,
    prompt: { agentName: 'Sam', companyName: 'I Buy SD', firstName: null, address: null, notes: '', isTest: true, callbackNumber: null, callerNumber: CALLER },
  });

beforeEach(async () => {
  store = fakeStore();
  twilio = fakeTwilio();
  twilioWs = fakeSocket();
  now = STARTED;
  captured = null;
  bridge = { start: vi.fn(), silence: vi.fn(), waitForPlayback: vi.fn(async () => {}), stop: vi.fn() };
  await store.insert({ id: ID, orgId: 'o1', startedBy: 'admin-1', toE164: CALLER, fromE164: AI_NUMBER, status: 'queued', callSid: CALL_SID, isTest: true, direction: 'inbound' });
  registerActiveCall(inboundEntry());
  deps = {
    cfg,
    store,
    twilio,
    effects: defaultToolEffects,
    openRealtime: vi.fn(() => fakeSocket(0)),
    createBridge: (opts, hooks) => {
      captured = { opts, hooks };
      return bridge;
    },
    now: () => now,
    log: silentLog,
  };
});
afterEach(() => clearActiveCalls());

async function begin() {
  const done = runStreamSession(twilioWs, deps);
  twilioWs.emit('message', startFrame());
  return done;
}
const later = (seconds: number) => {
  now = new Date(STARTED.getTime() + seconds * 1000);
};

describe('an inbound call starts with the inbound agent', () => {
  it('a queued inbound row is accepted and moves to in_progress', async () => {
    expect(await begin()).toBe('started');
    expect(store.rows.get(ID)).toMatchObject({ status: 'in_progress', startedAt: STARTED });
  });

  it("the instructions are the inbound prompt, ending with the line rules and the caller's number; the caller's local time is the caller's", async () => {
    await begin();
    expect(captured?.opts.instructions).toBe(`${DEFAULT_INBOUND_TEMPLATE}\n\n${RULES}`);
  });

  it('a saved inbound template is used, still ending with the line rules', async () => {
    registerActiveCall({ ...inboundEntry(), prompt: { ...inboundEntry().prompt, templates: { instructions: null, voicemail: null, inbound: 'Hi, {{agent_name}} here. It is {{local_time}}.' } } });
    await begin();
    expect(captured?.opts.instructions).toBe(`Hi, Sam here. It is Friday 11:00 AM.\n\n${RULES}`);
  });

  it('the tools are exactly INBOUND_TOOLS and the opener is the quick inbound one', async () => {
    await begin();
    expect(captured?.opts.tools).toBe(INBOUND_TOOLS);
    expect(captured?.opts.opener).toBe(INBOUND_OPENER);
    expect(INBOUND_OPENER).toEqual({ delayMs: 300, prompt: '(Someone just called in and the line is open. Answer now with your greeting.)' });
  });

  it('an outbound entry is unchanged: its tools, no opener option, no line rules', async () => {
    registerActiveCall(activeEntry({ aiCallId: ID, callSid: CALL_SID }));
    await begin();
    expect(captured?.opts.tools).toBe(AI_CALL_TOOLS);
    expect(captured?.opts).not.toHaveProperty('opener');
    expect(captured?.opts.instructions).not.toContain(INBOUND_LINE_RULES);
  });

  it('the tool hook knows the call is inbound: transfer_to_rep is refused, save_caller_details saves', async () => {
    await begin();
    expect(await captured!.hooks.onTool('transfer_to_rep', { reason: 'interested', summary: 'x' })).toEqual({ output: '{"error":"unknown tool"}' });
    expect(twilio.redirects).toEqual([]);
    await captured!.hooks.onTool('save_caller_details', { status: 'qualified', location: 'Escondido' });
    expect(store.rows.get(ID)?.qualification).toEqual({ status: 'qualified', location: 'Escondido' });
  });
});

describe('an inbound call is finalized when the conversation ends', () => {
  it('the caller hangs up mid-sentence: completed, outcome = the saved status, the duration, no calls row', async () => {
    await begin();
    await captured!.hooks.onTool('save_caller_details', { status: 'callback', best_callback_time: 'Monday' });
    later(95);
    captured!.hooks.onEnd('twilio_closed');
    await settle();
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'callback', durationSeconds: 95, endedAt: now });
    expect(store.ctiCalls.size).toBe(0);
    expect(store.optOuts).toEqual([]);
    expect(getActiveCall(ID)).toBeNull();
    expect(bridge.stop).toHaveBeenCalled();
    expect(twilio.hangups).toEqual([]);
  });

  it('no status saved (or an invalid one): outcome incomplete', async () => {
    await begin();
    await store.mergeQualification(ID, { status: 'maybe', location: 'Vista' });
    captured!.hooks.onEnd('twilio_closed');
    await settle();
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'incomplete' });
  });

  it('end_call then the hang-up: the status wins over the end_call outcome, and the test phone is not opted out', async () => {
    await begin();
    await captured!.hooks.onTool('save_caller_details', { status: 'disqualified' });
    await captured!.hooks.onTool('end_call', { outcome: 'do_not_call', summary: 'Asked us not to call.' });
    await settle();
    expect(twilio.hangups).toEqual([CALL_SID]);
    captured!.hooks.onEnd('twilio_closed');
    await settle();
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'disqualified' });
    expect(store.optOuts).toEqual([]);
    expect(store.ctiCalls.size).toBe(0);
  });

  it('the OpenAI side failing: the call is hung up and the row closed (failed), never left open', async () => {
    await begin();
    later(30);
    captured!.hooks.onEnd('openai_closed', 'socket closed');
    await settle();
    await settle();
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)).toMatchObject({ status: 'failed', outcome: 'incomplete', durationSeconds: 30 });
    expect(store.ctiCalls.size).toBe(0);
    expect(getActiveCall(ID)).toBeNull();
  });

  it('the time limit: hung up and closed as completed', async () => {
    await begin();
    captured!.hooks.onEnd('max_duration');
    await settle();
    await settle();
    expect(twilio.hangups).toEqual([CALL_SID]);
    expect(store.rows.get(ID)).toMatchObject({ status: 'completed', outcome: 'incomplete' });
  });
});

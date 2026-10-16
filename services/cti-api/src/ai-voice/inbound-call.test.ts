/**
 * The start of an inbound AI call (plan 2026-10-16 inbound agent testing): a phone on the org's test-phones list
 * calls one of the AI's numbers and gets the agent. Anything else (switch off, AI voice unavailable, an anonymous or
 * unparsable caller, a phone not on the list, any error) answers null, so the route keeps today's routing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { INBOUND_NOT_STARTED, startInboundAiCall, tryInboundAiCall, type InboundAiDeps } from './inbound-call.js';
import { clearActiveCalls, getActiveCall } from './registry.js';
import { fakeStore, type FakeStore } from './testing.js';
import { streamToken } from './twilio.js';

const SECRET = 's'.repeat(40);
const ORG = 'o1';
const CALLER = '+16195550142';
const AI_NUMBER = '+16197244374';
const CALL_SID = `CA${'c'.repeat(32)}`;
const ADMIN = '22222222-2222-4333-8444-555555555555';
const NOW = new Date('2026-10-16T18:00:00Z');

const cfg = {
  API_PUBLIC_URL: 'https://api.test',
  SESSION_SECRET: SECRET,
  OPENAI_API_KEY: 'sk-test',
  AI_VOICE: 'on',
  OUTREACH_KILL_SWITCH: 'off',
  AI_VOICE_INBOUND: 'on',
  AI_VOICE_AGENT_NAME: 'Sam',
  AI_VOICE_MAX_CALL_SECONDS: 600,
} as AppConfig;

let store: FakeStore;
let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
let findTestPhone: ReturnType<typeof vi.fn>;
let deps: InboundAiDeps;

beforeEach(() => {
  store = fakeStore();
  store.orgNames.set(ORG, 'I Buy SD');
  log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  findTestPhone = vi.fn(async () => ({ id: 'phone-1', addedBy: ADMIN, label: "Evren's cell" }));
  deps = { cfg, db: {} as never, store, log, now: () => NOW, findTestPhone };
});
afterEach(() => clearActiveCalls());

const call = (over: Partial<Parameters<typeof tryInboundAiCall>[1]> = {}) => ({ orgId: ORG, callerE164: CALLER, aiNumber: AI_NUMBER, callSid: CALL_SID, ...over });
const onlyRow = () => {
  expect(store.rows.size).toBe(1);
  return [...store.rows.values()][0]!;
};

describe('tryInboundAiCall — who gets the agent', () => {
  it('a listed phone gets <Connect><Stream> TwiML for a new inbound row', async () => {
    const twiml = await tryInboundAiCall(deps, call());
    const row = onlyRow();
    expect(twiml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.test/telephony/twilio/ai-voice/stream">' +
        `<Parameter name="aiCallId" value="${row.id}"/><Parameter name="token" value="${streamToken(row.id, SECRET)}"/>` +
        '</Stream></Connect></Response>',
    );
    expect(findTestPhone).toHaveBeenCalledWith(deps.db, ORG, CALLER);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['the switch is off', { cfg: { ...cfg, AI_VOICE_INBOUND: 'off' } }, 'switched_off'],
    ['AI voice is off', { cfg: { ...cfg, AI_VOICE: 'off' } }, 'ai_unavailable'],
    ['there is no OpenAI key', { cfg: { ...cfg, OPENAI_API_KEY: undefined } }, 'ai_unavailable'],
    ['the outreach kill switch is on', { cfg: { ...cfg, OUTREACH_KILL_SWITCH: 'on' } }, 'ai_unavailable'],
  ] as const)('%s → null, no lookup, a warning with the reason code', async (_name, over, reason) => {
    expect(await tryInboundAiCall({ ...deps, cfg: over.cfg as AppConfig }, call())).toBeNull();
    expect(findTestPhone).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
    expect(log.warn).toHaveBeenCalledWith({ reason }, INBOUND_NOT_STARTED);
  });

  it.each(['anonymous', '', 'Restricted', '+1', '12'])('an anonymous or unparsable caller (%j) → null, no lookup', async (from) => {
    expect(await tryInboundAiCall(deps, call({ callerE164: from }))).toBeNull();
    expect(findTestPhone).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith({ reason: 'bad_caller' }, INBOUND_NOT_STARTED);
  });

  it('a call with no usable CallSid → null (the stream could never be matched to it)', async () => {
    expect(await tryInboundAiCall(deps, call({ callSid: '' }))).toBeNull();
    expect(store.rows.size).toBe(0);
    expect(log.warn).toHaveBeenCalledWith({ reason: 'bad_call_sid' }, INBOUND_NOT_STARTED);
  });

  it('a phone not on the list → null and no warning (every real caller takes this path)', async () => {
    findTestPhone.mockResolvedValueOnce(null);
    expect(await tryInboundAiCall(deps, call())).toBeNull();
    expect(store.rows.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('the lookup throwing → null and a warning with a code only (never the error text or the number)', async () => {
    findTestPhone.mockRejectedValueOnce(new Error(`connection refused for ${CALLER}`));
    expect(await tryInboundAiCall(deps, call())).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ reason: 'lookup_failed' }, INBOUND_NOT_STARTED);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(CALLER);
  });

  it('the row insert throwing (e.g. a replayed CallSid) → null and a warning', async () => {
    store.insert = vi.fn(async () => {
      throw new Error('duplicate key value violates unique constraint "ai_calls_call_sid_unique"');
    });
    expect(await tryInboundAiCall(deps, call())).toBeNull();
    expect(log.warn).toHaveBeenCalledWith({ reason: 'start_failed' }, INBOUND_NOT_STARTED);
  });

  it('normalises a caller the route left raw (strict E.164 match)', async () => {
    await tryInboundAiCall(deps, call({ callerE164: '(619) 555-0142' }));
    expect(findTestPhone).toHaveBeenCalledWith(deps.db, ORG, CALLER);
  });
});

describe('startInboundAiCall — the row and the registry entry', () => {
  it('writes an inbound test row: caller in to_e164, the AI number in from_e164, started by the admin who listed the phone', async () => {
    await tryInboundAiCall(deps, call());
    expect(onlyRow()).toMatchObject({
      orgId: ORG,
      startedBy: ADMIN,
      direction: 'inbound',
      isTest: true,
      practice: false,
      sfObject: null,
      sfRecordId: null,
      toE164: CALLER,
      fromE164: AI_NUMBER,
      status: 'queued',
      callSid: CALL_SID,
    });
  });

  it('registers the live call: inbound, no record, the CallSid, and the prompt input (caller number, saved templates)', async () => {
    store.agentPrompts.push({ orgId: ORG, kind: 'inbound', body: 'Hi from {{agent_name}}', createdAt: NOW });
    await tryInboundAiCall(deps, call());
    const entry = getActiveCall(onlyRow().id);
    expect(entry).toMatchObject({
      orgId: ORG,
      startedBy: ADMIN,
      direction: 'inbound',
      callSid: CALL_SID,
      toE164: CALLER,
      fromE164: AI_NUMBER,
      isTest: true,
      record: null,
      bridge: null,
      transcript: null,
      closing: false,
    });
    expect(entry?.prompt).toMatchObject({
      agentName: 'Sam',
      companyName: 'I Buy SD',
      callerNumber: CALLER,
      isTest: true,
      templates: { instructions: null, voicemail: null, inbound: 'Hi from {{agent_name}}' },
    });
  });

  it('an unreadable org name is said as no name (the call still starts)', async () => {
    store.orgName = vi.fn(async () => {
      throw new Error('db down');
    });
    const twiml = await startInboundAiCall(deps, { ...call(), addedBy: ADMIN });
    expect(twiml).toContain('<Connect>');
    expect(getActiveCall(onlyRow().id)?.prompt.companyName).toBe('');
  });

  it('the same phone calling twice gets two rows and two live calls (no cross-talk)', async () => {
    await tryInboundAiCall(deps, call());
    await tryInboundAiCall(deps, call({ callSid: `CA${'d'.repeat(32)}` }));
    const ids = [...store.rows.keys()];
    expect(ids).toHaveLength(2);
    expect(new Set(ids.map((id) => getActiveCall(id)?.callSid))).toEqual(new Set([CALL_SID, `CA${'d'.repeat(32)}`]));
  });

  it('removing the phone mid-call leaves that call running; its next call routes as today', async () => {
    await tryInboundAiCall(deps, call());
    const live = onlyRow().id;
    findTestPhone.mockResolvedValueOnce(null); // removed from the list
    expect(await tryInboundAiCall(deps, call({ callSid: `CA${'e'.repeat(32)}` }))).toBeNull();
    expect(getActiveCall(live)?.direction).toBe('inbound');
    expect(store.rows.size).toBe(1);
  });
});

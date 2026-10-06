import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import {
  callbackUrl,
  createAiVoiceTwilio,
  noRepTwiml,
  repClientIdentity,
  streamToken,
  streamTwiml,
  streamWssUrl,
  transferTwiml,
  verifyStreamToken,
  voicemailTwiml,
  NO_REP_TEXT,
  TRANSFER_TIME_LIMIT_SECONDS,
  type AiVoiceTwilioClient,
} from './twilio.js';

const SECRET = 's'.repeat(40);
const ID = '11111111-2222-4333-8444-555555555555';
const SID = `CA${'a'.repeat(32)}`;

describe('stream URL and callbacks', () => {
  it('derives the wss URL from the public https URL, never a Host header', () => {
    expect(streamWssUrl('https://api.example.com')).toBe('wss://api.example.com/telephony/twilio/ai-voice/stream');
    expect(streamWssUrl('http://localhost:3001')).toBe('ws://localhost:3001/telephony/twilio/ai-voice/stream');
  });

  it('builds a callback URL with the ai call id in the query string', () => {
    expect(callbackUrl('https://api.example.com', '/telephony/twilio/ai-voice/amd', ID)).toBe(
      `https://api.example.com/telephony/twilio/ai-voice/amd?aiCallId=${ID}`,
    );
  });
});

describe('streamTwiml', () => {
  it('connects a bidirectional stream with the id and token as Parameters, no query string', () => {
    const xml = streamTwiml({ wssUrl: 'wss://api.example.com/telephony/twilio/ai-voice/stream', aiCallId: ID, token: 'abc' });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://api.example.com/telephony/twilio/ai-voice/stream">' +
        `<Parameter name="aiCallId" value="${ID}"/><Parameter name="token" value="abc"/></Stream></Connect></Response>`,
    );
  });
});

describe('stream token', () => {
  it('round-trips, is 64 hex chars, and is bound to the call id and the secret', () => {
    const t = streamToken(ID, SECRET);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyStreamToken(ID, t, SECRET)).toBe(true);
    expect(verifyStreamToken('11111111-2222-4333-8444-555555555556', t, SECRET)).toBe(false);
    expect(verifyStreamToken(ID, t, 'x'.repeat(40))).toBe(false);
  });

  it('rejects empty, short, and non-hex tokens without throwing', () => {
    expect(verifyStreamToken(ID, '', SECRET)).toBe(false);
    expect(verifyStreamToken(ID, 'abc', SECRET)).toBe(false);
    expect(verifyStreamToken(ID, 'z'.repeat(64), SECRET)).toBe(false);
  });
});

describe('transferTwiml', () => {
  it('rings the rep softphone identity with caller params and the AI transfer reason', () => {
    const xml = transferTwiml({
      userId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      callerId: '+16195550100',
      actionUrl: `https://api.example.com/telephony/twilio/ai-voice/transfer-result?aiCallId=${ID}`,
      caller: { name: 'Jane <Doe>', popRecordId: '00Q5e00000AbCdEFGH' },
      reason: 'interested',
    });
    expect(xml).toContain('<Dial callerId="+16195550100" timeout="25" action="https://api.example.com/telephony/twilio/ai-voice/transfer-result?aiCallId=');
    expect(xml).toContain('method="POST"');
    expect(xml).toContain('<Client><Identity>rep_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee</Identity>');
    expect(xml).toContain('<Parameter name="callerName" value="Jane &lt;Doe>"/>');
    expect(xml).toContain('<Parameter name="recordId" value="00Q5e00000AbCdEFGH"/>');
    expect(xml).toContain('<Parameter name="recordType" value="Lead"/>');
    expect(xml).toContain('<Parameter name="aiTransfer" value="interested"/>');
  });

  it('still names the identity and the reason with no record match', () => {
    const xml = transferTwiml({ userId: 'u1', callerId: '+16195550100', actionUrl: 'https://x/y', caller: null, reason: 'question' });
    expect(xml).toContain('<Client><Identity>rep_u1</Identity><Parameter name="aiTransfer" value="question"/></Client>');
  });

  it('uses the same identity shape as the softphone token route', () => {
    expect(repClientIdentity('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe('rep_aaaaaaaabbbb4ccc8dddeeeeeeeeeeee');
  });
});

describe('fixed TwiML', () => {
  it('noRepTwiml says the callback promise then hangs up', () => {
    expect(noRepTwiml()).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Joanna-Neural">${NO_REP_TEXT}</Say><Hangup/></Response>`,
    );
    expect(NO_REP_TEXT).toBe("Sorry, our specialist just stepped away — they'll call you right back. Thanks!");
  });

  it('voicemailTwiml pauses, says the escaped text, and hangs up', () => {
    expect(voicemailTwiml('Hi <Jane> & co')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="1"/><Say voice="Polly.Joanna-Neural">Hi &lt;Jane&gt; &amp; co</Say><Hangup/></Response>',
    );
  });
});

function fakeClient() {
  const update = vi.fn(async (_a: Record<string, unknown>) => ({}));
  const create = vi.fn(async (_a: Record<string, unknown>) => ({ sid: SID }));
  const fetch = vi.fn(async () => ({ status: 'completed', duration: '42', answeredBy: 'human', endTime: new Date('2026-10-05T18:05:00Z') }));
  const calls = Object.assign(vi.fn((_sid: string) => ({ update, fetch })), { create });
  return { client: { calls } as unknown as AiVoiceTwilioClient, create, update, fetch, calls };
}

describe('createAiVoiceTwilio', () => {
  const cfg = { AI_VOICE_MAX_CALL_SECONDS: 600 } as AppConfig;

  it('places the call with async AMD, status events, and a time limit past the agent cap', async () => {
    const f = fakeClient();
    const port = createAiVoiceTwilio(cfg, () => f.client);
    const out = await port.placeCall({
      to: '+16195550100',
      from: '+16195550000',
      twiml: '<Response/>',
      statusCallback: 'https://x/status',
      amdCallback: 'https://x/amd',
    });
    expect(out).toEqual({ callSid: SID });
    expect(f.create).toHaveBeenCalledWith({
      to: '+16195550100',
      from: '+16195550000',
      twiml: '<Response/>',
      timeout: 30,
      machineDetection: 'DetectMessageEnd',
      machineDetectionSpeechThreshold: 1900,
      machineDetectionSpeechEndThreshold: 1400,
      asyncAmd: 'true',
      asyncAmdStatusCallback: 'https://x/amd',
      asyncAmdStatusCallbackMethod: 'POST',
      statusCallback: 'https://x/status',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      timeLimit: 660,
    });
  });

  it('plan 1E: amd: false (a browser leg) sends none of the six AMD keys; everything else is identical', async () => {
    const f = fakeClient();
    const port = createAiVoiceTwilio(cfg, () => f.client);
    const base = { to: 'client:aitest_x', from: '+16195550000', twiml: '<Response/>', statusCallback: 'https://x/status', amdCallback: 'https://x/amd' };
    await port.placeCall({ ...base, amd: false });
    await port.placeCall({ ...base, amd: true });
    const [off, on] = f.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
    const AMD_KEYS = [
      'machineDetection', 'machineDetectionSpeechThreshold', 'machineDetectionSpeechEndThreshold',
      'asyncAmd', 'asyncAmdStatusCallback', 'asyncAmdStatusCallbackMethod',
    ];
    for (const k of AMD_KEYS) {
      expect(off).not.toHaveProperty(k);
      expect(on).toHaveProperty(k);
    }
    expect(off).toEqual(Object.fromEntries(Object.entries(on!).filter(([k]) => !AMD_KEYS.includes(k))));
  });

  it('redirect replaces the TwiML (optionally lifting the time limit); hangup completes the call', async () => {
    const f = fakeClient();
    const port = createAiVoiceTwilio(cfg, () => f.client);
    await port.redirect(SID, '<Response/>');
    await port.redirect(SID, '<Response><Dial/></Response>', { timeLimit: TRANSFER_TIME_LIMIT_SECONDS });
    await port.hangup(SID);
    expect(f.calls).toHaveBeenCalledWith(SID);
    expect(f.update.mock.calls.map((c) => c[0])).toEqual([
      { twiml: '<Response/>' },
      { twiml: '<Response><Dial/></Response>', timeLimit: TRANSFER_TIME_LIMIT_SECONDS },
      { status: 'completed' },
    ]);
  });

  it('fetchCall reads the call record (status, duration, AMD, end time) for the stale-call sweep', async () => {
    const f = fakeClient();
    const port = createAiVoiceTwilio(cfg, () => f.client);
    expect(await port.fetchCall(SID)).toEqual({
      status: 'completed',
      durationSeconds: 42,
      answeredBy: 'human',
      endTime: new Date('2026-10-05T18:05:00Z'),
    });
    f.fetch.mockResolvedValueOnce({ status: 'in-progress', duration: null, answeredBy: null, endTime: null } as never);
    expect(await port.fetchCall(SID)).toEqual({ status: 'in-progress', durationSeconds: null, answeredBy: null, endTime: null });
  });

  it('builds the REST client once, lazily', async () => {
    const f = fakeClient();
    const factory = vi.fn(() => f.client);
    const port = createAiVoiceTwilio(cfg, factory);
    expect(factory).not.toHaveBeenCalled();
    await port.hangup(SID);
    await port.hangup(SID);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

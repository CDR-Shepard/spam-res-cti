import { describe, expect, it, vi } from 'vitest';

// TwilioDialerTelephony#originate reads cfg.API_PUBLIC_URL via loadConfig()
// (same per-call pattern as telephony/twilio.ts). Mock it rather than relying
// on real deploy env vars (TOKEN_ENCRYPTION_KEY/SESSION_SECRET/DATABASE_URL
// etc.) being present in the test/CI environment — this test only cares about
// the REST call shape, not real config.
vi.mock('../config.js', () => ({
  loadConfig: () => ({
    API_PUBLIC_URL: 'https://api.test.example',
    TWILIO_ACCOUNT_SID: 'ACtest',
    TWILIO_AUTH_TOKEN: 'authtoken-test',
  }),
}));

import { bridgeTwiml, conferenceName, dialerConferenceTwiml, TwilioDialerTelephony, type TwilioDialerClient } from './twilio-telephony.js';

// ---------------------------------------------------------------------------
// conferenceName / bridgeTwiml — pure
// ---------------------------------------------------------------------------

describe('conferenceName', () => {
  it('strips dashes and prefixes pd_', () => {
    expect(conferenceName('11111111-2222-3333-4444-555555555555')).toBe(
      'pd_11111111222233334444555555555555',
    );
  });

  it('is idempotent on an already-stripped id (rep_ token identity form)', () => {
    const stripped = '11111111222233334444555555555555';
    expect(conferenceName(stripped)).toBe(`pd_${stripped}`);
  });

  it('matches the exact expected transform for a realistic UUID', () => {
    expect(conferenceName('abc12345-6789-4def-a012-3456789abcde')).toBe(
      'pd_abc1234567894defa0123456789abcde',
    );
  });
});

describe('bridgeTwiml', () => {
  it('endOnExit=true (rep leg) produces the exact <Dial><Conference> TwiML with endConferenceOnExit="true"', () => {
    const xml = bridgeTwiml('abc12345-6789-4def-a012-3456789abcde', true);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>' +
        '<Conference startConferenceOnEnter="true" endConferenceOnExit="true">pd_abc1234567894defa0123456789abcde</Conference>' +
        '</Dial></Response>',
    );
  });

  it('endOnExit=false (prospect leg) produces the exact <Dial><Conference> TwiML with endConferenceOnExit="false", same conference name', () => {
    const xml = bridgeTwiml('abc12345-6789-4def-a012-3456789abcde', false);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>' +
        '<Conference startConferenceOnEnter="true" endConferenceOnExit="false">pd_abc1234567894defa0123456789abcde</Conference>' +
        '</Dial></Response>',
    );
  });
});

describe('dialerConferenceTwiml', () => {
  it('valid rep identity → conference TwiML with endConferenceOnExit="true" (rep leaving ends the run)', () => {
    const t = dialerConferenceTwiml('client:rep_abc123');
    expect(t).toContain('pd_abc123');
    expect(t).toContain('<Conference');
    expect(t).toContain('endConferenceOnExit="true"');
  });

  it('missing/malformed From → null', () => {
    expect(dialerConferenceTwiml('')).toBeNull();
    expect(dialerConferenceTwiml('+16195551234')).toBeNull();
    expect(dialerConferenceTwiml('client:rep_XYZ!')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TwilioDialerTelephony — REST calls via an injected fake client
// ---------------------------------------------------------------------------

/** Fake twilio client: records every create()/update() call it receives. */
function fakeClient(): { client: TwilioDialerClient; createCalls: Record<string, unknown>[]; updateCalls: { callId: string; args: Record<string, unknown> }[] } {
  const createCalls: Record<string, unknown>[] = [];
  const updateCalls: { callId: string; args: Record<string, unknown> }[] = [];

  const callsFn = ((callSid: string) => ({
    update: async (args: Record<string, unknown>) => {
      updateCalls.push({ callId: callSid, args });
      return {};
    },
  })) as TwilioDialerClient['calls'];
  callsFn.create = async (args: Record<string, unknown>) => {
    createCalls.push(args);
    return { sid: 'CA1' };
  };

  return { client: { calls: callsFn }, createCalls, updateCalls };
}

describe('TwilioDialerTelephony.originate', () => {
  it('builds calls.create args with async AMD and the right callback URLs, without recording the screening leg', async () => {
    const { client, createCalls } = fakeClient();
    const telephony = new TwilioDialerTelephony(() => client);

    const result = await telephony.originate({
      sessionId: 'sess-1',
      itemId: 'item-1',
      fromE164: '+16195550101',
      toE164: '+16195559999',
      userId: 'user-1',
    });

    expect(result).toEqual({ callId: 'CA1' });
    expect(createCalls).toHaveLength(1);
    const args = createCalls[0]!;
    expect(args.to).toBe('+16195559999');
    expect(args.from).toBe('+16195550101');
    expect(args.machineDetection).toBe('Enable');
    expect(args.asyncAmd).toBe('true');
    expect(args.asyncAmdStatusCallbackMethod).toBe('POST');
    expect(args).not.toHaveProperty('record');
    expect(args.statusCallbackEvent).toEqual(['completed']);
    expect(String(args.asyncAmdStatusCallback)).toContain('/telephony/twilio/dialer-amd?itemId=item-1');
    expect(String(args.url)).toContain('/telephony/twilio/dialer-answer');
    expect(String(args.statusCallback)).toContain('/telephony/twilio/dialer-status?itemId=item-1');
  });

  it('does NOT place a live call — the fake client factory is what gets invoked', async () => {
    const { client, createCalls } = fakeClient();
    const factory = vi.fn(() => client);
    const telephony = new TwilioDialerTelephony(factory);
    await telephony.originate({
      sessionId: 's',
      itemId: 'i',
      fromE164: '+16195550101',
      toE164: '+16195559999',
      userId: 'u',
    });
    expect(factory).toHaveBeenCalled();
    expect(createCalls).toHaveLength(1);
  });
});

describe('TwilioDialerTelephony.bridgeToRep', () => {
  it('updates the call with the bridge TwiML for the given user, with endConferenceOnExit="false" so a prospect hangup does not tear down the conference the rep is waiting in', async () => {
    const { client, updateCalls } = fakeClient();
    const telephony = new TwilioDialerTelephony(() => client);
    await telephony.bridgeToRep('CA1', 'user-1');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.callId).toBe('CA1');
    const twiml = updateCalls[0]!.args.twiml as string;
    expect(twiml).toBe(bridgeTwiml('user-1', false));
    expect(twiml).toContain('endConferenceOnExit="false"');
    // Same conference name (via conferenceName) as the rep's own join leg —
    // dialerConferenceTwiml derives its conference from the same helper, so a
    // rep joined on `pd_user1` is bridged into by this exact prospect leg.
    expect(twiml).toContain(`>${conferenceName('user-1')}<`);
  });
});

describe('TwilioDialerTelephony.hangup', () => {
  it('updates the call status to completed', async () => {
    const { client, updateCalls } = fakeClient();
    const telephony = new TwilioDialerTelephony(() => client);
    await telephony.hangup('CA1');

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.callId).toBe('CA1');
    expect(updateCalls[0]!.args).toEqual({ status: 'completed' });
  });
});

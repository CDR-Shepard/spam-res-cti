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

import { bridgeTwiml, conferenceName, DIALER_REJOIN_PATH, dialerConferenceTwiml, dialerRejoinUrl, repUserIdFromClientIdentity, TwilioDialerTelephony, type TwilioDialerClient } from './twilio-telephony.js';

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
  // Twilio plays a conference's wait music only BEFORE it starts, and it starts
  // when the first prospect is bridged — so a room that outlived its prospect
  // left the rep alone in a STARTED conference: silence for the rest of the run.
  // A prospect leg that ENDS the room is what lets the rep's leg re-enter a
  // fresh, un-started one (see `rejoinUrl`) and hear the music again.
  it('prospect leg, room-ending: exact TwiML with endConferenceOnExit="true" and NO action — when the room ends the prospect hangs up, it never loops back in', () => {
    const xml = bridgeTwiml('abc12345-6789-4def-a012-3456789abcde', true);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>' +
        '<Conference startConferenceOnEnter="true" endConferenceOnExit="true">pd_abc1234567894defa0123456789abcde</Conference>' +
        '</Dial></Response>',
    );
  });

  // Still needed: a rep leg that joined BEFORE the rejoin action existed (a run
  // in flight across the deploy) or whose join could not be stamped has no way
  // back in — ending its room would end the rep's call after one conversation.
  it('prospect leg, legacy: endConferenceOnExit="false" leaves the room standing, same conference name', () => {
    const xml = bridgeTwiml('abc12345-6789-4def-a012-3456789abcde', false);
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Dial>' +
        '<Conference startConferenceOnEnter="true" endConferenceOnExit="false">pd_abc1234567894defa0123456789abcde</Conference>' +
        '</Dial></Response>',
    );
  });

  it('rep leg: the <Dial> carries the rejoin action so a finished conference sends the rep back into the room instead of ending their call', () => {
    const xml = bridgeTwiml('abc12345-6789-4def-a012-3456789abcde', true, { rejoinUrl: 'https://api.test.example/telephony/twilio/dialer-conference-rejoin' });
    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Dial action="https://api.test.example/telephony/twilio/dialer-conference-rejoin" method="POST">' +
        '<Conference startConferenceOnEnter="true" endConferenceOnExit="true">pd_abc1234567894defa0123456789abcde</Conference>' +
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

  it('passes the rejoin action through to the rep leg', () => {
    const t = dialerConferenceTwiml('client:rep_abc123', { rejoinUrl: 'https://api.test.example/rejoin' });
    expect(t).toContain('<Dial action="https://api.test.example/rejoin" method="POST">');
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

/** Fake twilio client: records every create()/update()/list() call it receives.
 *  `rooms` is what `conferences.list()` resolves to for the `in-progress` query;
 *  `opts.initRooms` for the `init` (un-started) one; `opts.participants` maps a
 *  conference sid to the call sids in it. `opts.fail` names operations that throw. */
function fakeClient(
  rooms: { sid: string }[] = [],
  opts: { initRooms?: { sid: string }[]; participants?: Record<string, string[]>; fail?: string[] } = {},
): {
  client: TwilioDialerClient;
  createCalls: Record<string, unknown>[];
  updateCalls: { callId: string; args: Record<string, unknown> }[];
  conferenceListArgs: Record<string, unknown>[];
  conferenceUpdates: { sid: string; args: Record<string, unknown> }[];
  events: string[];
} {
  const createCalls: Record<string, unknown>[] = [];
  const updateCalls: { callId: string; args: Record<string, unknown> }[] = [];
  const conferenceListArgs: Record<string, unknown>[] = [];
  const conferenceUpdates: { sid: string; args: Record<string, unknown> }[] = [];
  const events: string[] = [];
  const fails = (op: string): boolean => (opts.fail ?? []).includes(op);

  const callsFn = ((callSid: string) => ({
    update: async (args: Record<string, unknown>) => {
      if (fails(`call:${callSid}`)) throw new Error('Call is not in-progress');
      updateCalls.push({ callId: callSid, args });
      events.push(`call:${callSid}`);
      return {};
    },
  })) as TwilioDialerClient['calls'];
  callsFn.create = async (args: Record<string, unknown>) => {
    createCalls.push(args);
    return { sid: 'CA1' };
  };

  const conferencesFn = ((sid: string) => ({
    update: async (args: Record<string, unknown>) => {
      conferenceUpdates.push({ sid, args });
      events.push(`room:${sid}`);
      return {};
    },
    participants: {
      list: async () => {
        if (fails(`participants:${sid}`)) throw new Error('twilio 500');
        return (opts.participants?.[sid] ?? []).map((callSid) => ({ callSid }));
      },
    },
  })) as TwilioDialerClient['conferences'];
  conferencesFn.list = async (args: Record<string, unknown>) => {
    conferenceListArgs.push(args);
    if (fails(`list:${String(args.status)}`)) throw new Error('twilio 500');
    return args.status === 'init' ? (opts.initRooms ?? []) : rooms;
  };

  return {
    client: { calls: callsFn, conferences: conferencesFn },
    createCalls,
    updateCalls,
    conferenceListArgs,
    conferenceUpdates,
    events,
  };
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
  it('repRejoins=true: the prospect leg ENDS the room on exit (so the rep gets hold music again) and has no rejoin action of its own', async () => {
    const { client, updateCalls } = fakeClient();
    const telephony = new TwilioDialerTelephony(() => client);
    await telephony.bridgeToRep('CA1', 'user-1', { repRejoins: true });

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.callId).toBe('CA1');
    const twiml = updateCalls[0]!.args.twiml as string;
    expect(twiml).toBe(bridgeTwiml('user-1', true));
    expect(twiml).toContain('endConferenceOnExit="true"');
    expect(twiml).not.toContain('action=');
    // Same conference name (via conferenceName) as the rep's own join leg —
    // dialerConferenceTwiml derives its conference from the same helper, so a
    // rep joined on `pd_user1` is bridged into by this exact prospect leg.
    expect(twiml).toContain(`>${conferenceName('user-1')}<`);
  });

  // The safe default. Ending the room under a rep leg that cannot rejoin ends
  // the rep's CALL: the run dies after one conversation.
  it('repRejoins=false, or omitted: the prospect leg leaves the room standing', async () => {
    for (const opts of [{ repRejoins: false }, undefined]) {
      const { client, updateCalls } = fakeClient();
      await new TwilioDialerTelephony(() => client).bridgeToRep('CA1', 'user-1', opts);
      expect(updateCalls[0]!.args.twiml).toBe(bridgeTwiml('user-1', false));
      expect(updateCalls[0]!.args.twiml).toContain('endConferenceOnExit="false"');
    }
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

describe('TwilioDialerTelephony.endConference', () => {
  it('resolves the rep conference by friendly name — started AND un-started rooms — and completes it', async () => {
    // The friendly name is stable per rep (conferenceName) but the conference
    // SID rotates every run, so the SID must be looked up rather than stored.
    // Since the rep's leg re-enters a fresh room after every prospect, the room
    // at run end is usually UN-started (the rep alone, on hold music).
    const { client, conferenceListArgs, conferenceUpdates } = fakeClient([{ sid: 'CF1' }], { initRooms: [{ sid: 'CF0' }] });
    const telephony = new TwilioDialerTelephony(() => client);
    await telephony.endConference('user-1');

    expect(conferenceListArgs).toEqual([
      { friendlyName: conferenceName('user-1'), status: 'in-progress' },
      { friendlyName: conferenceName('user-1'), status: 'init' },
    ]);
    expect(conferenceUpdates).toEqual([
      { sid: 'CF1', args: { status: 'completed' } },
      { sid: 'CF0', args: { status: 'completed' } },
    ]);
  });

  // Completing a room does not END the rep's leg any more: its <Dial action>
  // sends it to the rejoin route, which — for a leg recorded on no run, while the
  // session is still `active` (callers release before the flip) — sends it
  // straight back in. Hanging the calls up is what cannot be undone.
  it("hangs up every participant's call BEFORE completing the room", async () => {
    const { client, events } = fakeClient([{ sid: 'CF1' }], { participants: { CF1: ['CArep', 'CAprospect'] } });
    await new TwilioDialerTelephony(() => client).endConference('user-1');
    expect(events).toEqual(['call:CArep', 'call:CAprospect', 'room:CF1']);
  });

  it('one participant that cannot be hung up (already gone) does not save the others, or the room', async () => {
    const { client, events } = fakeClient([{ sid: 'CF1' }], { participants: { CF1: ['CAgone', 'CArep'] }, fail: ['call:CAgone'] });
    await new TwilioDialerTelephony(() => client).endConference('user-1');
    expect(events).toEqual(['call:CArep', 'room:CF1']);
  });

  it('still completes the room when its participants cannot be listed', async () => {
    const { client, events } = fakeClient([{ sid: 'CF1' }], { fail: ['participants:CF1'] });
    await new TwilioDialerTelephony(() => client).endConference('user-1');
    expect(events).toEqual(['room:CF1']);
  });

  it('a failed un-started-room lookup does not lose the started rooms', async () => {
    const { client, conferenceUpdates } = fakeClient([{ sid: 'CF1' }], { fail: ['list:init'] });
    await new TwilioDialerTelephony(() => client).endConference('user-1');
    expect(conferenceUpdates.map((u) => u.sid)).toEqual(['CF1']);
  });

  it('is a no-op when the rep has no conference (the client leg already collapsed it)', async () => {
    const { client, conferenceUpdates, updateCalls } = fakeClient([]);
    const telephony = new TwilioDialerTelephony(() => client);
    await telephony.endConference('user-1');

    expect(conferenceUpdates).toEqual([]);
    expect(updateCalls).toEqual([]);
  });

  it('completes every matching conference, not just the first', async () => {
    const { client, conferenceUpdates } = fakeClient([{ sid: 'CF1' }, { sid: 'CF2' }]);
    const telephony = new TwilioDialerTelephony(() => client);
    await telephony.endConference('user-1');

    expect(conferenceUpdates.map((u) => u.sid)).toEqual(['CF1', 'CF2']);
  });
});

// ---------------------------------------------------------------------------
// Hold music per rep (Settings → "Hold music during Power Dial")
// ---------------------------------------------------------------------------

describe('hold music per rep', () => {
  it('the rep leg waits in silence (waitUrl="") when the rep turned hold music off', () => {
    const t = bridgeTwiml('abc123', true, { holdMusic: false });
    expect(t).toContain('waitUrl=""');
    expect(t).toContain('endConferenceOnExit="true"');
  });

  it('defaults to Twilio hold music: no waitUrl attribute unless the rep opted out', () => {
    expect(bridgeTwiml('abc123', true)).not.toContain('waitUrl');
    expect(bridgeTwiml('abc123', true, { holdMusic: true })).not.toContain('waitUrl');
    expect(bridgeTwiml('abc123', false)).not.toContain('waitUrl');
  });

  it('dialerConferenceTwiml passes the preference through to the rep leg', () => {
    expect(dialerConferenceTwiml('client:rep_abc123', { holdMusic: false })).toContain('waitUrl=""');
    expect(dialerConferenceTwiml('client:rep_abc123')).not.toContain('waitUrl');
  });

  it('dialerRejoinUrl is the public URL of the rejoin route — the one string Twilio signs and the route validates', () => {
    expect(DIALER_REJOIN_PATH).toBe('/telephony/twilio/dialer-conference-rejoin');
    expect(dialerRejoinUrl()).toBe('https://api.test.example/telephony/twilio/dialer-conference-rejoin');
  });

  it('repUserIdFromClientIdentity restores the dashed users.id from the 32-hex identity, null for anything else', () => {
    expect(repUserIdFromClientIdentity('client:rep_c9c459400f174c1ebb3ed084ba93eb86')).toBe('c9c45940-0f17-4c1e-bb3e-d084ba93eb86');
    expect(repUserIdFromClientIdentity('client:rep_C9C459400F174C1EBB3ED084BA93EB86')).toBe('c9c45940-0f17-4c1e-bb3e-d084ba93eb86');
    expect(repUserIdFromClientIdentity('client:rep_abc123')).toBeNull();
    expect(repUserIdFromClientIdentity('+16195551234')).toBeNull();
    expect(repUserIdFromClientIdentity('')).toBeNull();
  });
});

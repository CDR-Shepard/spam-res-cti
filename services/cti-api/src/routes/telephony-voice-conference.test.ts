/**
 * Route-level test for the power-dialer conference-join branch of
 * POST /telephony/twilio/voice: the rep's leg gets waitUrl="" (silence) only
 * when that rep turned hold music off, looked up by their own users.id, and a
 * lookup that fails keeps music on and still joins them. Harness idiom:
 * routes/admin-team.test.ts (hoisted state, vi.mock of @cti/auth / @cti/db /
 * ../config.js, Fastify + register).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  userRow: null as { dialerHoldMusic: boolean } | null,
  findFirstThrows: false,
  lastFindFirst: null as { where: unknown; columns?: unknown } | null,
  /** The run this LEG is recorded on (lookup by rep_call_sid), if any. */
  legSession: null as { status: string } | null,
  /** Fallback: does the rep have any live run (lookup by user + status). */
  liveSession: null as { id: string } | null,
  sessionLookupHangs: false,
  userLookupHangs: false,
  /** What the stamp's read-before-write finds on the run (the leg it replaces). */
  stampedBefore: null as { repCallSid: string | null } | null,
  hangups: [] as string[],
  hangupThrows: false,
  sessionLookupThrows: false,
  sessionLookups: [] as Array<{ where: unknown }>,
  updates: [] as Array<{ set: Record<string, unknown>; where: unknown }>,
  updateThrows: false,
  signatureValid: true,
  validatedUrls: [] as string[],
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ API_PUBLIC_URL: 'https://api.test', TWILIO_SKIP_SIGNATURE_CHECK: false }),
}));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({
    validateWebhook: (_h: unknown, _body: string, url: string) => {
      state.validatedUrls.push(url);
      return { valid: state.signatureValid };
    },
  }),
}));
vi.mock('../dialer/twilio-telephony.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/twilio-telephony.js')>()),
  TwilioDialerTelephony: class {
    async hangup(callSid: string): Promise<void> {
      if (state.hangupThrows) throw new Error('Call is not in-progress');
      state.hangups.push(callSid);
    }
  },
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => null,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        users: {
          findFirst: async (args: { where: unknown; columns?: unknown }) => {
            state.lastFindFirst = args;
            if (state.findFirstThrows) throw new Error('pool exhausted');
            if (state.userLookupHangs) return new Promise(() => {});
            return state.userRow;
          },
        },
        dialerSessions: {
          findFirst: async (args: { where: unknown }) => {
            state.sessionLookups.push(args);
            if (state.sessionLookupThrows) throw new Error('pool exhausted');
            if (state.sessionLookupHangs) return new Promise(() => {});
            if ((args as { columns?: Record<string, boolean> }).columns?.repCallSid) return state.stampedBefore;
            return paramValues(args.where).flat().includes(REP_CALL_SID) ? state.legSession : state.liveSession;
          },
        },
      },
      update: () => ({
        set: (set: Record<string, unknown>) => ({
          where: async (where: unknown) => {
            if (state.updateThrows) throw new Error('pool exhausted');
            state.updates.push({ set, where });
          },
        }),
      }),
    }),
  };
});

import { _setRejoinDbTimeoutForTests, registerTelephonyRoutes } from './telephony.js';

/** Bound parameter values inside a drizzle predicate — which id the query asked for. */
function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => paramValues(n, out)); return out; }
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return paramValues(n.queryChunks, out);
  if ('value' in n && !Array.isArray(n.value)) out.push(n.value);
  return out;
}

const REP_CALL_SID = 'CA0123456789abcdef0123456789abcdef';
const SESSION_ID = '7b0e5c1a-2f4d-4c3b-9a8e-1d2c3b4a5f60';
const REP_ID = 'c9c45940-0f17-4c1e-bb3e-d084ba93eb86';
const REP_FROM = 'client:rep_c9c459400f174c1ebb3ed084ba93eb86';

let app: FastifyInstance;
beforeEach(async () => {
  state.userRow = { dialerHoldMusic: true };
  state.findFirstThrows = false;
  state.lastFindFirst = null;
  state.legSession = { status: 'active' };
  state.liveSession = { id: 'sess-1' };
  state.sessionLookupHangs = false;
  state.userLookupHangs = false;
  state.stampedBefore = null;
  state.hangups = [];
  state.hangupThrows = false;
  _setRejoinDbTimeoutForTests(3000);
  state.sessionLookupThrows = false;
  state.sessionLookups = [];
  state.updates = [];
  state.updateThrows = false;
  state.signatureValid = true;
  state.validatedUrls = [];
  app = Fastify();
  await registerTelephonyRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const REJOIN_ACTION = '<Dial action="https://api.test/telephony/twilio/dialer-conference-rejoin" method="POST">';

const join = (from = REP_FROM, callSid: string | null = REP_CALL_SID, sessionId: string | null = null) =>
  app.inject({
    method: 'POST',
    url: '/telephony/twilio/voice',
    payload: { DialerConference: '1', From: from, ...(callSid ? { CallSid: callSid } : {}), ...(sessionId ? { DialerSessionId: sessionId } : {}) },
  });

const rejoin = (payload: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/telephony/twilio/dialer-conference-rejoin',
    payload: { From: REP_FROM, CallSid: REP_CALL_SID, CallStatus: 'in-progress', DialCallStatus: 'completed', ...payload },
  });

describe('POST /telephony/twilio/voice — DialerConference join', () => {
  it('a rep with hold music on (the default) joins with Twilio hold music: no waitUrl', async () => {
    const res = await join();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Conference');
    expect(res.body).toContain('endConferenceOnExit="true"');
    expect(res.body).not.toContain('waitUrl');
  });

  it('a rep who turned hold music off joins in silence (waitUrl=""), looked up by their own users.id', async () => {
    state.userRow = { dialerHoldMusic: false };
    const res = await join();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('waitUrl=""');
    expect(state.lastFindFirst?.columns).toEqual({ dialerHoldMusic: true });
    expect(paramValues(state.lastFindFirst?.where)).toContain(REP_ID);
  });

  it('a failed lookup keeps music on and still joins the rep', async () => {
    state.findFirstThrows = true;
    const res = await join();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Conference');
    expect(res.body).not.toContain('waitUrl');
  });

  it('a missing profile row keeps music on', async () => {
    state.userRow = null;
    expect((await join()).body).not.toContain('waitUrl');
  });

  it('a From that is not a rep identity gets the error TwiML and never queries', async () => {
    const res = await join('+16195551234');
    expect(res.body).toContain('Unable to identify rep');
    expect(state.lastFindFirst).toBeNull();
    expect(state.updates).toEqual([]);
  });

  // Without the action the rep's call simply ENDS when the first prospect hangs
  // up (both legs now end the room) — the run would die after one conversation.
  it('the rep leg carries the rejoin action, so a finished conference sends them back into the room', async () => {
    expect((await join()).body).toContain(REJOIN_ACTION);
  });

  // The run-end backstop hangs up THIS call by sid. A friendly-name lookup cannot
  // do it any more: between conferences the rep is in no room at all, and a room
  // completed by name would just send the leg round the rejoin loop.
  // The softphone names its run. That is the only way a run that came up PAUSED
  // (no numbers free at Start) gets its leg recorded: "the rep's one active run"
  // cannot see it, and guessing among paused runs could pick an abandoned one.
  it("stamps the rep leg's CallSid on the run the softphone NAMED — the rep's own, active or paused", async () => {
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ repCallSid: REP_CALL_SID });
    const bound = paramValues(state.updates[0]!.where).flat();
    expect(bound).toContain(SESSION_ID);
    expect(bound).toContain(REP_ID); // never another rep's run, whatever id is sent
    expect(bound.filter((v) => ['active', 'paused', 'ready', 'done', 'stopped'].includes(v as string)).sort()).toEqual(['active', 'paused']);
  });

  // An older softphone (a tab open since before the deploy) names nothing.
  it("with no run named, stamps the rep's ACTIVE session only — never a paused one, which may be abandoned", async () => {
    await join();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ repCallSid: REP_CALL_SID });
    const bound = paramValues(state.updates[0]!.where).flat();
    expect(bound).toContain(REP_ID);
    expect(bound.filter((v) => ['active', 'paused', 'ready', 'done', 'stopped'].includes(v as string))).toEqual(['active']);
  });

  it('a run id that is not a uuid is ignored, not interpolated: falls back to the active-session stamp', async () => {
    await join(REP_FROM, REP_CALL_SID, "x' or '1'='1");
    expect(state.updates).toHaveLength(1);
    const bound = paramValues(state.updates[0]!.where).flat();
    expect(bound).not.toContain("x' or '1'='1");
    expect(bound.filter((v) => ['active', 'paused'].includes(v as string))).toEqual(['active']);
  });

  // A leg the softphone gave up on can outlive it on Twilio's side (signalling
  // died; Twilio has not noticed yet). Left alone it shares the new leg's room:
  // two rep legs START the conference (no music), and when Twilio finally reaps
  // the old one it ENDS the room — dropping whoever the rep is talking to.
  it('re-joining a run hangs up the leg it replaces', async () => {
    const OLD = 'CAffffffffffffffffffffffffffffffff';
    state.stampedBefore = { repCallSid: OLD };
    const res = await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(res.body).toContain('<Conference');
    await new Promise((r) => setImmediate(r));
    expect(state.hangups).toEqual([OLD]);
  });

  it('…but never the leg that is joining (Twilio retried the webhook), and nothing on a first join', async () => {
    state.stampedBefore = { repCallSid: REP_CALL_SID };
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    state.stampedBefore = { repCallSid: null };
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    state.stampedBefore = null;
    await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    await new Promise((r) => setImmediate(r));
    expect(state.hangups).toEqual([]);
  });

  it('a stale leg that cannot be hung up (already gone — the usual case) changes nothing', async () => {
    state.stampedBefore = { repCallSid: 'CAffffffffffffffffffffffffffffffff' };
    state.hangupThrows = true;
    const res = await join(REP_FROM, REP_CALL_SID, SESSION_ID);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Conference');
    expect(state.updates).toHaveLength(1);
  });

  it('a failed stamp never keeps the rep out of their conference', async () => {
    state.updateThrows = true;
    const res = await join();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Conference');
  });

  it('a missing or malformed CallSid is not stamped', async () => {
    await join(REP_FROM, null);
    await join(REP_FROM, "CA'; drop table users;--");
    expect(state.updates).toEqual([]);
  });
});

describe('POST /telephony/twilio/dialer-conference-rejoin — the rep leg after its conference ended', () => {
  it('a rep with a live run goes straight back into their room, with the rejoin action again so the loop continues', async () => {
    const res = await rejoin();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('>pd_c9c459400f174c1ebb3ed084ba93eb86<');
    expect(res.body).toContain('endConferenceOnExit="true"');
    expect(res.body).toContain(REJOIN_ACTION);
    expect(res.body).not.toContain('waitUrl');
  });

  // Keyed on the LEG, not the rep. Nothing ever ends an abandoned PAUSED run, so
  // "does this rep have a live run?" can stay true for ever — and a finished
  // run's leg would loop back in, on hold music, with the Device busy.
  it('a leg recorded on a FINISHED run is hung up even though the rep has another live run', async () => {
    for (const status of ['done', 'stopped', 'ready']) {
      state.legSession = { status };
      state.liveSession = { id: 'an-abandoned-paused-run' };
      const res = await rejoin();
      expect(res.body).toContain('<Hangup');
      expect(res.body).not.toContain('<Conference');
    }
  });

  it('a leg recorded on a live run — active or paused — goes back in, and the rep-level lookup is never needed', async () => {
    for (const status of ['active', 'paused']) {
      state.sessionLookups = [];
      state.legSession = { status };
      state.liveSession = null;
      expect((await rejoin()).body).toContain('<Conference');
      expect(state.sessionLookups).toHaveLength(1);
      const bound = paramValues(state.sessionLookups[0]!.where).flat();
      expect(bound).toContain(REP_CALL_SID);
      expect(bound).toContain(REP_ID);
    }
  });

  // The stamp failed, or an older softphone joined a run that came up paused.
  it("a leg recorded on NO run falls back to the rep's own ACTIVE or PAUSED session — exactly those two", async () => {
    state.legSession = null;
    expect((await rejoin()).body).toContain('<Conference');
    expect(state.sessionLookups).toHaveLength(2);
    const bound = paramValues(state.sessionLookups[1]!.where).flat();
    expect(bound).toContain(REP_ID);
    expect(bound.filter((v) => ['active', 'paused', 'ready', 'done', 'stopped'].includes(v as string)).sort()).toEqual(['active', 'paused']);
  });

  it('keeps the rep\'s hold-music preference on the way back in', async () => {
    state.userRow = { dialerHoldMusic: false };
    expect((await rejoin()).body).toContain('waitUrl=""');
  });

  // The run ended (done / stopped) and the room was completed by the backstop:
  // looping back in would strand the leg on hold music with the Device busy.
  it('a rep with NO live run is hung up instead of being sent round again', async () => {
    state.legSession = null;
    state.liveSession = null;
    const res = await rejoin();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Hangup');
    expect(res.body).not.toContain('<Conference');
  });

  // A DB hiccup must never end a live run; the stranded-leg case needs a dead
  // client AS WELL, and the run-end backstop hangs the leg up by sid anyway.
  it('a failed session lookup sends the rep back in rather than dropping a live run', async () => {
    state.sessionLookupThrows = true;
    const res = await rejoin();
    expect(res.body).toContain('<Conference');
    expect(res.body).not.toContain('<Hangup');
  });

  // Twilio gives a webhook ~15s and then FAILS the call. A hung pool must cost the
  // rep a few seconds of silence, not their run.
  it('a session lookup that HANGS gives up and sends the rep back in', async () => {
    _setRejoinDbTimeoutForTests(30);
    state.sessionLookupHangs = true;
    const res = await rejoin();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Conference');
  });

  // A room that cannot be entered at all would otherwise spin: fail → action →
  // rejoin → fail, as fast as Twilio can ask, for as long as the run is live.
  it('a <Dial> that FAILED is not retried: the leg is hung up', async () => {
    const res = await rejoin({ DialCallStatus: 'failed' });
    expect(res.body).toContain('<Hangup');
    expect(res.body).not.toContain('<Conference');
    expect(state.sessionLookups).toEqual([]);
  });

  it('a hold-music lookup that HANGS falls back to music on, and still sends the rep back in', async () => {
    _setRejoinDbTimeoutForTests(30);
    state.userLookupHangs = true;
    const res = await rejoin();
    expect(res.body).toContain('<Conference');
    expect(res.body).not.toContain('waitUrl');
  });

  // Twilio requests the action when the rep hangs up too. The call is over:
  // nothing to rejoin, and no reason to touch the database.
  it('the rep hung up themselves (CallStatus=completed): empty response, no lookups', async () => {
    const res = await rejoin({ CallStatus: 'completed' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<Conference');
    expect(state.sessionLookups).toEqual([]);
    expect(state.lastFindFirst).toBeNull();
  });

  // The rep's leg is GONE and the run is still dialing: every human who answers
  // is bridged into an empty room. The softphone stops the run itself when it
  // can — but a closed tab or a dead network cannot, and this is the only place
  // the server ever hears that the leg ended. Pause, never stop: nothing is lost,
  // and a rep who comes back presses Resume.
  it('…and if that leg belonged to a run that is still ACTIVE, the run is paused so it stops dialing into an empty room', async () => {
    await rejoin({ CallStatus: 'completed' });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ status: 'paused' });
    const bound = paramValues(state.updates[0]!.where).flat();
    expect(bound).toContain(REP_ID);
    expect(bound).toContain(REP_CALL_SID); // THIS leg's run only — a leg already replaced pauses nothing
    expect(bound.filter((v) => ['active', 'paused', 'ready', 'done', 'stopped'].includes(v as string))).toEqual(['active']);
  });

  it('a failed pause still answers Twilio', async () => {
    state.updateThrows = true;
    const res = await rejoin({ CallStatus: 'completed' });
    expect(res.statusCode).toBe(200);
  });

  it('a completed call with no usable identity or sid pauses nothing', async () => {
    await rejoin({ CallStatus: 'completed', From: '+16195551234' });
    await rejoin({ CallStatus: 'completed', CallSid: 'nope' });
    expect(state.updates).toEqual([]);
  });

  it('a From that is not a rep identity is hung up and never queries', async () => {
    const res = await rejoin({ From: '+16195551234' });
    expect(res.body).toContain('<Hangup');
    expect(state.sessionLookups).toEqual([]);
  });

  it('rejects an unsigned request, validating against its OWN public URL', async () => {
    state.signatureValid = false;
    const res = await rejoin();
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('<Conference');
    expect(state.validatedUrls).toEqual(['https://api.test/telephony/twilio/dialer-conference-rejoin']);
    expect(state.sessionLookups).toEqual([]);
  });
});

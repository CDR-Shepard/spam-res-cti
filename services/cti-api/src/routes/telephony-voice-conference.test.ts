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
  liveSession: null as { id: string } | null,
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
            return state.userRow;
          },
        },
        dialerSessions: {
          findFirst: async (args: { where: unknown }) => {
            state.sessionLookups.push(args);
            if (state.sessionLookupThrows) throw new Error('pool exhausted');
            return state.liveSession;
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

import { registerTelephonyRoutes } from './telephony.js';

/** Bound parameter values inside a drizzle predicate — which id the query asked for. */
function paramValues(node: unknown, out: unknown[] = []): unknown[] {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => paramValues(n, out)); return out; }
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return paramValues(n.queryChunks, out);
  if ('value' in n && !Array.isArray(n.value)) out.push(n.value);
  return out;
}

const REP_ID = 'c9c45940-0f17-4c1e-bb3e-d084ba93eb86';
const REP_FROM = 'client:rep_c9c459400f174c1ebb3ed084ba93eb86';

let app: FastifyInstance;
beforeEach(async () => {
  state.userRow = { dialerHoldMusic: true };
  state.findFirstThrows = false;
  state.lastFindFirst = null;
  state.liveSession = { id: 'sess-1' };
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

const REP_CALL_SID = 'CA0123456789abcdef0123456789abcdef';
const REJOIN_ACTION = '<Dial action="https://api.test/telephony/twilio/dialer-conference-rejoin" method="POST">';

const join = (from = REP_FROM, callSid: string | null = REP_CALL_SID) =>
  app.inject({ method: 'POST', url: '/telephony/twilio/voice', payload: { DialerConference: '1', From: from, ...(callSid ? { CallSid: callSid } : {}) } });

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
  it("stamps the rep leg's CallSid on the rep's ACTIVE session only", async () => {
    await join();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.set).toMatchObject({ repCallSid: REP_CALL_SID });
    const bound = paramValues(state.updates[0]!.where);
    expect(bound).toContain(REP_ID);
    expect(bound).toContain('active');
    expect(bound).not.toContain('paused');
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

  it("looks for the rep's own ACTIVE or PAUSED session — a paused run still has its rep in the room", async () => {
    await rejoin();
    expect(state.sessionLookups).toHaveLength(1);
    const bound = paramValues(state.sessionLookups[0]!.where).flat();
    expect(bound).toContain(REP_ID);
    expect(bound).toContain('active');
    expect(bound).toContain('paused');
  });

  it('keeps the rep\'s hold-music preference on the way back in', async () => {
    state.userRow = { dialerHoldMusic: false };
    expect((await rejoin()).body).toContain('waitUrl=""');
  });

  // The run ended (done / stopped) and the room was completed by the backstop:
  // looping back in would strand the leg on hold music with the Device busy.
  it('a rep with NO live run is hung up instead of being sent round again', async () => {
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

  // Twilio requests the action when the rep hangs up too. The call is over:
  // nothing to rejoin, and no reason to touch the database.
  it('the rep hung up themselves (CallStatus=completed): empty response, no lookups', async () => {
    const res = await rejoin({ CallStatus: 'completed' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<Conference');
    expect(state.sessionLookups).toEqual([]);
    expect(state.lastFindFirst).toBeNull();
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

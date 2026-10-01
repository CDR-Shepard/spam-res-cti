/**
 * POST /telephony/twilio/status writes TRUE talk time to calls.talk_seconds
 * (telephony/talk-seconds.ts) and leaves calls.duration_seconds on its old
 * last-write rule — the reputation engine reads that one. applyTalkSeconds is
 * replaced by a recorder (its SQL is pinned in talk-seconds.test.ts); the
 * rule itself runs for real. Harness idiom: telephony-status-ack.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  call: null as null | { id: string; orgId: string; fromNumber: string | null },
  sets: [] as Array<Record<string, unknown>>,
  talk: [] as Array<{ callId: string; write: unknown }>,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ API_PUBLIC_URL: 'https://api.test', TWILIO_SKIP_SIGNATURE_CHECK: true }),
}));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({
    name: 'twilio',
    validateWebhook: () => ({ valid: true }),
    normalizeWebhook: (b: Record<string, unknown>) => {
      const raw = b.CallDuration ?? b.DialCallDuration;
      return {
        providerCallId: String(b.CallSid),
        status: 'completed',
        rawStatus: String(b.CallStatus ?? b.DialCallStatus ?? ''),
        durationSeconds: raw === undefined ? undefined : Number(raw),
        raw: b,
      };
    },
  }),
}));
vi.mock('../telephony/talk-seconds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telephony/talk-seconds.js')>()),
  applyTalkSeconds: async (_db: unknown, callId: string, write: unknown) => {
    state.talk.push({ callId, write });
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
      insert: () => ({ values: async () => {} }),
      query: { calls: { findFirst: async () => state.call } },
      update: () => ({
        set: (v: Record<string, unknown>) => {
          state.sets.push(v);
          return { where: async () => {} };
        },
      }),
    }),
  };
});

import { registerTelephonyRoutes } from './telephony.js';

const PARENT = `CA${'a'.repeat(32)}`;
const CHILD = `CA${'b'.repeat(32)}`;
const CALL = { id: 'call-1', orgId: 'org-1', fromNumber: null };

let app: FastifyInstance;
beforeEach(async () => {
  state.call = CALL;
  state.sets = [];
  state.talk = [];
  app = Fastify();
  await registerTelephonyRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const post = (payload: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/telephony/twilio/status', payload });
const callUpdate = () => state.sets.find((s) => 'status' in s);

describe('POST /telephony/twilio/status — true talk time', () => {
  it('a <Dial action> for an unanswered dial writes talk time 0', async () => {
    const res = await post({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'no-answer', DialCallDuration: '0' });
    expect(res.statusCode).toBe(200);
    expect(state.talk).toEqual([{ callId: 'call-1', write: { mode: 'set', seconds: 0 } }]);
  });

  it('a connected <Dial action> writes DialCallDuration', async () => {
    await post({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '37' });
    expect(state.talk).toEqual([{ callId: 'call-1', write: { mode: 'set', seconds: 37 } }]);
  });

  it("the dialed leg's own callback (correlated by ParentCallSid) writes its CallDuration only if unset", async () => {
    await post({ CallSid: CHILD, ParentCallSid: PARENT, CallStatus: 'completed', CallDuration: '41' });
    expect(state.talk).toEqual([{ callId: 'call-1', write: { mode: 'if_unset', seconds: 41 } }]);
  });

  it("the rep leg's own completed callback writes NO talk time — and durationSeconds keeps its old rule (reputation reads it)", async () => {
    await post({ CallSid: PARENT, CallStatus: 'completed', CallDuration: '58' });
    expect(state.talk).toEqual([]);
    expect(callUpdate()).toMatchObject({ durationSeconds: 58 });
  });

  it('a callback that matches no call row writes no talk time', async () => {
    state.call = null;
    await post({ CallSid: PARENT, CallStatus: 'in-progress', DialCallStatus: 'completed', DialCallDuration: '37' });
    expect(state.talk).toEqual([]);
  });
});

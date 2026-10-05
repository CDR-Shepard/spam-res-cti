/**
 * A seller calling BACK an AI-pool number (the AI's voicemail states it) must
 * reach a person: the hand-off user of the newest AI call to them; with none,
 * voicemail — the dialer-pool fallback. Never a crash on the new kind, and the
 * dialer's sticky / last-dialer lookups are never consulted for an AI number.
 * Harness: inbound.test.ts (Fastify + fake DB by table, form-encoded body).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const AI_DID = '+16197244374';
const CALLER = '+13105550002';

const state = vi.hoisted(() => ({
  owned: null as Record<string, unknown> | null,
  aiRep: null as string | null,
  aiRepThrows: false,
  aiCallbackRep: vi.fn(),
  stickyAgentForCaller: vi.fn(async () => 'dialer-rep'),
  lastDialerForCaller: vi.fn(async () => 'dialer-rep'),
  callValues: [] as Record<string, unknown>[],
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({
    API_PUBLIC_URL: 'https://api.example.com',
    TELEPHONY_PROVIDER: 'twilio',
    TWILIO_SKIP_SIGNATURE_CHECK: true,
    TWILIO_RECORD_CALLS: false,
    TWILIO_AUTH_TOKEN: undefined,
  }),
}));
vi.mock('../salesforce/client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../salesforce/client.js')>()),
  findByPhone: async () => null,
  findPrimaryOpenOpportunityId: async () => null,
}));
vi.mock('../dialer/sticky.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/sticky.js')>()),
  stickyAgentForCaller: state.stickyAgentForCaller,
  lastDialerForCaller: state.lastDialerForCaller,
}));
vi.mock('../ai-voice/number-pool.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai-voice/number-pool.js')>()),
  aiCallbackRep: state.aiCallbackRep,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        outboundNumbers: { findFirst: async () => state.owned },
        users: { findFirst: async () => ({ id: 'org-fallback', noAnswerForwardE164: null }) },
        salesforceConnections: { findFirst: async () => null },
        calls: { findFirst: async () => null },
      },
      insert(table: unknown) {
        const isCall = table === actual.schema.calls;
        return {
          values(v: Record<string, unknown>) {
            if (isCall) state.callValues.push(v);
            const returning = async () => [{ id: 'call-db-1', ...v }];
            return { returning, onConflictDoNothing: () => ({ returning }) };
          },
        };
      },
      update: () => ({ set: () => ({ where: async () => {} }) }),
    }),
  };
});

import { registerInboundRoutes } from './inbound.js';

const OWNED = {
  id: 'num-ai', orgId: 'org-1', e164: AI_DID, provider: 'twilio', kind: 'ai_pool', inboundEnabled: true,
  inboundGreeting: null, inboundMatchedGreeting: null, inboundRecordSeconds: 60, inboundTranscribe: false,
  inboundForwardToE164: null, assignedUserId: null,
};

let app: FastifyInstance;
beforeEach(async () => {
  state.owned = { ...OWNED };
  state.aiRep = null;
  state.aiRepThrows = false;
  state.aiCallbackRep.mockReset().mockImplementation(async () => {
    if (state.aiRepThrows) throw new Error('pool exhausted');
    return state.aiRep;
  });
  state.stickyAgentForCaller.mockClear();
  state.lastDialerForCaller.mockClear();
  state.callValues = [];
  app = Fastify();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = body as string;
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  await registerInboundRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const ring = () =>
  app.inject({
    method: 'POST',
    url: '/telephony/twilio/inbound',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ From: CALLER, To: AI_DID, CallSid: 'CA_ai_1' }).toString(),
  });

describe('POST /telephony/twilio/inbound — a callback to an ai_pool number', () => {
  it("rings the AI call's hand-off user and attributes the call to them", async () => {
    state.aiRep = 'rep-owner';
    const res = await ring();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Client>rep_repowner</Client>');
    expect(res.body).toContain(`callerId="${CALLER}"`); // the rep sees the seller, not the AI number
    expect(state.callValues[0]!.userId).toBe('rep-owner');
    expect(state.aiCallbackRep).toHaveBeenCalledWith(expect.anything(), 'org-1', CALLER, AI_DID);
    // The dialer's routing never applies to an AI number.
    expect(state.stickyAgentForCaller).not.toHaveBeenCalled();
    expect(state.lastDialerForCaller).not.toHaveBeenCalled();
  });

  it('no AI call to them → voicemail (the dialer-pool fallback), attributed to the org fallback user', async () => {
    const res = await ring();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Record');
    expect(res.body).not.toContain('<Client');
    expect(state.callValues[0]!.userId).toBe('org-fallback');
  });

  it('the lookup throwing still answers the caller (voicemail, no 500)', async () => {
    state.aiRepThrows = true;
    const res = await ring();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Record');
  });
});

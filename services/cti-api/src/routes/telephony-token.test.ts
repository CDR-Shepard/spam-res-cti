import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const state = vi.hoisted(() => ({
  lastReq: null as Record<string, unknown> | null,
  tokenError: null as Error | null,
}));
// registerTelephonyRoutes calls loadConfig() at module scope (used lazily by
// other routes in the file, e.g. the Twilio webhook signature check); neither
// route under test here needs a real value, so mock it the way
// admin-team.test.ts does to avoid real env-var parsing in tests.
vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../auth/session.js', () => ({ resolveSession: async () => ({ userId: 'aaaa-bbbb', orgId: 'o', email: 'e', isAdmin: false, powerDialerEnabled: false }) }));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({
    createClientToken: async (req: Record<string, unknown>) => {
      state.lastReq = req;
      if (state.tokenError) throw state.tokenError;
      return { token: 't', identity: req.identity, provider: 'twilio', expiresAt: 'x' };
    },
    validateWebhook: () => ({ valid: true }),
  }),
}));
import { registerTelephonyRoutes } from './telephony.js';

describe('POST /telephony/token platform', () => {
  beforeEach(() => { state.lastReq = null; state.tokenError = null; });
  async function app() { const f = Fastify(); await registerTelephonyRoutes(f); return f; }
  it('forwards platform=ios', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' }, payload: { platform: 'ios' } });
    expect(res.statusCode).toBe(200);
    expect(state.lastReq).toMatchObject({ platform: 'ios', identity: 'rep_aaaabbbb' });
  });
  it('defaults to no platform for the web softphone (empty body)', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' } });
    expect(res.statusCode).toBe(200);
    expect(state.lastReq?.platform).toBeUndefined();
  });
  it('rejects an unknown platform', async () => {
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' }, payload: { platform: 'android' } });
    expect(res.statusCode).toBe(400);
  });

  // A mint that throws is 503 with the provider's own message — the one that
  // actually happens is the missing iOS VoIP push credential, and it is the
  // difference between an iPhone that rings and one that never registers. The
  // message has to survive: it names the environment variable to set, and it
  // is the only thing an operator sees (the phone logs it and moves on).
  it('answers 503 with the provider message when a token cannot be minted', async () => {
    state.tokenError = new Error('TWILIO_IOS_PUSH_CREDENTIAL_SID is not configured — iOS clients cannot register for VoIP push');
    const f = await app();
    const res = await f.inject({ method: 'POST', url: '/telephony/token', headers: { authorization: 'Bearer s' }, payload: { platform: 'ios' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'TWILIO_IOS_PUSH_CREDENTIAL_SID is not configured — iOS clients cannot register for VoIP push' });
  });
});

/**
 * Route-level tests for GET/PATCH /auth/me — the rep's own settings. The
 * PATCH is a partial update: a hold-music-only body must never touch the
 * no-answer forwarding number (and vice versa), because wiping the failover
 * number silently stops inbound callbacks rolling to the rep's cell.
 * Harness idiom: routes/admin-team.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  authedUser: null as {
    userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean;
  } | null,
  userRow: null as { noAnswerForwardE164: string | null; dialerHoldMusic: boolean } | null,
  lastUpdateSet: null as unknown,
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../salesforce/oauth.js', () => ({
  buildStartArtifacts: () => { throw new Error('unused in this test'); },
  exchangeCodeForTokens: async () => { throw new Error('unused in this test'); },
  fetchProfileName: async () => null,
  fetchProfilePhoto: async () => null,
  fetchUserInfo: async () => null,
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.authedUser,
}));
vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return {
    ...actual,
    getDb: () => ({
      query: {
        users: { findFirst: async () => state.userRow },
        salesforceConnections: { findFirst: async () => null },
        outboundNumbers: { findFirst: async () => null },
      },
      update: (_table: unknown) => ({
        set: (values: unknown) => {
          state.lastUpdateSet = values;
          return { where: async (_w: unknown) => undefined };
        },
      }),
    }),
  };
});

import { registerAuthRoutes } from './auth.js';

const rep = { userId: 'u1', orgId: 'o1', email: 'rep@x.com', isAdmin: false, powerDialerEnabled: true };

let app: FastifyInstance;
beforeEach(async () => {
  state.authedUser = rep;
  state.userRow = { noAnswerForwardE164: '+16195550100', dialerHoldMusic: true };
  state.lastUpdateSet = null;
  app = Fastify();
  await registerAuthRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const patch = (payload: unknown) => app.inject({ method: 'PATCH', url: '/auth/me', payload: payload as Record<string, unknown> });

describe('PATCH /auth/me — partial updates', () => {
  it('a hold-music-only body writes dialerHoldMusic and nothing else (the forwarding number survives)', async () => {
    const res = await patch({ dialerHoldMusic: false });
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ dialerHoldMusic: false });
    expect(res.json()).toEqual({ ok: true, dialerHoldMusic: false });
  });

  it('a forwarding-only body writes the normalized number and nothing else (hold music survives)', async () => {
    const res = await patch({ noAnswerForwardE164: '619-555-0100' });
    expect(res.statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ noAnswerForwardE164: '+16195550100' });
  });

  it('clearing the forwarding number writes null for it only', async () => {
    expect((await patch({ noAnswerForwardE164: null })).statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ noAnswerForwardE164: null });
  });

  it('both fields at once are written together', async () => {
    expect((await patch({ noAnswerForwardE164: null, dialerHoldMusic: true })).statusCode).toBe(200);
    expect(state.lastUpdateSet).toEqual({ noAnswerForwardE164: null, dialerHoldMusic: true });
  });

  it('an empty body is 400 and writes nothing', async () => {
    expect((await patch({})).statusCode).toBe(400);
    expect(state.lastUpdateSet).toBeNull();
  });

  it('401 without a session, and nothing is written', async () => {
    state.authedUser = null;
    expect((await patch({ dialerHoldMusic: false })).statusCode).toBe(401);
    expect(state.lastUpdateSet).toBeNull();
  });
});

describe('GET /auth/me', () => {
  it('returns the hold-music preference, and defaults it to on when the profile row is missing', async () => {
    state.userRow = { noAnswerForwardE164: null, dialerHoldMusic: false };
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).json().user.dialerHoldMusic).toBe(false);
    state.userRow = null;
    expect((await app.inject({ method: 'GET', url: '/auth/me' })).json().user.dialerHoldMusic).toBe(true);
  });
});

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
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({ API_PUBLIC_URL: 'https://api.test', TWILIO_SKIP_SIGNATURE_CHECK: true }),
}));
vi.mock('../telephony/index.js', () => ({
  getProvider: () => ({ validateWebhook: () => ({ valid: true }) }),
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
      },
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
  app = Fastify();
  await registerTelephonyRoutes(app);
  await app.ready();
});
afterEach(async () => { await app.close(); });

const join = (from = REP_FROM) =>
  app.inject({ method: 'POST', url: '/telephony/twilio/voice', payload: { DialerConference: '1', From: from } });

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
  });
});

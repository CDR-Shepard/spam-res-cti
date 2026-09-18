/**
 * Route-level test of GET /auth/salesforce/callback — specifically the two
 * fire-and-forget hooks that run after a sign-in is committed.
 *
 * Both hooks (starter numbers, CTI permission set) are unit-tested through
 * extracted helpers, but the `void …` lines that CALL them had no coverage at
 * all: deleting either one passed the entire suite, and the feature would have
 * been gone with nothing red anywhere. This drives the real route against a fake
 * DB and a mocked Salesforce, following admin-team.test.ts's harness idiom
 * (hoisted `state`, `vi.mock` at the module boundary, Fastify + register).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  stateRow: null as Record<string, unknown> | null,
  existingConnection: null as Record<string, unknown> | null,
  users: [] as Array<Record<string, unknown>>,
  org: { id: 'org-1', sfOrgId: '00D000000000001' } as Record<string, unknown> | null,
  profileName: 'Sales' as string | null,
  profileLookups: 0,
  assignCalls: [] as Array<{ orgId: string; userId: string; email: string }>,
  permissionCalls: [] as Array<{ orgId: string; targetUserId: string }>,
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock('../config.js', () => ({
  loadConfig: () => ({
    NODE_ENV: 'test',
    SALESFORCE_ALLOWED_ORG_ID: undefined,
    SALESFORCE_ADMIN_PROFILES: 'System Administrator',
    STARTER_NUMBER_PROFILES: 'Sales',
  }),
}));

vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  encryptString: (s: string) => `enc:${s}`,
}));

vi.mock('../salesforce/oauth.js', () => ({
  buildStartArtifacts: () => { throw new Error('not used'); },
  exchangeCodeForTokens: async () => ({
    access_token: 'at', refresh_token: 'rt', instance_url: 'https://x.my.salesforce.com',
    sfUserId: '005NEW', sfOrgId: '00D000000000001', scope: 'api',
  }),
  fetchUserInfo: async () => ({ name: 'Hudson Lammatao', email: 'Hudson@SJOInvestments.com' }),
  fetchProfilePhoto: async () => null,
  fetchProfileName: async () => { state.profileLookups++; return state.profileName; },
}));

// The two live hooks. Spied, so this file asserts the WIRING; their behaviour is
// covered in fleet/auto-assign*.test.ts and salesforce/permission-set*.test.ts.
vi.mock('../fleet/auto-assign-live.js', () => ({
  assignStarterNumbersLive: async (who: { orgId: string; userId: string; email: string }) => {
    state.assignCalls.push(who);
    return { status: 'assigned', la: [], sd: [], shortLa: 0, shortSd: 0 };
  },
}));
vi.mock('../salesforce/permission-set-live.js', () => ({
  ensureCtiPermissionSetLive: async (a: { orgId: string; targetUserId: string }) => {
    state.permissionCalls.push(a);
    return { status: 'assigned' };
  },
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  const chain = (result: unknown) => {
    const p: Record<string, unknown> = {
      set: () => p, where: () => p, values: (v: Record<string, unknown>) => { state.inserted.push(v); return p; },
      returning: async () => {
        const v = state.inserted[state.inserted.length - 1]!;
        const row = { id: 'user-new', isAdmin: false, powerDialerEnabled: false, ...v };
        state.users.push(row);
        return [row];
      },
      then: (ok: (x: unknown) => unknown) => Promise.resolve(result).then(ok),
    };
    return p;
  };
  return {
    ...actual,
    getDb: () => ({
      query: {
        salesforceOauthState: { findFirst: async () => state.stateRow },
        salesforceConnections: { findFirst: async () => state.existingConnection },
        organizations: { findFirst: async () => state.org },
        users: {
          // Both hooks look the user up by id after the sign-in; the login branch
          // looks them up by email before it. Either way: whoever is in `users`.
          findFirst: async () => state.users[state.users.length - 1],
        },
      },
      insert: () => chain(undefined),
      update: () => chain(undefined),
    }) as unknown as ReturnType<typeof actual.getDb>,
  };
});

import { registerAuthRoutes } from './auth.js';

let app: FastifyInstance;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const callback = () => app.inject({ method: 'GET', url: '/auth/salesforce/callback?code=abc&state=st-1' });

beforeEach(async () => {
  state.stateRow = { state: 'st-1', userId: 'user-1', pkceVerifier: 'v', consumedAt: null, expiresAt: new Date(Date.now() + 60_000) };
  state.existingConnection = null;
  state.users = [{ id: 'user-1', orgId: 'org-1', email: 'hudson@sjoinvestments.com', isAdmin: false, powerDialerEnabled: true }];
  state.org = { id: 'org-1', sfOrgId: '00D000000000001' };
  state.profileName = 'Sales';
  state.profileLookups = 0;
  state.assignCalls = [];
  state.permissionCalls = [];
  state.inserted = [];
  app = Fastify();
  await registerAuthRoutes(app);
});
afterEach(async () => { await app.close(); });

describe('GET /auth/salesforce/callback — post-sign-in hooks are actually wired', () => {
  it('claims starter numbers for a rep who connects Salesforce', async () => {
    const res = await callback();
    await flush();
    expect(res.statusCode).toBe(200);
    expect(state.assignCalls).toEqual([
      { orgId: 'org-1', userId: 'user-1', email: 'hudson@sjoinvestments.com' },
    ]);
  });

  it('grants the CTI permission set for a rep who is switched on', async () => {
    await callback();
    await flush();
    expect(state.permissionCalls).toEqual([{ orgId: 'org-1', targetUserId: 'user-1' }]);
  });

  // Anyone in the org can open the app once; only reps cost the reserve numbers.
  it('does NOT claim numbers for a non-rep profile — but still signs them in', async () => {
    state.profileName = 'Accounting';
    const res = await callback();
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Salesforce connected');
    expect(state.assignCalls).toEqual([]);
  });

  // Connect mode never resolved the profile for an admin check, so the hook has
  // to fetch it itself or every connect-mode rep is wrongly skipped.
  it('looks the profile up itself in connect mode', async () => {
    await callback();
    await flush();
    expect(state.profileLookups).toBe(1);
  });

  it('login mode: a brand-new rep gets numbers under their NEW user id, reusing the profile already fetched', async () => {
    state.stateRow = { ...state.stateRow!, userId: null };
    state.users = [];
    const res = await callback();
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Signed in with Salesforce');
    // Email is lowercased off the Salesforce userinfo — the key numbers attach to.
    expect(state.assignCalls).toEqual([
      { orgId: 'org-1', userId: 'user-new', email: 'hudson@sjoinvestments.com' },
    ]);
    // Fetched once for the admin check and reused, not fetched again by the hook.
    expect(state.profileLookups).toBe(1);
  });

  // undefined ("never looked up") and null ("looked up, unknown") are different
  // facts. Login mode already tried; a second attempt would be wasted, and
  // treating the failure as eligible would fail OPEN.
  it('login mode: a failed profile lookup is NOT retried and does NOT claim numbers', async () => {
    state.stateRow = { ...state.stateRow!, userId: null };
    state.users = [];
    state.profileName = null;
    const res = await callback();
    await flush();
    expect(res.statusCode).toBe(200);
    expect(state.profileLookups).toBe(1);
    expect(state.assignCalls).toEqual([]);
  });

  // The hooks are fire-and-forget precisely so they cannot do this.
  it('still completes the sign-in when a hook blows up', async () => {
    state.users = [];
    state.stateRow = { ...state.stateRow!, userId: 'ghost' };
    const res = await callback();
    await flush();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Salesforce connected');
  });
});

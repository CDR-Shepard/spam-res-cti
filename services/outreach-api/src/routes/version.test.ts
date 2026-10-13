import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AppVersion } from '@cti/contracts';
import { buildApp } from '../app.js';
import { fakeDb, testConfig } from '../test/harness.js';
import { registerVersionRoutes } from './version.js';

const state = vi.hoisted(() => ({ session: null as Record<string, unknown> | null }));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

const ORG = { id: 'O1', name: 'GG Homes', slug: 'gg-homes', status: 'active', timezone: 'America/Los_Angeles', workosOrgId: null };
const rep = { userId: 'U-REP', orgId: 'O1', email: 'rep@gg.co', isAdmin: false, powerDialerEnabled: false, kind: 'human', isSuperAdmin: false };
const BUILD = { commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' };
const auth = { authorization: 'Bearer t' };

let app: FastifyInstance;
async function build(calls: () => Promise<{ commit: string } | null>) {
  const { db } = fakeDb({ organizations: [ORG] });
  return buildApp({ cfg: testConfig(), build: BUILD, readiness: async () => ({ dbOk: true, jobsOk: true }), apiRoutes: [(scope) => registerVersionRoutes(scope, { db, build: BUILD, calls })] });
}
const get = () => app.inject({ method: 'GET', url: '/api/version', headers: auth });

beforeEach(() => { state.session = rep; });
afterEach(async () => { await app?.close(); });

describe('GET /api/version', () => {
  it('answers the app commit and start time, and the calls commit', async () => {
    app = await build(async () => ({ commit: '8a398bc' }));
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ app: { commit: '8a398bc', startedAt: '2026-10-13T21:41:00.000Z' }, calls: { commit: '8a398bc' } });
    expect(AppVersion.safeParse(body).success).toBe(true);
  });

  it('shows the two services on different commits when they are', async () => {
    app = await build(async () => ({ commit: '1234567' }));
    expect((await get()).json()).toMatchObject({ app: { commit: '8a398bc' }, calls: { commit: '1234567' } });
  });

  it('answers calls: null when cti-api cannot be reached, and still answers the app version', async () => {
    app = await build(async () => null);
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ app: BUILD, calls: null });
  });

  it('is calls: null, never an error, if the reader itself throws', async () => {
    app = await build(async () => { throw new Error('boom'); });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ app: BUILD, calls: null });
  });

  it('answers commits and a start time only: no secrets, nothing else', async () => {
    app = await build(async () => ({ commit: '8a398bc' }));
    const body = (await get()).json<{ app: object; calls: object }>();
    expect(Object.keys(body).sort()).toEqual(['app', 'calls']);
    expect(Object.keys(body.app).sort()).toEqual(['commit', 'startedAt']);
    expect(Object.keys(body.calls).sort()).toEqual(['commit']);
  });

  it('401 without a session, and asks cti-api nothing', async () => {
    const calls = vi.fn(async () => ({ commit: '8a398bc' }));
    app = await build(calls);
    state.session = null;
    const res = await get();
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(calls).not.toHaveBeenCalled();
  });

  it('is open to any signed-in member, not just admins', async () => {
    app = await build(async () => ({ commit: '8a398bc' }));
    state.session = { ...rep, isAdmin: false };
    expect((await get()).statusCode).toBe(200);
  });
});

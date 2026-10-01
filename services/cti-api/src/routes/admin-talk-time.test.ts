import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  session: null as null | { userId: string; orgId: string; isAdmin: boolean },
}));
vi.mock('@cti/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/auth')>()),
  resolveSession: async () => state.session,
}));

import { registerAdminTalkTimeRoutes, type TalkTimeRouteDeps } from './admin-talk-time.js';

const NOW = new Date('2026-10-01T18:00:00Z');
const REPORT = { from: '2026-10-01', to: '2026-10-01', timezone: 'America/Los_Angeles', reps: [], totals: { talkSeconds: 0, connectedCalls: 0, dialerSeconds: 0 } };

let app: FastifyInstance;
let load: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  state.session = { userId: 'admin-1', orgId: 'org-1', isAdmin: true };
  load = vi.fn(async () => REPORT);
  app = Fastify();
  await registerAdminTalkTimeRoutes(app, { load: load as unknown as TalkTimeRouteDeps['load'], now: () => NOW });
  await app.ready();
});
afterEach(async () => { await app.close(); });

const get = (qs: string) => app.inject({ method: 'GET', url: `/admin/talk-time${qs}`, headers: { authorization: 'Bearer t' } });

describe('GET /admin/talk-time', () => {
  it('401 without a session', async () => {
    state.session = null;
    expect((await get('?from=2026-10-01&to=2026-10-01')).statusCode).toBe(401);
    expect(load).not.toHaveBeenCalled();
  });

  it('403 for a rep who is not an admin', async () => {
    state.session = { userId: 'rep-1', orgId: 'org-1', isAdmin: false };
    expect((await get('?from=2026-10-01&to=2026-10-01')).statusCode).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it('400 for a bad, reversed or too-long range', async () => {
    for (const qs of ['', '?from=2026-10-01', '?from=10/01/2026&to=2026-10-01', '?from=2026-10-02&to=2026-10-01', '?from=2026-01-01&to=2026-12-31']) {
      const res = await get(qs);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toHaveProperty('error');
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("returns the report for the admin's own org", async () => {
    const res = await get('?from=2026-09-28&to=2026-10-01');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPORT);
    expect(load).toHaveBeenCalledWith('org-1', expect.objectContaining({ from: '2026-09-28', to: '2026-10-01' }), NOW);
  });
});

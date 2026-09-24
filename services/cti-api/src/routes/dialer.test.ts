import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// Mocks for the GET /dialer/sessions/:id — listContext harness below. Mirrors
// the convention `routes/dialer-handoffs.test.ts` and `routes/auth-me.test.ts`
// use for this same route file: `@cti/auth`/`@cti/db` mocked, `state` hoisted
// so the `vi.mock(...)` factories (which run before these top-level `const`s)
// can close over it.
// ---------------------------------------------------------------------------
const state = vi.hoisted(() => ({
  authedUser: null as {
    userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean;
  } | null,
  session: null as Record<string, unknown> | null,
  items: [] as Array<Record<string, unknown>>,
  jobs: [] as Array<Record<string, unknown>>,
  // What `listStartPosition`'s grouped join "returns" — see the fake `select`
  // chain below. Set to rows that WOULD leak into `workedBy` if the join ever
  // ran when it shouldn't (the active-session test relies on this).
  positionRows: [] as Array<{ position: number | null; userId: string; name: string | null }>,
}));

vi.mock('../config.js', () => ({ loadConfig: () => ({}) }));

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
        dialerSessions: { findFirst: async () => state.session },
        dialerQueueItems: { findMany: async () => state.items },
        followupRolloverJobs: { findMany: async () => state.jobs },
      },
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      // The ONLY thing `listStartPosition`'s grouped join touches. Ignoring
      // `where`'s argument is fine here — that condition is pinned directly,
      // with real SQL rendering, in `dialer/list-position.test.ts`; this
      // harness only needs to prove WHETHER and WHEN the route reaches it.
      select: () => {
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          groupBy: () => Promise.resolve(state.positionRows),
        };
        return chain;
      },
    }),
  };
});

// The REAL schema the route parses with — imported, never mirrored. A local copy
// pinned a contract the route had already moved past ('Task' runs were missing).
import { StartBody, registerDialerRoutes } from './dialer.js';

describe('POST /dialer/sessions body validation', () => {
  it('accepts a Lead/Opportunity/Task list of SF ids and rejects junk', () => {
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['00Q000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Opportunity', recordIds: ['006000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Task', recordIds: ['00T000000000001'] }).success).toBe(true);
    expect(StartBody.safeParse({ objectType: 'Account', recordIds: ['00Q000000000001'] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: [] }).success).toBe(false);
  });

  it('rejects a right-length id that is not a Salesforce id shape', () => {
    // Length alone let punctuation through into a SOQL id list.
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['!!!!!!!!!!!!!!!'] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ["00Q0000000000'1"] }).success).toBe(false);
    expect(StartBody.safeParse({ objectType: 'Lead', recordIds: ['00Q1'] }).success).toBe(false);
  });
});

/**
 * Two reps, one list (spec §4): `listContext` on the session-poll route.
 * `listContextFor` itself (the total/startedFrom/workedBy arithmetic, the
 * ready-only gating, the self-exclusion-by-id, the fail-open) is pinned
 * exhaustively in `dialer/list-position.test.ts` — this harness exists only to
 * prove the ROUTE wires it up: the right session/items/requesting-user reach
 * it, and the field lands in the JSON response under the right key.
 */
describe('GET /dialer/sessions/:id — listContext', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.jobs = [];
    state.positionRows = [];
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const get = (id: string) => app.inject({ method: 'GET', url: `/dialer/sessions/${id}`, headers: { authorization: 'Bearer t' } });

  it('a rotated, ready session: total/startedFrom from its own rows, workedBy excludes the requesting rep by id', async () => {
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'ready', listViewId: 'L1' };
    state.items = [
      { attempt: 1, ordinal: 0, listPosition: 87, status: 'pending' },
      { attempt: 1, ordinal: 1, listPosition: 88, status: 'pending' },
      { attempt: 1, ordinal: 2, listPosition: 0, status: 'pending' },
    ];
    // Two reps dialed this list in the window; the requester (U-ME) is one of
    // them and must not appear in the confirm line naming "the OTHER rep".
    state.positionRows = [
      { position: 87, userId: 'U-GARRETT', name: 'Garrett' },
      { position: 42, userId: 'U-ME', name: 'Me' },
    ];

    const res = await get('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json().listContext).toEqual({ total: 3, startedFrom: 87, workedBy: ['Garrett'] });
  });

  it('a session with no list view: listContext is null', async () => {
    state.session = { id: 'S2', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null };
    state.items = [{ attempt: 1, ordinal: 0, listPosition: null, status: 'pending' }];

    const res = await get('S2');
    expect(res.statusCode).toBe(200);
    expect(res.json().listContext).toBeNull();
  });

  /**
   * The controller decision this test exists to enforce: the panel polls this
   * route every 1-2s for the life of a run, and the grouped join is org-wide
   * across every session on the list view. `positionRows` is seeded with a
   * result that WOULD show up in `workedBy` if the join ran — proving the
   * route really skips it for a non-'ready' status, not just that it happens
   * to come back empty.
   */
  it('an active session never runs the shared-position join: workedBy is empty even though a result is "available"', async () => {
    state.session = { id: 'S3', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: 'L1' };
    state.items = [{ attempt: 1, ordinal: 0, listPosition: 2, status: 'dialing' }];
    state.positionRows = [{ position: 99, userId: 'U-OTHER', name: 'Other Rep' }];

    const res = await get('S3');
    expect(res.statusCode).toBe(200);
    expect(res.json().listContext).toEqual({ total: 1, startedFrom: 2, workedBy: [] });
  });

  it('a session belonging to someone else 404s (ownership still gates listContext along with everything else)', async () => {
    state.session = null; // loadOwnedSession's scoped lookup finds nothing
    const res = await get('S-OTHER');
    expect(res.statusCode).toBe(404);
  });
});

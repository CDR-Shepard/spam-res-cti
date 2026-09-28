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
  takeCallbackResult: { action: 'paused', canceledItemId: null } as Record<string, unknown>,
  takeCallbackCalls: [] as string[],
  startCalls: [] as Array<{ sessionId: string; settings: unknown }>,
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
      // The ONLY thing `listStartPosition`'s two reads touch (I1: the frontier
      // lookup — `.orderBy().limit()` — and the workers lookup — `.groupBy()`).
      // Ignoring `where`'s argument is fine here — that condition, and the
      // ORDER BY itself, are pinned directly with real SQL rendering in
      // `dialer/list-position.test.ts`; this harness only needs to prove
      // WHETHER and WHEN the route reaches it. Neither query's `position`
      // value is asserted on by this file's tests (only `workedBy` and the
      // route's own `total`/`startedFrom`), so the frontier read just needs
      // to resolve non-empty whenever `positionRows` is non-empty.
      select: () => {
        const positions = state.positionRows.map((r) => r.position).filter((p): p is number => p != null);
        const chain = {
          from: () => chain,
          innerJoin: () => chain,
          where: () => chain,
          orderBy: () => chain,
          limit: () => Promise.resolve(positions.length ? [{ position: Math.max(...positions) }] : []),
          groupBy: () => Promise.resolve(state.positionRows.map((r) => ({ userId: r.userId, name: r.name }))),
        };
        return chain;
      },
    }),
  };
});

// The route is what this file pins; takeCallback itself is pinned in
// dialer/engine.test.ts. Every other engine function stays real.
vi.mock('../dialer/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dialer/engine.js')>()),
  takeCallback: async (sessionId: string) => {
    state.takeCallbackCalls.push(sessionId);
    return state.takeCallbackResult;
  },
  // The Start route's own job is parsing and forwarding the run settings;
  // what the engine does with them is pinned in dialer/engine.test.ts.
  startSession: async (sessionId: string, _deps: unknown, settings: unknown) => {
    state.startCalls.push({ sessionId, settings });
    return { action: 'dialing', itemId: 'i1' };
  },
}));

// The REAL schema the route parses with — imported, never mirrored. A local copy
// pinned a contract the route had already moved past ('Task' runs were missing).
import { RunSettingsBody, StartBody, parseRunSettings, registerDialerRoutes } from './dialer.js';

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

  it('firstPassTotal excludes a redial copy — Task 11 fix-round-1 Minor: a rep-requested Redial is not part of the queue creation built, same as an attempt-2 retry', async () => {
    state.session = { id: 'S5', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null };
    state.items = [
      { attempt: 1, ordinal: 0, listPosition: null, status: 'done' },
      // The redial copy: attempt 1 (it is not a no-answer retry), but `redialOf`
      // set — must not inflate the start-of-run count the rep sees.
      { attempt: 1, ordinal: 0, listPosition: null, status: 'pending', redialOf: 'i0' },
    ];

    const res = await get('S5');
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPassTotal).toBe(1);
  });

  it("firstPassTotal counts ordinals, not rows: a take-callback requeue copy shares its original's ordinal and never inflates it", async () => {
    state.session = { id: 'S6', orgId: 'O1', userId: 'U-ME', status: 'paused', listViewId: null };
    state.items = [
      { attempt: 1, ordinal: 0, listPosition: null, status: 'done' },
      // Cancelled to take a callback, and its requeued copy at the same ordinal.
      { attempt: 1, ordinal: 1, listPosition: null, status: 'skipped', outcome: 'canceled' },
      { attempt: 1, ordinal: 1, listPosition: null, status: 'pending' },
    ];
    const res = await get('S6');
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPassTotal).toBe(2);
  });

  // Review R2 (re-review, ruling: fix it): M1 made firstPassTotal agree with
  // session.runSize for a limited run, but the web computes "dialing" as
  // firstPassTotal minus the skip breakdown — and the settled-at-build rows
  // are still in that breakdown, so "first 100" showed "dialing 92" (and
  // could go negative). N comes ONLY from session.runSize now; firstPassTotal
  // reverts to the plain row-based count, limited run or not.
  it('firstPassTotal stays the row-based ordinal count, even for a limited run with settled-at-build rows in front of the cutoff', async () => {
    state.session = { id: 'S7', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, runSize: 2 };
    state.items = [
      { attempt: 1, ordinal: 0, listPosition: null, status: 'skipped', outcome: 'skip_on_dialer' },
      { attempt: 1, ordinal: 1, listPosition: null, status: 'pending' },
      { attempt: 1, ordinal: 2, listPosition: null, status: 'pending' },
    ];
    const res = await get('S7');
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPassTotal).toBe(3);
  });

  it("an unlimited run's firstPassTotal is unaffected either way: the row-based ordinal count", async () => {
    state.session = { id: 'S8', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, runSize: null };
    state.items = [
      { attempt: 1, ordinal: 0, listPosition: null, status: 'done' },
      { attempt: 1, ordinal: 1, listPosition: null, status: 'pending' },
    ];
    const res = await get('S8');
    expect(res.statusCode).toBe(200);
    expect(res.json().firstPassTotal).toBe(2);
  });

  // Review M1: currentItem.runPosition — the 1-based rank of the in-flight
  // item among rows this run will actually dial (ordinal <= current,
  // excluding rows settled at build), or null for an unlimited run.
  it('currentItem.runPosition ranks the in-flight item among dialable rows only, for a limited run', async () => {
    state.session = { id: 'S9', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, runSize: 100 };
    state.items = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `skip${i}`, attempt: 1, ordinal: i, listPosition: null, status: 'skipped', outcome: 'skip_on_dialer' })),
      { id: 'i5', attempt: 1, ordinal: 5, listPosition: null, status: 'done' },
      { id: 'i6', attempt: 1, ordinal: 6, listPosition: null, status: 'done' },
      { id: 'i7', attempt: 1, ordinal: 7, listPosition: null, status: 'dialing' },
    ];
    const res = await get('S9');
    expect(res.statusCode).toBe(200);
    // 5 build-time skips excluded; ordinals 5, 6, 7 are the 1st, 2nd, 3rd
    // dialable rows — the in-flight one (ordinal 7) is position 3.
    expect(res.json().currentItem).toMatchObject({ id: 'i7', runPosition: 3 });
  });

  it("currentItem.runPosition is null for an unlimited run", async () => {
    state.session = { id: 'S10', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, runSize: null };
    state.items = [{ id: 'i0', attempt: 1, ordinal: 0, listPosition: null, status: 'dialing' }];
    const res = await get('S10');
    expect(res.statusCode).toBe(200);
    expect(res.json().currentItem).toMatchObject({ id: 'i0', runPosition: null });
  });

  it('currentItem stays null when nothing is in flight, limited run or not', async () => {
    state.session = { id: 'S11', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, runSize: 5 };
    state.items = [{ id: 'i0', attempt: 1, ordinal: 0, listPosition: null, status: 'pending' }];
    const res = await get('S11');
    expect(res.statusCode).toBe(200);
    expect(res.json().currentItem).toBeNull();
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

/**
 * Task 11's new session controls. `redialCurrent`/`endCurrent` themselves —
 * the ordering (settle-before-hangup), the redial insert's fields, the
 * connected-only guard — are pinned exhaustively in `dialer/engine.test.ts`;
 * this harness only proves the ROUTE wires them up behind the same ownership
 * gate as `/next` (`requireOwnedSession`). Each scenario below picks a
 * non-`active` session status (or an empty queue) so the engine call resolves
 * without ever reaching `deps.db.transaction` or `deps.telephony` — neither of
 * which this file's minimal `@cti/db` mock or `buildEngineDeps()`'s real
 * `TwilioDialerTelephony` can serve in a unit test.
 */
describe('POST /dialer/sessions/:id/redial', () => {
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

  const post = (id: string) => app.inject({ method: 'POST', url: `/dialer/sessions/${id}/redial`, headers: { authorization: 'Bearer t' } });

  it('an owned session with nothing connected calls through to the engine (redialCurrent -> advanceSession)', async () => {
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'ready' };
    state.items = [];
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'idle' });
  });

  it('a session belonging to someone else 404s', async () => {
    state.session = null; // loadOwnedSession's scoped lookup finds nothing
    const res = await post('S-OTHER');
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /dialer/sessions/:id/end', () => {
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

  const post = (id: string) => app.inject({ method: 'POST', url: `/dialer/sessions/${id}/end`, headers: { authorization: 'Bearer t' } });

  it('an owned, non-active session calls through to the engine and reports its status (no-op guard)', async () => {
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'ready' };
    state.items = [];
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'ready' });
  });

  it('a session belonging to someone else 404s', async () => {
    state.session = null; // loadOwnedSession's scoped lookup finds nothing
    const res = await post('S-OTHER');
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /dialer/sessions/:id/take-callback', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'active' };
    state.takeCallbackCalls = [];
    state.takeCallbackResult = { action: 'paused', canceledItemId: 'i1' };
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const post = (id: string) => app.inject({ method: 'POST', url: `/dialer/sessions/${id}/take-callback`, headers: { authorization: 'Bearer t' } });

  it('pauses the owned run through the engine and reports what it cancelled', async () => {
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'paused', canceledItemId: 'i1' });
    expect(state.takeCallbackCalls).toEqual(['S1']);
  });

  it('409 { reason: "connected" } when a prospect is on the line — the softphone keys on exactly this', async () => {
    state.takeCallbackResult = { action: 'connected' };
    const res = await post('S1');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'You are talking to a prospect — finish that call first.', reason: 'connected' });
  });

  it('a run that already ended answers 200 with its status — there is nothing to pause', async () => {
    state.takeCallbackResult = { action: 'stopped' };
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'stopped' });
  });

  it("someone else's run 404s and never reaches the engine", async () => {
    state.session = null; // loadOwnedSession's scoped lookup finds nothing
    const res = await post('S-OTHER');
    expect(res.statusCode).toBe(404);
    expect(state.takeCallbackCalls).toEqual([]);
  });

  it('no session token → 401, never reaches the engine', async () => {
    state.authedUser = null;
    const res = await post('S1');
    expect(res.statusCode).toBe(401);
    expect(state.takeCallbackCalls).toEqual([]);
  });

  it('stays open to a rep whose power-dialer grant was revoked mid-run — a mid-run control, like pause', async () => {
    state.authedUser = { ...REP, powerDialerEnabled: false };
    const res = await post('S1');
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Run settings (spec docs/superpowers/specs/2026-09-28-run-settings-design.md):
// the Start body, validated at the boundary, and the session view the run line
// reads. The engine side (claim, trim, saved defaults) is pinned in
// dialer/engine.test.ts; this file proves the ROUTE parses and forwards.
// ---------------------------------------------------------------------------
describe('parseRunSettings', () => {
  it("no body is a tab from before run settings: null — today's run, nothing saved", () => {
    expect(parseRunSettings(undefined)).toEqual({ ok: true, settings: null });
    expect(parseRunSettings(null)).toEqual({ ok: true, settings: null });
  });

  it('a full body parses; maxRecords absent or null is the whole list', () => {
    expect(parseRunSettings({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 }))
      .toEqual({ ok: true, settings: { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 } });
    expect(parseRunSettings({ passes: 2, rolloverBusinessDays: 1 }))
      .toEqual({ ok: true, settings: { passes: 2, maxRecords: null, rolloverBusinessDays: 1 } });
    expect(parseRunSettings({ passes: 2, maxRecords: null, rolloverBusinessDays: 1 }))
      .toEqual({ ok: true, settings: { passes: 2, maxRecords: null, rolloverBusinessDays: 1 } });
    expect(parseRunSettings({ passes: 2, maxRecords: 500, rolloverBusinessDays: 1 }).ok).toBe(true);
  });

  it.each([
    // M3 (review, ruling: fix it): an EMPTY body (`{}`) is a NEW client that
    // sent a request but chose no settings — a bug on ITS end, never "no
    // settings at all" like a missing body/content-type is. It must 400 like
    // any other incomplete body, naming the first missing field.
    [{}, 'passes'],
    [{ passes: 3, rolloverBusinessDays: 1 }, 'passes'],
    [{ passes: '1', rolloverBusinessDays: 1 }, 'passes'],
    [{ rolloverBusinessDays: 1 }, 'passes'],
    [{ passes: 2, rolloverBusinessDays: 3 }, 'rolloverBusinessDays'],
    [{ passes: 2 }, 'rolloverBusinessDays'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: 0 }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: 1.5 }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: '100' }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecords: 501 }, 'maxRecords'],
    [{ passes: 2, rolloverBusinessDays: 1, maxRecord: 5 }, 'maxRecord'],
    [[1, 2], 'body'],
  ] as const)('%j is refused, naming %s', (body, field) => {
    expect(parseRunSettings(body)).toEqual({ ok: false, field });
  });

  it('RunSettingsBody is strict: an unknown key never starts a run with a default the rep did not pick', () => {
    expect(RunSettingsBody.safeParse({ passes: 1, rolloverBusinessDays: 2, extra: true }).success).toBe(false);
  });
});

describe('POST /dialer/sessions/:id/start — run settings', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'ready' };
    state.startCalls = [];
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  const start = (payload?: Record<string, unknown>) => app.inject({
    method: 'POST', url: '/dialer/sessions/S1/start', headers: { authorization: 'Bearer t' },
    ...(payload === undefined ? {} : { payload }),
  });

  it('forwards the chosen settings to the engine and answers with its result', async () => {
    const res = await start({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, action: 'dialing', itemId: 'i1' });
    expect(state.startCalls).toEqual([{ sessionId: 'S1', settings: { passes: 1, maxRecords: 100, rolloverBusinessDays: 2 } }]);
  });

  it("no body (a tab from before this release) starts today's run: settings null", async () => {
    expect((await start()).statusCode).toBe(200);
    expect(state.startCalls).toEqual([{ sessionId: 'S1', settings: null }]);
  });

  it('a bad value is a 400 naming the field, and nothing starts', async () => {
    const res = await start({ passes: 3, rolloverBusinessDays: 1 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Invalid passes', field: 'passes' });
    expect(state.startCalls).toEqual([]);
  });

  it('a rep without the grant is refused before the body is read (403), and nothing starts', async () => {
    state.authedUser = { ...REP, powerDialerEnabled: false };
    const res = await start({ passes: 3 });
    expect(res.statusCode).toBe(403);
    expect(state.startCalls).toEqual([]);
  });
});

describe('GET /dialer/sessions/:id — run settings', () => {
  const REP = { userId: 'U-ME', orgId: 'O1', email: 'me@x.com', isAdmin: false, powerDialerEnabled: true };
  let app: FastifyInstance;

  beforeEach(async () => {
    state.authedUser = REP;
    state.items = [];
    state.jobs = [];
    state.positionRows = [];
    app = Fastify();
    await registerDialerRoutes(app);
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it('exposes passes, maxRecords and rolloverBusinessDays on the session — what the run line reads', async () => {
    state.session = { id: 'S1', orgId: 'O1', userId: 'U-ME', status: 'active', listViewId: null, passes: 1, maxRecords: 100, rolloverBusinessDays: 2 };
    const res = await app.inject({ method: 'GET', url: '/dialer/sessions/S1', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toMatchObject({ passes: 1, maxRecords: 100, rolloverBusinessDays: 2 });
  });
});

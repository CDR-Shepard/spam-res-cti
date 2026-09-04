/**
 * Route-level (Fastify + fake-DB injection) tests for the admin "team" routes
 * — GET /admin/team (list org users incl. the power-dialer flag) and
 * PATCH /admin/team/:userId (flip it) — following dialer-handoffs.test.ts's
 * harness idiom (hoisted `state`, `vi.mock` of @cti/auth and
 * @cti/db, Fastify + registerAdminRoutes).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const state = vi.hoisted(() => ({
  authedUser: null as {
    userId: string; orgId: string; email: string; isAdmin: boolean; powerDialerEnabled: boolean;
  } | null,
  // Fixed fixture the fake `select().from(schema.users).where().orderBy()`
  // returns unconditionally (dialer-handoffs.test.ts convention: `where` is
  // NOT introspected for filtering, only recorded for assertion below).
  selectRows: [] as Array<{
    id: string; email: string; displayName: string | null; isAdmin: boolean; powerDialerEnabled: boolean;
  }>,
  // Configurable row array `update().set().where().returning()` resolves to
  // — an empty array simulates the UPDATE matching zero rows (target in
  // another org, or a target that doesn't exist).
  updateRows: [] as Array<{ id: string; powerDialerEnabled: boolean }>,
  lastSelectWhere: null as unknown,
  lastUpdateSet: null as unknown,
  lastUpdateWhere: null as unknown,
}));

// admin.ts imports loadConfig at module scope (used lazily inside a couple of
// its OTHER route handlers); neither route under test here calls it, but
// mock it anyway so importing admin.ts never risks touching real env-var
// parsing.
vi.mock('../config.js', () => ({
  loadConfig: () => ({}),
}));

vi.mock('@cti/auth', () => ({
  resolveSession: async (_bearer: string | undefined) => state.authedUser,
}));

vi.mock('@cti/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cti/db')>();
  return { ...actual, getDb: () => fakeDb() };
});

import { registerAdminRoutes } from './admin.js';

/**
 * Renders a drizzle `where` predicate to readable SQL-ish text so a test can
 * assert what the database was actually asked to match, rather than trusting
 * a JS-side check the database never saw. Copied VERBATIM from
 * src/routes/mobile.test.ts (~:72-90) — walks the same `queryChunks` shape
 * dialer-handoffs.test.ts introspects for its advisory-lock assertions: a
 * chunk is either a nested `SQL`, a literal `StringChunk` (`{ value: [...] }`),
 * a `Column` (has `.name` + `.table`), or a bound `Param` (`{ value }`).
 */
function renderPredicate(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderPredicate).join('');
  const n = node as Record<string, unknown>;
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(renderPredicate).join('');
  if (Array.isArray(n.value)) return (n.value as unknown[]).map(renderPredicate).join('');
  if (typeof n.name === 'string' && n.table) return n.name;
  if ('value' in n) return `<param>`;
  return '<?>';
}

/**
 * Just enough of the drizzle surface the two team routes touch:
 *  - `select({...}).from(schema.users).where(...).orderBy(...)` -> the fixed
 *    `state.selectRows` fixture, recording the `where` predicate for
 *    org-scoping assertions.
 *  - `update(schema.users).set(...).where(...).returning(...)` -> the
 *    configurable `state.updateRows`, recording both the `set` patch and the
 *    `where` predicate (the IDOR-proofing lives entirely in that predicate).
 */
function fakeDb() {
  return {
    select(_cols?: unknown) {
      return {
        from(_table: unknown) {
          return {
            where(where: unknown) {
              state.lastSelectWhere = where;
              return {
                orderBy: async (_col: unknown) => state.selectRows,
              };
            },
          };
        },
      };
    },
    update(_table: unknown) {
      return {
        set(setValues: Record<string, unknown>) {
          state.lastUpdateSet = setValues;
          return {
            where(where: unknown) {
              state.lastUpdateWhere = where;
              return {
                returning: async (_cols?: unknown) => state.updateRows,
              };
            },
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let app: FastifyInstance;

const admin = {
  userId: 'a1', orgId: 'o1', email: 'admin@x.com', isAdmin: true, powerDialerEnabled: false,
};
const TARGET_ID = '22222222-2222-2222-2222-222222222222';

beforeEach(async () => {
  state.authedUser = null;
  state.selectRows = [
    { id: 'rep-1', email: 'rep@x.com', displayName: 'Rep One', isAdmin: false, powerDialerEnabled: false },
  ];
  state.updateRows = [{ id: TARGET_ID, powerDialerEnabled: true }];
  state.lastSelectWhere = null;
  state.lastUpdateSet = null;
  state.lastUpdateWhere = null;
  app = Fastify();
  await registerAdminRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe('GET /admin/team', () => {
  it('401 without a session, 403 for a non-admin', async () => {
    state.authedUser = null;
    expect((await app.inject({ method: 'GET', url: '/admin/team' })).statusCode).toBe(401);
    state.authedUser = { ...admin, isAdmin: false };
    expect((await app.inject({ method: 'GET', url: '/admin/team' })).statusCode).toBe(403);
  });

  it('an admin gets the org users incl. the flag, and the query is org-scoped', async () => {
    state.authedUser = admin;
    const res = await app.inject({ method: 'GET', url: '/admin/team' });
    expect(res.statusCode).toBe(200);
    expect(res.json().users[0]).toMatchObject({ email: 'rep@x.com', powerDialerEnabled: false });
    expect(renderPredicate(state.lastSelectWhere)).toContain('org_id');
  });
});

describe('PATCH /admin/team/:userId', () => {
  it('401 without a session', async () => {
    state.authedUser = null;
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${TARGET_ID}`,
      payload: { powerDialerEnabled: true },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 for a non-admin', async () => {
    state.authedUser = { ...admin, isAdmin: false };
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${TARGET_ID}`,
      payload: { powerDialerEnabled: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Admin only' });
  });

  it('400 for a non-boolean body', async () => {
    state.authedUser = admin;
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${TARGET_ID}`,
      payload: { powerDialerEnabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('404 for a non-uuid id', async () => {
    state.authedUser = admin;
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/team/not-a-uuid',
      payload: { powerDialerEnabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('flips the flag and the WHERE pins user id AND org id AND kind=human (IDOR- and service-user-proof)', async () => {
    state.authedUser = admin;
    state.updateRows = [{ id: TARGET_ID, powerDialerEnabled: true }];
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${TARGET_ID}`,
      payload: { powerDialerEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toEqual({ id: TARGET_ID, powerDialerEnabled: true });
    expect(state.lastUpdateSet).toEqual({ powerDialerEnabled: true });
    // renderPredicate (verbatim from mobile.test.ts) renders a Column chunk
    // as its bare `.name` only — no table qualifier or quoting — so the
    // real rendered text is `(id = <param> and org_id = <param> and kind =
    // <param>)`, not a `"users"."id"`-style string. Assert the exact
    // deterministic string (rather than a loose `.toContain('id')`) so all
    // three columns AND the `and` joins are unambiguously proven — a naive
    // substring check for "id" would trivially match inside "org_id" too.
    // The `kind = 'human'` clause (humanUserById) is what keeps this route
    // from ever flipping the AI Agent service user's power-dialer flag.
    const where = renderPredicate(state.lastUpdateWhere);
    expect(where).toBe('(id = <param> and org_id = <param> and kind = <param>)');
  });

  it('404 when the target is in another org (update matches no row)', async () => {
    state.authedUser = admin;
    state.updateRows = [];
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/team/${TARGET_ID}`,
      payload: { powerDialerEnabled: true },
    });
    expect(res.statusCode).toBe(404);
  });
});

import type { FastifyInstance } from 'fastify';
// Type-only: erased at compile time, so this doesn't make harness.js itself a
// runtime importer of `@cti/auth` (see `mockCreateTenant`'s doc comment).
import type { CreatedTenant, CreateTenantInput } from '@cti/auth';
import { schema, type Db } from '@cti/db';
import { buildApp } from '../app.js';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { parseConfig, type AppConfig } from '../config.js';
import { registerAdminTenantRoutes } from '../routes/admin-tenants.js';
import { registerAuthRoutes } from '../routes/auth.js';
import { registerTeamRoutes } from '../routes/team.js';

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    SESSION_SECRET: 's'.repeat(32),
    DATABASE_URL: 'postgres://u:p@h/db',
    APP_PUBLIC_URL: 'http://app.test',
    API_PUBLIC_URL: 'http://api.test',
    ...over,
  });
}

export interface Fixtures {
  organizations?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
  /**
   * What `update(...).where(...).returning()` (and the bare awaited `where(...)`)
   * yields; defaults to `[]` — a conditional/predicated update matching no
   * row, same as a real `UPDATE ... WHERE` that filters everything out (e.g.
   * the route's own defensive re-check, or a concurrent write that already
   * claimed the row — see provision.ts's `ensureWorkosOrg`). A test whose
   * route needs a matched row back must seed this explicitly; there is no
   * fixture-guessing fallback (see below).
   */
  updateReturning?: Array<Record<string, unknown>>;
  /**
   * Rows for any other relational table, keyed by its `db.query` name (e.g.
   * `crmConnections`, `crmOauthStates`, `campaigns`). Same no-filtering rule as
   * the three above; a `db.query.<name>` not listed here answers
   * `undefined`/`[]` rather than throwing.
   */
  tables?: Record<string, Array<Record<string, unknown>>>;
  /**
   * What awaited `select(...)` chains resolve to, one entry per chain in the
   * order the code under test awaits them. Once used up, a chain resolves to
   * `fx.users ?? []` (the original single-result behavior).
   */
  selectResults?: Array<Array<Record<string, unknown>>>;
  /** What `delete(...).where(...)` yields, awaited directly or via `.returning()`; defaults to `[]`. */
  deleteReturning?: Array<Record<string, unknown>>;
  /** The database's column defaults (e.g. `createdAt`), merged under each `insert(...).values(v).returning()` row; `v` wins. */
  insertDefaults?: Record<string, unknown>;
}

type Row = Record<string, unknown>;

/**
 * Fake Drizzle handle in this repo's convention: `where` is not filtered
 * against — `findFirst`/`select` return the fixture rows (or `updateReturning`
 * for writes) regardless of the predicate. Tests that need "which row
 * matched" put exactly one row in the fixture, seed `updateReturning`
 * explicitly, or filter in the code under test (as completeSignIn does).
 *
 * Every `where` argument — passed to any table's `findFirst`/`findMany`, to a
 * `select(...).where(...)` chain, to an `update(...).where(...)`, or to a
 * `delete(...).where(...)` — is
 * pushed (in call order) onto the returned `captured.where` array, so a test
 * can render the raw drizzle `SQL` fragment (e.g. via `new PgDialect().sqlToQuery(...)`)
 * to prove the code under test queried/wrote on the column(s) it claims to.
 */
export function fakeDb(fx: Fixtures = {}) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; values: Row }> = [];
  /** `insert(...).values(v).onConflictDoUpdate({ set })` calls; the insert itself is also in `writes`. */
  const upserts: Array<{ table: unknown; values: Row; set: Row }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const captured: { where: unknown[] } = { where: [] };
  const selectQueue = [...(fx.selectResults ?? [])];
  const table = (rows: Row[] = []) => ({
    findFirst: async (args?: { where?: unknown }) => {
      if (args?.where !== undefined) captured.where.push(args.where);
      return rows[0];
    },
    findMany: async (args?: { where?: unknown }) => {
      if (args?.where !== undefined) captured.where.push(args.where);
      return rows;
    },
  });
  const tables: Record<string, ReturnType<typeof table>> = {
    organizations: table(fx.organizations),
    users: table(fx.users),
    sessions: table(fx.sessions),
    ...Object.fromEntries(Object.entries(fx.tables ?? {}).map(([name, rows]) => [name, table(rows)])),
  };
  const db = {
    // Any table name works: unlisted ones are empty.
    query: new Proxy(tables, { get: (t, name) => (typeof name === 'string' ? t[name] ?? table([]) : undefined) }),
    insert: (t: unknown) => ({
      values: (values: Row) => {
        writes.push({ op: 'insert', table: t, values });
        const row = { id: `new-${writes.length}`, ...fx.insertDefaults, ...values };
        return {
          returning: async () => [row],
          onConflictDoNothing: async () => undefined,
          onConflictDoUpdate: (conflict: { set: Row }) => {
            upserts.push({ table: t, values, set: conflict.set });
            return { returning: async () => [row], then: (resolve: (v: undefined) => void) => resolve(undefined) };
          },
        };
      },
    }),
    update: (t: unknown) => ({
      set: (values: Row) => ({
        // `where`'s result carries `.returning()` for callers that need the
        // matched row(s) back, and is itself thenable — an awaited `where(...)`
        // with no `.returning()` chained (existing callers like sign-in.ts)
        // resolves to that same rows array too (not a `{ rowCount, rows }`
        // shape a real driver would give; this fake doesn't model that).
        // Always `fx.updateReturning ?? []` — no fixture-row guessing; a test
        // whose route needs a row back seeds `updateReturning` explicitly.
        where: (cond?: unknown) => {
          if (cond !== undefined) captured.where.push(cond);
          writes.push({ op: 'update', table: t, values });
          const rows = fx.updateReturning ?? [];
          return { returning: async () => rows, then: (resolve: (v: typeof rows) => void) => resolve(rows) };
        },
      }),
    }),
    delete: (t: unknown) => ({
      where: (cond?: unknown) => {
        if (cond !== undefined) captured.where.push(cond);
        deletes.push({ table: t });
        const rows = fx.deleteReturning ?? [];
        return { returning: async () => rows, then: (resolve: (v: typeof rows) => void) => resolve(rows) };
      },
    }),
    // Chainable + thenable: every builder method returns the same chain
    // (order and count don't matter, matching `findFirst`/`findMany`'s
    // no-filtering convention); `where`'s predicate is still captured, and
    // awaiting the chain resolves to the next `fx.selectResults` entry, else
    // to `fx.users`.
    select: () => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        leftJoin: () => chain,
        where: (cond?: unknown) => {
          if (cond !== undefined) captured.where.push(cond);
          return chain;
        },
        orderBy: () => chain,
        groupBy: () => chain,
        limit: () => chain,
        then: (resolve: (v: Row[]) => void) => resolve(selectQueue.length > 0 ? selectQueue.shift()! : fx.users ?? []),
      };
      return chain;
    },
    // Passthrough: fakeDb has no real transactional isolation, so `fn` just
    // runs against this same `db`, recording writes exactly as it would outside one.
    transaction: async <T>(fn: (tx: Db) => Promise<T>): Promise<T> => fn(db as unknown as Db),
  };
  return { db: db as unknown as Db, writes, upserts, deletes, captured };
}

/**
 * A stand-in for `@cti/auth`'s `createTenant`, for tests where the route or
 * function under test calls it but the fixture already holds an organization
 * row (e.g. the calling super admin's own tenant) — `createTenant`'s
 * slug-collision check runs `findFirst`, which `fakeDb` always answers with
 * `fixture[0]` regardless of the `where` clause, so the real `createTenant`
 * would spuriously think the new tenant's slug is taken and randomize it.
 * This replays `createTenant`'s real insert sequence (org, AI Agent user,
 * default campaign) directly against `db`, skipping that lookup. `slugify`
 * and the AI Agent naming are duplicated rather than imported from
 * `@cti/auth` as *values* — a value import from that package here would make
 * this file a transitive importer of it, and a test's `vi.mock('@cti/auth',
 * ...)` factory that calls this export eagerly (rather than deferring the
 * call past its own execution) throws "before initialization"; see
 * admin-tenants.test.ts for the deferred-call side of this. `CreateTenantInput`/
 * `CreatedTenant` below are `import type`, which is erased at compile time and
 * so doesn't create that runtime edge.
 */
export function mockCreateTenant(): (db: Db, input: CreateTenantInput) => Promise<CreatedTenant> {
  return async (db, input) => {
    const base = input.slug ?? input.name;
    const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'org';
    const timezone = input.timezone ?? 'America/Los_Angeles';
    const [org] = await db.insert(schema.organizations).values({ name: input.name, slug, timezone, sfOrgId: null }).returning();
    const [agent] = await db.insert(schema.users).values({ orgId: org!.id, email: `ai-agent@${slug}.internal`, displayName: 'AI Agent', kind: 'service', timezone }).returning({ id: schema.users.id });
    await db.insert(schema.campaignConfigs).values({ orgId: org!.id, key: 'default', name: 'Default Campaign' }).onConflictDoNothing();
    return { org: org!, aiAgentUserId: agent!.id };
  };
}

export async function buildTestApp(deps: { cfg: AppConfig; db: Db; idp: IdentityProvider | null }): Promise<FastifyInstance> {
  return buildApp({
    cfg: deps.cfg,
    readiness: async () => ({ dbOk: true, jobsOk: true }),
    apiRoutes: [
      (app) => registerAuthRoutes(app, deps),
      (app) => registerAdminTenantRoutes(app, { db: deps.db, idp: deps.idp }),
      (app) => registerTeamRoutes(app, { db: deps.db, idp: deps.idp }),
    ],
  });
}

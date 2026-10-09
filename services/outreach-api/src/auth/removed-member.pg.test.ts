import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { issueSession } from '@cti/auth';
import { buildTestApp, testConfig } from '../test/harness.js';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';

// `issueSession`/`resolveSession` reach the database through `getDb()`; point that at the throwaway database.
const lane = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => lane.db!,
}));

/**
 * outreach-api has no member-removal or deactivation route (the team routes list,
 * invite and promote only), so there is nothing to attach a session revoke to. What
 * it must hold is that a session never outlives its user or tenant: these pin that
 * against real rows, through real routes, now that sessions slide and can live on.
 */
describe.skipIf(!pgLane)('a session for a removed, converted or suspended member (real Postgres)', () => {
  let t: TestDb;
  let app: FastifyInstance;
  let orgId = '';
  let removedId = '';
  let removedBearer = '';
  let colleagueBearer = '';
  let n = 0;

  beforeAll(async () => {
    t = await createTestDb();
    lane.db = t.db;
    app = await buildTestApp({ cfg: testConfig(), db: t.db, idp: null });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await t?.drop();
  });
  beforeEach(async () => {
    n += 1;
    const [org] = await t.db.insert(schema.organizations).values({ name: `Org ${n}`, slug: `org-${n}` }).returning();
    orgId = org!.id;
    const [removed, colleague] = await t.db.insert(schema.users).values([
      { orgId, email: `removed-${n}@gg.co` },
      { orgId, email: `colleague-${n}@gg.co` },
    ]).returning();
    removedId = removed!.id;
    removedBearer = `Bearer ${(await issueSession(removed!.id)).token}`;
    colleagueBearer = `Bearer ${(await issueSession(colleague!.id)).token}`;
  });

  const get = (url: string, authorization: string) => app.inject({ method: 'GET', url, headers: { authorization } });

  it('a member with a live session is signed in (the failures below are not vacuous)', async () => {
    expect((await get('/api/auth/me', removedBearer)).statusCode).toBe(200);
    expect((await get('/api/team', removedBearer)).statusCode).toBe(200);
  });

  it('a member whose user row is deleted can no longer authenticate: their sessions go with them, so /me renews nothing', async () => {
    await t.db.delete(schema.users).where(eq(schema.users.id, removedId));

    expect((await get('/api/auth/me', removedBearer)).statusCode).toBe(401);
    expect((await get('/api/team', removedBearer)).statusCode).toBe(401);
    expect(await t.db.query.sessions.findMany({ where: eq(schema.sessions.userId, removedId) })).toEqual([]);
    // ...and a colleague in the same tenant is untouched.
    expect((await get('/api/team', colleagueBearer)).statusCode).toBe(200);
  });

  it('a user turned into a service account (the AI Agent kind, which never holds a session) stops authenticating', async () => {
    await t.db.update(schema.users).set({ kind: 'service' }).where(eq(schema.users.id, removedId));
    expect((await get('/api/auth/me', removedBearer)).statusCode).toBe(401);
    expect((await get('/api/team', removedBearer)).statusCode).toBe(401);
  });

  it('a suspended tenant locks out every session in it, and reactivating the tenant restores them', async () => {
    await t.db.update(schema.organizations).set({ status: 'suspended' }).where(eq(schema.organizations.id, orgId));
    expect((await get('/api/auth/me', removedBearer)).statusCode).toBe(401);
    expect((await get('/api/team', colleagueBearer)).statusCode).toBe(401);

    await t.db.update(schema.organizations).set({ status: 'active' }).where(eq(schema.organizations.id, orgId));
    expect((await get('/api/team', colleagueBearer)).statusCode).toBe(200);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { extendSession, sha256 } from '@cti/auth';
import { createTestDb, pgLane, type TestDb } from '../test/pg.js';

// `extendSession` reaches the database through `getDb()`; point that at the throwaway database.
const lane = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('@cti/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cti/db')>()),
  getDb: () => lane.db!,
}));

const DAY_MS = 24 * 3600 * 1000;
const daysFromNow = (days: number): Date => new Date(Date.now() + days * DAY_MS);

describe.skipIf(!pgLane)('sliding session renewal (real Postgres)', () => {
  let t: TestDb;
  let userId = '';

  beforeAll(async () => {
    t = await createTestDb();
    lane.db = t.db;
    const [org] = await t.db.insert(schema.organizations).values({ name: 'A', slug: 'a-org' }).returning();
    const [user] = await t.db.insert(schema.users).values({ orgId: org!.id, email: 'ann@gg.co' }).returning();
    userId = user!.id;
  }, 120_000);
  afterAll(async () => { await t?.drop(); });
  beforeEach(async () => { await t.db.delete(schema.sessions); });

  async function seed(token: string, expiresAt: Date, revokedAt: Date | null = null): Promise<void> {
    await t.db.insert(schema.sessions).values({ userId, tokenHash: sha256(token), expiresAt, revokedAt });
  }
  async function expiryOf(token: string): Promise<Date> {
    const row = await t.db.query.sessions.findFirst({ where: eq(schema.sessions.tokenHash, sha256(token)) });
    return row!.expiresAt;
  }

  it('moves a session with less than 29 days left out to a fresh 30 days', async () => {
    await seed('old', daysFromNow(10));
    await extendSession('Bearer old');
    const renewed = (await expiryOf('old')).getTime();
    expect(Math.abs(renewed - daysFromNow(30).getTime())).toBeLessThan(60_000);
  });

  it('does not write for a session issued within the day (more than 29 days left): the expiry is untouched', async () => {
    const issued = daysFromNow(29.5);
    await seed('fresh', issued);
    await extendSession('Bearer fresh');
    expect((await expiryOf('fresh')).getTime()).toBe(issued.getTime());
  });

  it('renews at most once: a second call right after the first leaves the expiry as the first set it', async () => {
    await seed('twice', daysFromNow(3));
    await extendSession('Bearer twice');
    const first = await expiryOf('twice');
    await extendSession('Bearer twice');
    expect((await expiryOf('twice')).getTime()).toBe(first.getTime());
  });

  it('never revives an expired session', async () => {
    const lapsed = daysFromNow(-0.05);
    await seed('lapsed', lapsed);
    await extendSession('Bearer lapsed');
    expect((await expiryOf('lapsed')).getTime()).toBe(lapsed.getTime());
  });

  it('never extends a revoked session', async () => {
    const expiry = daysFromNow(10);
    await seed('revoked', expiry, new Date());
    await extendSession('Bearer revoked');
    expect((await expiryOf('revoked')).getTime()).toBe(expiry.getTime());
  });

  it("extends only the caller's own session, not the user's other browsers or devices", async () => {
    const other = daysFromNow(5);
    await seed('mine', daysFromNow(5));
    await seed('theirs', other);
    await extendSession('Bearer mine');
    expect((await expiryOf('theirs')).getTime()).toBe(other.getTime());
    expect((await expiryOf('mine')).getTime()).toBeGreaterThan(daysFromNow(29).getTime());
  });
});

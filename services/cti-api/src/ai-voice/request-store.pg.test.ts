/**
 * Real Postgres: the idempotency store's takeover and completion. cti-api has no PG lane of its own; this suite runs when
 * TEST_DATABASE_URL points at a server you can CREATE DATABASE on (the same variable outreach-api's lane uses), and is
 * skipped otherwise, so `npm test` needs no database.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, sql } from 'drizzle-orm';
import { loadMigrationFiles, runMigrations, schema } from '@cti/db';
import { drizzleAiCallRequestStore, STALE_REQUEST_MS } from './request-store.js';

const server = process.env.TEST_DATABASE_URL;

describe.skipIf(!server)('ai_call_requests store (real Postgres)', () => {
  const name = `cti_store_${randomBytes(4).toString('hex')}`;
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let orgId: string;
  let userId: string;

  const urlFor = (database: string) => {
    const url = new URL(server!);
    url.pathname = `/${database}`;
    return url.toString();
  };

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: urlFor(name), max: 10 });
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrationFiles(), { info: () => {}, error: (m: string) => console.error(m) });
    } finally {
      client.release();
    }
    db = drizzle(pool, { schema });
    const [org] = await db.insert(schema.organizations).values({ name: name, slug: name, settings: {} }).returning({ id: schema.organizations.id });
    orgId = org!.id;
    const [user] = await db.insert(schema.users).values({ orgId, email: `${name}@example.com`, kind: 'human' }).returning({ id: schema.users.id });
    userId = user!.id;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });

  const store = () => drizzleAiCallRequestStore(() => db as never);
  const reserve = (key: string) => store().reserve({ orgId, key, hash: 'h', userId });
  const row = async (key: string) => (await db.select().from(schema.aiCallRequests).where(eq(schema.aiCallRequests.idempotencyKey, key)))[0]!;
  const age = (key: string, minutes: number) =>
    db.execute(
      sql`update ai_call_requests set created_at = now() - make_interval(mins => ${minutes}), updated_at = now() - make_interval(mins => ${minutes}) where idempotency_key = ${key}`,
    );

  it('S-3: two concurrent retries of a stale reservation: exactly one takes it over', async () => {
    const key = 'touch:s3-race:1';
    await reserve(key);
    await age(key, 11);
    const results = await Promise.all(Array.from({ length: 8 }, () => store().takeOver(orgId, key)));
    expect(results.filter(Boolean)).toHaveLength(1);
    // The winner stamped updated_at: it is fresh now, so nobody else may take it over.
    expect(Date.now() - (await row(key)).updatedAt.getTime()).toBeLessThan(STALE_REQUEST_MS);
    expect(await store().takeOver(orgId, key)).toBe(false);
  });

  it('M-A: a takeover never moves created_at, so every later retry looks for a call from the ORIGINAL reservation', async () => {
    const key = 'touch:ma-created:1';
    await reserve(key);
    await age(key, 30);
    const before = (await row(key)).createdAt.getTime();
    expect(await store().takeOver(orgId, key)).toBe(true);
    // The retry that took it over died before finishing; ten minutes later the next retry takes it over again.
    await db.execute(sql`update ai_call_requests set updated_at = now() - make_interval(mins => 11) where idempotency_key = ${key}`);
    expect(await store().takeOver(orgId, key)).toBe(true);
    expect((await row(key)).createdAt.getTime()).toBe(before);
    expect(Date.now() - before).toBeGreaterThan(29 * 60_000);
  });

  it('M-A: staleness is measured from updated_at: an old reservation taken over a minute ago is not stale', async () => {
    const key = 'touch:ma-updated:1';
    await reserve(key);
    await db.execute(
      sql`update ai_call_requests set created_at = now() - make_interval(mins => 30), updated_at = now() - make_interval(mins => 1) where idempotency_key = ${key}`,
    );
    expect(await store().takeOver(orgId, key)).toBe(false);
  });

  it('S-3: a fresh reservation, an answered one and an unknown key are never taken over', async () => {
    await reserve('touch:s3-fresh:1');
    expect(await store().takeOver(orgId, 'touch:s3-fresh:1')).toBe(false);
    await reserve('touch:s3-done:1');
    await store().complete(orgId, 'touch:s3-done:1', { result: 'failed', reason: 'salesforce_error', aiCallId: null });
    await age('touch:s3-done:1', 30);
    expect(await store().takeOver(orgId, 'touch:s3-done:1')).toBe(false);
    expect(await store().takeOver(orgId, 'touch:s3-nothing:1')).toBe(false);
  });

  it('S-5: complete answers an unanswered key once; a later complete never overwrites the first answer', async () => {
    const key = 'touch:s5:1';
    await reserve(key);
    await store().complete(orgId, key, { result: 'failed', reason: 'in_flight', aiCallId: null });
    await store().complete(orgId, key, { result: 'failed', reason: 'salesforce_error', aiCallId: null });
    expect((await row(key)).response).toEqual({ result: 'failed', reason: 'in_flight', aiCallId: null });
  });
});

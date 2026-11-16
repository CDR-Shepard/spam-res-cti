/**
 * Real Postgres: the two reads behind the Texts tab (text-list.ts). Only the
 * rep's own rows come back, newest first, and the badge counts strictly after
 * `since`. Runs when TEST_DATABASE_URL points at a server you can CREATE
 * DATABASE on (as store-inbound.pg.test.ts), skipped otherwise.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadMigrationFiles, runMigrations, schema } from '@cti/db';
import { countRepTextsSince, selectRepTexts } from './text-list.js';

const server = process.env.TEST_DATABASE_URL;

describe.skipIf(!server)('Texts tab reads (real Postgres)', () => {
  const name = `cti_texts_${randomBytes(4).toString('hex')}`;
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let repId: string;
  let otherRepId: string;

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
    pool = new pg.Pool({ connectionString: urlFor(name), max: 4 });
    pool.on('error', (err: Error & { code?: string }) => {
      if (err.code !== '57P01') console.error(`[${name}] pool error:`, err);
    });
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrationFiles(), { info: () => {}, error: (m: string) => console.error(m) });
    } finally {
      client.release();
    }
    db = drizzle(pool, { schema });
    const [org] = await db.insert(schema.organizations).values({ name, slug: name, settings: {} }).returning({ id: schema.organizations.id });
    const users = await db
      .insert(schema.users)
      .values([
        { orgId: org!.id, email: `${name}-a@example.com`, kind: 'human' },
        { orgId: org!.id, email: `${name}-b@example.com`, kind: 'human' },
      ])
      .returning({ id: schema.users.id });
    repId = users[0]!.id;
    otherRepId = users[1]!.id;
    const at = (iso: string) => new Date(iso);
    await db.insert(schema.inboundMessages).values([
      { orgId: org!.id, messageSid: 'SM-a1', fromE164: '+16195550101', toE164: '+16193507799', body: 'first', userId: repId, receivedAt: at('2026-11-16T17:00:00Z') },
      { orgId: org!.id, messageSid: 'SM-a2', fromE164: '+16195550102', toE164: '+16193507799', body: 'second', userId: repId, receivedAt: at('2026-11-16T18:00:00Z') },
      { orgId: org!.id, messageSid: 'SM-a3', fromE164: '+16195550103', toE164: '+16193507799', body: 'third', userId: repId, receivedAt: at('2026-11-16T19:00:00Z') },
      { orgId: org!.id, messageSid: 'SM-b1', fromE164: '+16195550104', toE164: '+16193500000', body: 'not yours', userId: otherRepId, receivedAt: at('2026-11-16T20:00:00Z') },
      { orgId: org!.id, messageSid: 'SM-n1', fromE164: '+16195550105', toE164: '+16193500001', body: 'nobody', userId: null, status: 'skipped', receivedAt: at('2026-11-16T21:00:00Z') },
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: server });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  });

  it("returns only the rep's texts, newest first, up to the limit", async () => {
    expect((await selectRepTexts(db, repId, 50)).map((r) => r.body)).toEqual(['third', 'second', 'first']);
    expect((await selectRepTexts(db, repId, 2)).map((r) => r.body)).toEqual(['third', 'second']);
    expect((await selectRepTexts(db, otherRepId, 50)).map((r) => r.body)).toEqual(['not yours']);
  });

  it('counts strictly after since, as a number', async () => {
    expect(await countRepTextsSince(db, repId, new Date('2026-11-16T18:00:00Z'))).toEqual([{ n: 1 }]);
    expect(await countRepTextsSince(db, repId, new Date('2026-11-16T16:00:00Z'))).toEqual([{ n: 3 }]);
    expect(await countRepTextsSince(db, repId, new Date('2026-11-16T19:00:00Z'))).toEqual([{ n: 0 }]);
  });
});

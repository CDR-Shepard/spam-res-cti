/**
 * Real Postgres: the org's active agent prompts (plan 2026-10-16 editable agent prompts, Task 4). Versions are
 * append-only rows in ai_agent_prompts; the active one per kind is the newest created_at, a NULL body is a reset
 * to the built-in default, and an org never sees another org's rows. Runs when TEST_DATABASE_URL points at a server
 * you can CREATE DATABASE on (as request-store.pg.test.ts), skipped otherwise.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadMigrationFiles, runMigrations, schema } from '@cti/db';
import { drizzleAiCallStore, type AiCallStore } from './store.js';

const server = process.env.TEST_DATABASE_URL;

describe.skipIf(!server)('ai_agent_prompts active versions (real Postgres)', () => {
  const name = `cti_prompts_${randomBytes(4).toString('hex')}`;
  let pool: pg.Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let store: AiCallStore;
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
    pool = new pg.Pool({ connectionString: urlFor(name), max: 4 });
    // afterAll terminates this database's backends (pg_terminate_backend) while the pool may still be closing an idle
    // client: only that admin shutdown (57P01) is expected. Anything else is logged, never swallowed.
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
    store = drizzleAiCallStore(db);
    const [org] = await db.insert(schema.organizations).values({ name, slug: name, settings: {} }).returning({ id: schema.organizations.id });
    const [user] = await db.insert(schema.users).values({ orgId: org!.id, email: `${name}@example.com`, kind: 'human' }).returning({ id: schema.users.id });
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

  let seq = 0;
  /** A fresh org per test, so tests never see each other's versions. */
  const newOrg = async (): Promise<string> => {
    seq += 1;
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: `${name}-${seq}`, slug: `${name}-${seq}`, settings: {} })
      .returning({ id: schema.organizations.id });
    return org!.id;
  };
  const save = (orgId: string, kind: 'instructions' | 'voicemail' | 'inbound', body: string | null, at: string) =>
    db.insert(schema.aiAgentPrompts).values({ orgId, kind, body, createdBy: userId, createdAt: new Date(at) });

  it('an org with no saved version gets null for every kind', async () => {
    expect(await store.activeAgentPrompts(await newOrg())).toEqual({ instructions: null, voicemail: null, inbound: null });
  });

  it('returns the newest version of each kind, whatever order the rows were inserted in', async () => {
    const org = await newOrg();
    await save(org, 'instructions', 'newest', '2026-10-03T00:00:00Z');
    await save(org, 'instructions', 'oldest', '2026-10-01T00:00:00Z');
    await save(org, 'instructions', 'middle', '2026-10-02T00:00:00Z');
    await save(org, 'voicemail', 'voicemail v1', '2026-10-01T00:00:00Z');
    expect(await store.activeAgentPrompts(org)).toEqual({ instructions: 'newest', voicemail: 'voicemail v1', inbound: null });
  });

  it('a newest version with a NULL body is a reset: null, not the older text', async () => {
    const org = await newOrg();
    await save(org, 'instructions', 'custom', '2026-10-01T00:00:00Z');
    await save(org, 'instructions', null, '2026-10-02T00:00:00Z');
    await save(org, 'voicemail', 'kept', '2026-10-01T00:00:00Z');
    expect(await store.activeAgentPrompts(org)).toEqual({ instructions: null, voicemail: 'kept', inbound: null });
    // ...and a version saved after the reset is active again.
    await save(org, 'instructions', 'custom again', '2026-10-03T00:00:00Z');
    expect((await store.activeAgentPrompts(org)).instructions).toBe('custom again');
  });

  it('reads the inbound kind (migration 0061) like the others', async () => {
    const org = await newOrg();
    await save(org, 'inbound', 'You are {{agent_name}}.', '2026-10-16T00:00:00Z');
    expect(await store.activeAgentPrompts(org)).toEqual({ instructions: null, voicemail: null, inbound: 'You are {{agent_name}}.' });
  });

  it('never returns another org\'s rows', async () => {
    const mine = await newOrg();
    const theirs = await newOrg();
    await save(theirs, 'instructions', 'their instructions', '2026-10-05T00:00:00Z');
    await save(theirs, 'voicemail', 'their voicemail', '2026-10-05T00:00:00Z');
    await save(mine, 'instructions', 'my instructions', '2026-10-01T00:00:00Z');
    expect(await store.activeAgentPrompts(mine)).toEqual({ instructions: 'my instructions', voicemail: null, inbound: null });
    expect(await store.activeAgentPrompts(theirs)).toEqual({ instructions: 'their instructions', voicemail: 'their voicemail', inbound: null });
  });
});

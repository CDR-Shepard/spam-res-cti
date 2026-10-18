/**
 * Real Postgres: the SQL only an inbound test call runs (store-inbound.ts; final review M-2, M-3). A details write
 * landing after finalize still sets the outcome from a valid status, and a replayed webhook finds the org's open
 * inbound row for its CallSid. Runs when TEST_DATABASE_URL points at a server you can CREATE DATABASE on (as
 * store-prompts.pg.test.ts), skipped otherwise.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadMigrationFiles, runMigrations, schema } from '@cti/db';
import { drizzleAiCallStore, type AiCallStore } from './store.js';

const server = process.env.TEST_DATABASE_URL;
const CALLER = '+16195550142';
const AI_NUMBER = '+16197244374';
const END = new Date('2026-10-16T18:05:00Z');

describe.skipIf(!server)('inbound-only ai_calls writes and reads (real Postgres)', () => {
  const name = `cti_inbound_${randomBytes(4).toString('hex')}`;
  let pool: pg.Pool;
  let store: AiCallStore;
  let orgId: string;
  let otherOrgId: string;
  let userId: string;
  let seq = 0;

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
    const db = drizzle(pool, { schema });
    store = drizzleAiCallStore(db);
    const orgs = await db
      .insert(schema.organizations)
      .values([{ name, slug: name, settings: {} }, { name: `${name}-b`, slug: `${name}-b`, settings: {} }])
      .returning({ id: schema.organizations.id });
    orgId = orgs[0]!.id;
    otherOrgId = orgs[1]!.id;
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

  const sid = () => `CA${String((seq += 1)).padStart(32, '0')}`;
  const inbound = (callSid = sid(), org = orgId) =>
    store.insert({ orgId: org, startedBy: userId, direction: 'inbound', isTest: true, toE164: CALLER, fromE164: AI_NUMBER, status: 'in_progress', callSid });
  const finalize = (id: string) => store.finalizeInbound(id, { durationSeconds: 40, endedAt: END, failed: false });

  it('a status saved after finalize becomes the outcome, and the details are merged', async () => {
    const row = await inbound();
    await store.mergeCallerDetails(row.id, { location: 'Vista' });
    expect((await finalize(row.id))?.outcome).toBe('incomplete');
    await store.mergeCallerDetails(row.id, { status: 'callback', timeline: 'this summer' });
    expect(await store.get(row.id)).toMatchObject({
      outcome: 'callback',
      status: 'completed',
      qualification: { location: 'Vista', status: 'callback', timeline: 'this summer' },
    });
  });

  it('a save while the call is live leaves the outcome to finalize; a late save with no status leaves it alone', async () => {
    const row = await inbound();
    await store.mergeCallerDetails(row.id, { status: 'qualified' });
    expect((await store.get(row.id))?.outcome).toBeNull();
    expect((await finalize(row.id))?.outcome).toBe('qualified');
    await store.mergeCallerDetails(row.id, { notes: 'asked about timing' });
    expect(await store.get(row.id)).toMatchObject({ outcome: 'qualified', qualification: { status: 'qualified', notes: 'asked about timing' } });
  });

  it('never writes an outbound row', async () => {
    const row = await store.insert({ orgId, startedBy: userId, isTest: true, toE164: CALLER, status: 'completed', callSid: sid(), endedAt: END, outcome: 'hung_up' });
    await store.mergeCallerDetails(row.id, { status: 'qualified', location: 'Vista' });
    expect(await store.get(row.id)).toMatchObject({ direction: 'outbound', outcome: 'hung_up', qualification: {} });
  });

  it("a replayed CallSid: the insert is refused, and the org's open inbound row is found — not an ended one, not another org's", async () => {
    const callSid = sid();
    const row = await inbound(callSid);
    await expect(inbound(callSid)).rejects.toThrow();
    expect((await store.openInboundByCallSid(orgId, callSid))?.id).toBe(row.id);
    expect(await store.openInboundByCallSid(otherOrgId, callSid)).toBeNull();
    await finalize(row.id);
    expect(await store.openInboundByCallSid(orgId, callSid)).toBeNull();
  });
});

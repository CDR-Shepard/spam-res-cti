/**
 * The real-Postgres test lane (spec §13). Tests that need real concurrency or
 * real constraints — enrollment uniqueness, touch claims, the outbox — run
 * against a throwaway database:
 *
 *   describe.skipIf(!pgLane)('…', () => {
 *     let t: TestDb;
 *     beforeAll(async () => { t = await createTestDb(); }, 120_000);
 *     afterAll(async () => { await t?.drop(); });
 *   });
 *
 * Set TEST_DATABASE_URL to a server you can CREATE DATABASE on (root
 * `npm run test:pg` starts one in Docker). Unset, every such suite is skipped,
 * so `npm test` needs no database.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadMigrationFiles, runMigrations, schema, type Db } from '@cti/db';

/** True when a real Postgres is available to this test run. */
export const pgLane: boolean = !!process.env.TEST_DATABASE_URL;

export interface TestDb {
  db: Db;
  pool: pg.Pool;
  /** Closes the pool, terminates any other session on the database, and drops it. Safe to call twice. */
  drop(): Promise<void>;
}

const quietMigrations = { info: () => {}, error: (msg: string) => console.error(msg) };

function serverUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set — guard the suite with describe.skipIf(!pgLane)');
  return url;
}

function databaseUrl(server: string, database: string): string {
  const url = new URL(server);
  url.pathname = `/${database}`;
  return url.toString();
}

async function onServer(server: string, run: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: server });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.end();
  }
}

async function dropDatabase(server: string, name: string): Promise<void> {
  await onServer(server, async (client) => {
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
    await client.query(`DROP DATABASE IF EXISTS "${name}"`);
  });
}

/** CREATE DATABASE outreach_test_<8 hex>, apply every migration, and hand back a Drizzle handle on it. */
export async function createTestDb(): Promise<TestDb> {
  const server = serverUrl();
  // Generated here, never from input: hex only, so quoting it into DDL is safe.
  const name = `outreach_test_${randomBytes(4).toString('hex')}`;
  await onServer(server, async (client) => {
    await client.query(`CREATE DATABASE "${name}"`);
  });
  const pool = new pg.Pool({ connectionString: databaseUrl(server, name), max: 10 });
  // An idle client dropped by the server must not crash the test process.
  pool.on('error', (err) => console.error('[test-pg] idle client error:', err.message));
  try {
    const client = await pool.connect();
    try {
      await runMigrations(client, await loadMigrationFiles(), quietMigrations);
    } finally {
      client.release();
    }
  } catch (err) {
    await pool.end();
    await dropDatabase(server, name);
    throw err;
  }
  const db: Db = drizzle(pool, { schema });
  let dropped = false;
  return {
    db,
    pool,
    async drop() {
      if (dropped) return;
      dropped = true;
      await pool.end();
      await dropDatabase(server, name);
    },
  };
}

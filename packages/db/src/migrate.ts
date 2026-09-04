/**
 * Lightweight SQL migration runner.
 * Applies *.sql files from ./migrations in lexical order, tracking applied
 * filenames in the cti_schema_migrations table.
 *
 * Run with: `npm run migrate` (repo root) or `npm -w packages/db run migrate`.
 * Env: `.env` in the cwd, else `services/cti-api/.env`. The actual apply/lock
 * logic lives in `migrate-runner.ts`, which takes a Postgres advisory lock so
 * concurrent deploys serialize instead of racing each other.
 */
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getPool } from './index.js';
import { runMigrations } from './migrate-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Env resolution: the caller's cwd `.env` first (how CI and Railway supply it),
// then the API service's `.env` so `npm run migrate` from the repo root keeps
// working for local dev exactly as it did before the move to packages/db.
// `getPool()` reads DATABASE_URL lazily, so loading env after the imports is safe.
dotenv.config();
if (!process.env.DATABASE_URL) {
  const apiEnv = resolve(__dirname, '../../../services/cti-api/.env');
  if (existsSync(apiEnv)) dotenv.config({ path: apiEnv });
}

// `src/migrate.ts` and `dist/migrate.js` sit at the same depth, so this resolves
// to packages/db/migrations from either.
const MIGRATIONS_DIR = resolve(__dirname, '../migrations');

async function main(): Promise<void> {
  const names = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql'));
  const files = await Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(join(MIGRATIONS_DIR, name), 'utf8') })),
  );
  const pool = getPool();
  const client = await pool.connect();
  try {
    await runMigrations(client, files);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

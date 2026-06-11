/**
 * Lightweight SQL migration runner.
 * Applies *.sql files from ./migrations in lexical order, tracking applied
 * filenames in the cti_schema_migrations table.
 *
 * Run with: `npm run migrate` (from services/cti-api or repo root).
 */
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getPool } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../migrations');

async function ensureTable(client: import('pg').PoolClient): Promise<void> {
  await client.query(`
    create table if not exists cti_schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    );
  `);
}

async function listApplied(client: import('pg').PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>(
    'select filename from cti_schema_migrations',
  );
  return new Set(rows.map((r) => r.filename));
}

async function main(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const applied = await listApplied(client);
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sqlText = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`[migrate] applying ${file}`);
      await client.query('begin');
      try {
        await client.query(sqlText);
        await client.query('insert into cti_schema_migrations(filename) values ($1)', [file]);
        await client.query('commit');
        appliedCount++;
      } catch (err) {
        await client.query('rollback');
        console.error(`[migrate] FAILED ${file}`);
        throw err;
      }
    }
    console.log(`[migrate] done (${appliedCount} new of ${files.length} total)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

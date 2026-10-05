/**
 * Reads packages/db/migrations/*.sql for the migration runner. Shared by
 * `migrate.ts` (deploys) and the real-Postgres test lane
 * (services/outreach-api/src/test/pg.ts), so both apply exactly the same files.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MigrationFile } from './migrate-runner.js';

const here = dirname(fileURLToPath(import.meta.url));

/** `src/` and `dist/` sit at the same depth, so this is packages/db/migrations from either. */
export const MIGRATIONS_DIR = resolve(here, '../migrations');

/** Every `*.sql` file in `dir` (default: the package's migrations), sorted by name. */
export async function loadMigrationFiles(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return Promise.all(names.map(async (name) => ({ name, sql: await readFile(join(dir, name), 'utf8') })));
}

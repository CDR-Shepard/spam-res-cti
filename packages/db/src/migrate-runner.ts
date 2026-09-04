/**
 * Pure migration runner: applies *.sql files in lexical order, tracking applied
 * filenames in cti_schema_migrations, under a Postgres session-level advisory
 * lock so two services deploying from one push cannot race each other.
 */
export interface MigrationFile {
  name: string;
  sql: string;
}

export interface MigrationClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface MigrationLogger {
  info(msg: string): void;
  error(msg: string): void;
}

/** Arbitrary bigint shared by every runner instance. Never change it: a new key would not exclude an old deploy. */
export const MIGRATION_LOCK_KEY = 727001;

const defaultLogger: MigrationLogger = {
  info: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
};

function byName(a: MigrationFile, b: MigrationFile): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function applyOne(client: MigrationClient, file: MigrationFile, log: MigrationLogger): Promise<void> {
  log.info(`[migrate] applying ${file.name}`);
  await client.query('begin');
  try {
    await client.query(file.sql);
    await client.query('insert into cti_schema_migrations(filename) values ($1)', [file.name]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    log.error(`[migrate] FAILED ${file.name}`);
    throw err;
  }
}

/** Returns the number of files applied in this run. */
export async function runMigrations(
  client: MigrationClient,
  files: ReadonlyArray<MigrationFile>,
  log: MigrationLogger = defaultLogger,
): Promise<number> {
  await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await client.query(
      'create table if not exists cti_schema_migrations (filename text primary key, applied_at timestamptz not null default now())',
    );
    const { rows } = await client.query('select filename from cti_schema_migrations');
    const applied = new Set(rows.map((r) => String(r.filename)));
    let appliedCount = 0;
    for (const file of [...files].sort(byName)) {
      if (applied.has(file.name)) continue;
      await applyOne(client, file, log);
      appliedCount++;
    }
    log.info(`[migrate] done (${appliedCount} new of ${files.length} total)`);
    return appliedCount;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}

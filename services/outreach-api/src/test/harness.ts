import type { Db } from '@cti/db';
import { parseConfig, type AppConfig } from '../config.js';

export function testConfig(over: Record<string, string> = {}): AppConfig {
  return parseConfig({
    NODE_ENV: 'test',
    TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    SESSION_SECRET: 's'.repeat(32),
    DATABASE_URL: 'postgres://u:p@h/db',
    APP_PUBLIC_URL: 'http://app.test',
    API_PUBLIC_URL: 'http://api.test',
    ...over,
  });
}

export interface Fixtures {
  organizations?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  sessions?: Array<Record<string, unknown>>;
}

/**
 * Fake Drizzle handle in this repo's convention: `where` is not introspected;
 * `findFirst` returns the first fixture, `findMany` all of them; writes are
 * recorded. Tests that need "which row matched" put exactly one row in the
 * fixture or filter in the code under test (as completeSignIn does).
 *
 * Every `where` argument passed to any table's `findFirst`/`findMany` is also
 * pushed (in call order) onto the returned `captured.where` array, so a test
 * can render the raw drizzle `SQL` fragment (e.g. via `new PgDialect().sqlToQuery(...)`)
 * to prove the code under test queried on the column/predicate it claims to.
 */
export function fakeDb(fx: Fixtures = {}) {
  const writes: Array<{ op: 'insert' | 'update'; table: unknown; values: Record<string, unknown> }> = [];
  const captured: { where: unknown[] } = { where: [] };
  const table = (rows: Array<Record<string, unknown>> = []) => ({
    findFirst: async (args?: { where?: unknown }) => {
      if (args?.where !== undefined) captured.where.push(args.where);
      return rows[0];
    },
    findMany: async (args?: { where?: unknown }) => {
      if (args?.where !== undefined) captured.where.push(args.where);
      return rows;
    },
  });
  const db = {
    query: {
      organizations: table(fx.organizations),
      users: table(fx.users),
      sessions: table(fx.sessions),
    },
    insert: (t: unknown) => ({
      values: (values: Record<string, unknown>) => {
        writes.push({ op: 'insert', table: t, values });
        const row = { id: `new-${writes.length}`, ...values };
        return { returning: async () => [row], onConflictDoNothing: async () => undefined };
      },
    }),
    update: (t: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { writes.push({ op: 'update', table: t, values }); return { rowCount: 1 }; },
      }),
    }),
    select: () => ({ from: () => ({ where: async () => [] }) }),
  };
  return { db: db as unknown as Db, writes, captured };
}

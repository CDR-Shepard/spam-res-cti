import { describe, expect, it } from 'vitest';
import { MIGRATION_LOCK_KEY, runMigrations, type MigrationClient } from './migrate-runner.js';

interface Recorded { text: string; values?: readonly unknown[] }

function fakeClient(opts: { applied?: string[]; failOnSql?: string } = {}) {
  const log: Recorded[] = [];
  const client: MigrationClient = {
    async query(text, values) {
      log.push({ text, values });
      if (opts.failOnSql && text === opts.failOnSql) throw new Error('boom');
      if (text.startsWith('select filename')) {
        return { rows: (opts.applied ?? []).map((filename) => ({ filename })) };
      }
      return { rows: [] };
    },
  };
  return { client, log };
}

const quiet = { info: () => {}, error: () => {} };
const files = [
  { name: '0002_b.sql', sql: 'create table b()' },
  { name: '0001_a.sql', sql: 'create table a()' },
];

describe('runMigrations', () => {
  it('takes the advisory lock before anything else and releases it last', async () => {
    const { client, log } = fakeClient();
    await runMigrations(client, files, quiet);
    expect(log[0]).toEqual({ text: 'select pg_advisory_lock($1)', values: [MIGRATION_LOCK_KEY] });
    expect(log[log.length - 1]).toEqual({ text: 'select pg_advisory_unlock($1)', values: [MIGRATION_LOCK_KEY] });
  });

  it('applies unapplied files in lexical order, each in its own transaction, and records them', async () => {
    const { client, log } = fakeClient({ applied: ['0001_a.sql'] });
    const n = await runMigrations(client, files, quiet);
    expect(n).toBe(1);
    const texts = log.map((r) => r.text);
    const begin = texts.indexOf('begin');
    expect(texts.slice(begin, begin + 4)).toEqual([
      'begin',
      'create table b()',
      'insert into cti_schema_migrations(filename) values ($1)',
      'commit',
    ]);
    expect(log[begin + 2]!.values).toEqual(['0002_b.sql']);
    expect(texts).not.toContain('create table a()');
  });

  it('returns 0 and runs no transaction when everything is applied', async () => {
    const { client, log } = fakeClient({ applied: ['0001_a.sql', '0002_b.sql'] });
    expect(await runMigrations(client, files, quiet)).toBe(0);
    expect(log.map((r) => r.text)).not.toContain('begin');
  });

  it('rolls back a failing file, rethrows, and still releases the lock', async () => {
    const { client, log } = fakeClient({ failOnSql: 'create table a()' });
    await expect(runMigrations(client, files, quiet)).rejects.toThrow('boom');
    const texts = log.map((r) => r.text);
    expect(texts).toContain('rollback');
    expect(texts).not.toContain('commit');
    expect(log[log.length - 1]!.text).toBe('select pg_advisory_unlock($1)');
  });
});

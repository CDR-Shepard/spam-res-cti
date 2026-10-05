import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, loadMigrationFiles } from './migration-files.js';

describe('loadMigrationFiles', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads the package migrations by default: every .sql file, sorted, with its text', async () => {
    expect(MIGRATIONS_DIR.endsWith(join('packages', 'db', 'migrations'))).toBe(true);
    const files = await loadMigrationFiles();
    const names = files.map((f) => f.name);
    expect(names[0]).toBe('0001_init.sql');
    expect(names).toContain('0051_outreach_campaigns.sql');
    expect(names).toEqual([...names].sort());
    for (const f of files) {
      expect(f.name.endsWith('.sql')).toBe(true);
      expect(f.sql.length).toBeGreaterThan(0);
    }
  });

  it('skips non-.sql files and sorts by name in a given directory', async () => {
    dir = await mkdtemp(join(tmpdir(), 'migration-files-'));
    await writeFile(join(dir, '0002_b.sql'), 'select 2');
    await writeFile(join(dir, '0001_a.sql'), 'select 1');
    await writeFile(join(dir, 'README.md'), '# not a migration');
    expect(await loadMigrationFiles(dir)).toEqual([
      { name: '0001_a.sql', sql: 'select 1' },
      { name: '0002_b.sql', sql: 'select 2' },
    ]);
  });
});

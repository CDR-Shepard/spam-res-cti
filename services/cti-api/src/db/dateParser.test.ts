import { describe, expect, it } from 'vitest';
import pg from 'pg';
// Importing the db module registers the OID 1082 (date) type parser as a
// side effect. This is the regression guard for the critical bug where pg
// returned `dials_today_date` as a Date object, making `=== today` (a string)
// always false and silently disabling the per-DID warmup daily cap.
import './index.js';

describe('pg date type parser', () => {
  it('returns DATE columns as YYYY-MM-DD strings, not Date objects', () => {
    const parser = pg.types.getTypeParser(pg.types.builtins.DATE);
    const out = parser('2026-06-10');
    expect(typeof out).toBe('string');
    expect(out).toBe('2026-06-10');
  });

  it('makes the warmup same-day comparison work for the current date', () => {
    const parser = pg.types.getTypeParser(pg.types.builtins.DATE);
    const today = new Date().toISOString().slice(0, 10);
    // This is exactly the comparison firewall/index.ts + rotation.ts make.
    expect(parser(today) === today).toBe(true);
  });
});

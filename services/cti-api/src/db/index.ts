import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { loadConfig } from '../config.js';

const { Pool } = pg;

// CRITICAL: node-postgres parses Postgres `date` (OID 1082) columns into JS
// `Date` objects at local midnight by default. Our only date column,
// `outbound_numbers.dials_today_date`, is modeled as text/`YYYY-MM-DD` in the
// Drizzle schema and compared with string equality against
// `new Date().toISOString().slice(0,10)` in the warmup-cap gate
// (firewall/index.ts), the rotation pool (rotation.ts), and the reputation
// dashboard (routes/reputation.ts). A `Date === string` comparison is ALWAYS
// false — which silently disabled the per-DID daily warmup cap, the single
// most important defense against fresh-DID "Spam Likely" labeling. Force the
// driver to return `date` values as the raw `YYYY-MM-DD` string so the model
// and the runtime representation agree everywhere.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

let pool: pg.Pool | undefined;
let dbInstance: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: loadConfig().DATABASE_URL, max: 10 });
  }
  return pool;
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

export { schema };

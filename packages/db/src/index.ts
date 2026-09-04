import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const { Pool } = pg;

// CRITICAL: node-postgres parses Postgres `date` (OID 1082) columns into JS
// `Date` objects at local midnight by default. Our only date column,
// `outbound_numbers.dials_today_date`, is modeled as text/`YYYY-MM-DD` in the
// Drizzle schema and compared with string equality against
// `new Date().toISOString().slice(0,10)` in the warmup-cap gate
// (firewall), the rotation pool, and the reputation dashboard. A
// `Date === string` comparison is ALWAYS false — which silently disabled the
// per-DID daily warmup cap, the single most important defense against
// fresh-DID "Spam Likely" labeling. Force the driver to return `date` values
// as the raw `YYYY-MM-DD` string so the model and the runtime representation
// agree everywhere.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

/** The Drizzle handle every service and package shares. */
export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let dbInstance: Db | undefined;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: connectionString(), max: 10 });
    // node-postgres Pool is an EventEmitter. A managed Postgres (Railway)
    // routinely closes idle connections, which emits an 'error' on the idle
    // client. Node throws on an unhandled EventEmitter 'error' — crashing the
    // whole API and dropping every in-flight call over ordinary idle churn.
    // Log and swallow; the pool transparently opens a fresh connection on the
    // next query.
    pool.on('error', (err) => {
      console.error('[db] idle client error (recovered):', err instanceof Error ? err.message : err);
    });
  }
  return pool;
}

export function getDb(): Db {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

export { schema };
export type {
  Call,
  CallerDirectoryEntry,
  CallerDirectoryVersion,
  CampaignConfig,
  DialerHandoff,
  FollowupRolloverJob,
  MobileDevice,
  MobilePairCode,
  NewCall,
  Organization,
  OutboundNumber,
  PreCallAudit,
  SalesforceConnection,
  User,
} from './schema.js';

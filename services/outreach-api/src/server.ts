import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getPool } from '@cti/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createBoss, JobRunner } from './jobs/boss.js';
import { QUEUES } from './jobs/queues.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Where vite drops the built outreach-web bundle (src/ and dist/ sit at the same depth). */
const SPA_DIST = resolve(__dirname, '../../../apps/outreach-web/dist');

async function dbOk(): Promise<boolean> {
  try {
    await getPool().query('select 1');
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const runner = new JobRunner({ boss: createBoss(cfg), queues: QUEUES, log: console });
  await runner.start();
  const app = await buildApp({
    cfg,
    spaDist: SPA_DIST,
    readiness: async () => ({ dbOk: await dbOk(), jobsOk: runner.isHealthy() }),
  });
  const close = async () => { await runner.stop(); await app.close(); };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
  app.log.info({ url: cfg.API_PUBLIC_URL }, 'outreach-api listening');
}

process.on('unhandledRejection', (reason) => console.error('[fatal-guard] unhandledRejection (kept alive):', reason));
process.on('uncaughtException', (err) => console.error('[fatal-guard] uncaughtException (kept alive):', err));

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

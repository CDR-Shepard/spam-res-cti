import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDb, getPool } from '@cti/db';
import { AnthropicTriageModel } from './ai/model.js';
import { buildApp } from './app.js';
import { WorkosIdentityProvider } from './auth/workos-provider.js';
import { loadConfig } from './config.js';
import { liveClientFactory } from './crm/client-factory.js';
import { MemberIdCache } from './campaigns/member-cache.js';
import { refreshDueCampaigns } from './campaigns/refresh.js';
import { createBoss, JobRunner, type JobHandler } from './jobs/boss.js';
import { QUEUES } from './jobs/queues.js';
import { SCHEDULES } from './jobs/schedules.js';
import { planTick } from './planner/run.js';
import { registerAdminTenantRoutes } from './routes/admin-tenants.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSalesforceAuthRoutes } from './routes/auth-salesforce.js';
import { registerCampaignSelectionRoutes } from './routes/campaign-selection.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerTeamRoutes } from './routes/team.js';
import { shutdown } from './shutdown.js';
import { triageDueRecords } from './triage/run.js';

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
  const db = getDb();
  const clients = liveClientFactory(db, cfg);
  // Member Ids per campaign for the lead picker; one replica, so a process-local cache is enough.
  const memberCache = new MemberIdCache();
  // Scheduled ticks (src/jobs/schedules.ts). A feature that is not configured gets no
  // worker, and JobRunner skips the schedule of a queue that has no worker.
  const triageModel =
    cfg.aiEnabled && cfg.ANTHROPIC_API_KEY
      ? new AnthropicTriageModel({ client: new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 }) })
      : null;
  const handlers: Record<string, JobHandler> = {
    ...(cfg.salesforceEnabled
      ? {
          'campaign.refresh': async () => {
            await refreshDueCampaigns({ db, clients, now: new Date(), log: console, triage: triageModel !== null });
          },
        }
      : {}),
    ...(cfg.salesforceEnabled && triageModel
      ? {
          'record.triage': async () => {
            await triageDueRecords({ db, clients, model: triageModel, now: new Date(), log: console });
          },
        }
      : {}),
    // Plan due enrollments, then queue due rep calls of ACTIVE campaigns (src/planner/run.ts).
    'touch.plan': async () => {
      await planTick({ db, now: new Date(), log: console, waitForTriage: cfg.salesforceEnabled && cfg.aiEnabled });
    },
  };
  const runner = new JobRunner({ boss: createBoss(cfg), queues: QUEUES, log: console, handlers, schedules: SCHEDULES });
  await runner.start();
  const idp = cfg.workosEnabled
    ? new WorkosIdentityProvider({ apiKey: cfg.WORKOS_API_KEY!, clientId: cfg.WORKOS_CLIENT_ID!, redirectUri: cfg.WORKOS_REDIRECT_URI! })
    : null;
  const salesforceSignIn = cfg.salesforceSignInEnabled
    ? { clientId: cfg.SALESFORCE_CLIENT_ID!, redirectUri: cfg.SALESFORCE_SIGNIN_REDIRECT_URI!, loginUrl: cfg.SALESFORCE_LOGIN_URL, allowedOrgId: cfg.SALESFORCE_ALLOWED_ORG_ID ?? null }
    : null;
  const app = await buildApp({
    cfg,
    spaDist: SPA_DIST,
    readiness: async () => ({ dbOk: await dbOk(), jobsOk: runner.isHealthy() }),
    apiRoutes: [
      (scope) => registerAuthRoutes(scope, { cfg, db, idp }),
      (scope) => registerSalesforceAuthRoutes(scope, { cfg, db, signIn: salesforceSignIn }),
      (scope) => registerAdminTenantRoutes(scope, { db, idp }),
      (scope) => registerTeamRoutes(scope, { db, idp }),
      (scope) => registerConnectionRoutes(scope, { db, cfg, clients }),
      (scope) => registerCampaignRoutes(scope, { db, clients }),
      (scope) => registerCampaignSelectionRoutes(scope, { db, clients, cache: memberCache }),
      (scope) => registerReviewRoutes(scope, { db }),
    ],
  });
  const close = () => shutdown(runner, app);
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

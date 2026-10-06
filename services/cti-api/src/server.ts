import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config.js';
import { listenOptions } from './listen.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFirewallRoutes } from './routes/firewall.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerTelephonyRoutes } from './routes/telephony.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerAdminTalkTimeRoutes } from './routes/admin-talk-time.js';
import { registerCtiRoutes } from './routes/cti.js';
import { registerInboundRoutes } from './routes/inbound.js';
import { registerInboundSmsRoutes } from './routes/inbound-sms.js';
import { registerReputationRoutes } from './routes/reputation.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { registerRecordingRoutes } from './routes/recordings.js';
import { registerDialerRoutes } from './routes/dialer.js';
import { registerMobileRoutes } from './routes/mobile.js';
import { registerCtiResetRoutes } from './routes/cti-reset.js';
import { registerAiVoiceRoutes } from './ai-voice/routes.js';
import { startAiCallSweeper } from './ai-voice/sweeper.js';
import { startSyncLoop } from './salesforce/sync.js';
import { startFollowupLoop, startRetryNudgeLoop } from './salesforce/followup-worker.js';
import { maybeStartNoAnswerChatterLoop } from './salesforce/no-answer-chatter-worker.js';
import { maybeStartDialerConnectLoop } from './salesforce/dialer-connect-worker.js';
import { maybeStartDialerTimeLoop } from './salesforce/dialer-time-worker.js';
import { maybeStartInboundTextLoop } from './sms/inbound-text-worker.js';
import { startReputationWorker } from './reputation/worker.js';
import { startDirectoryLoop } from './mobile/directory-build.js';
import { startRepLegReconcileLoop } from './dialer/rep-leg-reconcile.js';
import { maybeStartIdleRunLoop } from './dialer/idle-runs.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Trust exactly ONE hop — Railway's edge proxy, the only thing in front of
    // this process. `true` trusts the whole X-Forwarded-For chain, which means
    // `req.ip` is the leftmost entry the CLIENT sent: anyone can mint a fresh
    // one per request and never land in the same bucket twice, defeating every
    // IP-keyed limit in the app (the global rate limiter and the pairing
    // claim's 3/min/IP cap alike). With a hop count, `req.ip` is the address
    // the trusted proxy actually observed and a spoofed header cannot move it.
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
  });

  // Capture raw body for webhook signature validation.
  // Replaces the default urlencoded parser so we keep the raw string.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      (req as { rawBody?: string }).rawBody = body as string;
      try {
        const params: Record<string, string> = {};
        new URLSearchParams(body as string).forEach((v, k) => {
          params[k] = v;
        });
        done(null, params);
      } catch (err) {
        done(err as Error);
      }
    },
  );

  // Rate limit every route (per IP). Twilio webhooks are signature-validated
  // and Twilio's egress stays well under this; the goal is to blunt auth/brute
  // and scraping floods. Registered before routes so it wraps all of them.
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => {
      // Twilio + NumberVerifier webhooks are secret-validated (and reject
      // unauthenticated requests before any work) and can legitimately burst —
      // never rate-limit them. The auth'd /telephony/token route is NOT exempt.
      if (typeof req.url === 'string' &&
        (req.url.startsWith('/telephony/twilio/') || req.url.startsWith('/integrations/numberverifier/'))) {
        return true;
      }
      if (cfg.NODE_ENV !== 'production' && (req.ip === '127.0.0.1' || req.ip === '::1')) return true;
      return false;
    },
  });

  const corsAllowList = (cfg.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const isSalesforceOrigin = (host: string): boolean =>
    host.endsWith('.salesforce.com') || host.endsWith('.force.com') || host.endsWith('.visualforce.com');
  await app.register(cors, {
    // In production, only the configured web origins + Salesforce my-domains may
    // call us with credentials; requests with no Origin (the Electron desktop,
    // native/server-to-server, same-origin) are allowed. Dev reflects all.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (cfg.NODE_ENV !== 'production') return cb(null, true);
      let host = '';
      try { host = new URL(origin).hostname; } catch { return cb(null, false); }
      if (corsAllowList.includes(origin) || isSalesforceOrigin(host)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
  });

  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerFirewallRoutes(app);
  await registerCallRoutes(app);
  await registerTelephonyRoutes(app);
  await registerAdminRoutes(app);
  await registerAdminTalkTimeRoutes(app);
  await registerCtiResetRoutes(app);
  await registerCtiRoutes(app);
  await registerInboundRoutes(app);
  await registerInboundSmsRoutes(app);
  await registerReputationRoutes(app);
  await registerIntegrationRoutes(app);
  await registerRecordingRoutes(app);
  await registerDialerRoutes(app);
  await registerMobileRoutes(app);
  await registerAiVoiceRoutes(app);

  const syncTimer = startSyncLoop(5000);
  const followupTimer = startFollowupLoop(5000);
  // The rep-facing retry nudge runs on its own timer — never behind Salesforce.
  const nudgeTimer = startRetryNudgeLoop(5000);
  // End-of-run "No answer" Chatter posts. Null when NO_ANSWER_CHATTER=off.
  const noAnswerChatterTimer = maybeStartNoAnswerChatterLoop(cfg);
  // Inbound texts → Salesforce Task + email alert (rows stored by /telephony/twilio/sms).
  // Null when INBOUND_TEXTS=off.
  const inboundTextTimer = maybeStartInboundTextLoop(cfg);
  // Bridged power-dial calls → one completed Call Task + recording link.
  // Null when DIALER_CONNECT_TASKS=off.
  const dialerConnectTimer = maybeStartDialerConnectLoop(cfg);
  // Each rep's time on the power dialer → one "Power Dialer Time" Task per day.
  // Null when DIALER_TIME_TASKS=off.
  const dialerTimeTimer = maybeStartDialerTimeLoop(cfg);
  const reputationTimer = startReputationWorker(app.log, cfg.REPUTATION_WORKER_INTERVAL_MS);
  const directoryTimer = startDirectoryLoop(cfg.DIRECTORY_REBUILD_INTERVAL_MS);
  // Talk-time report: close rep legs whose end callback never came (Twilio's own record).
  const repLegTimer = startRepLegReconcileLoop();
  // Power-dial runs whose open line sat 15 minutes with nothing happening → stopped. Null when DIALER_IDLE_STOP=off.
  const idleRunTimer = maybeStartIdleRunLoop(cfg);
  // AI calls whose status callback never came → finalized from Twilio's record (unref'd; null when AI voice is off).
  const aiCallSweepTimer = startAiCallSweeper(cfg, app.log);

  const close = async () => {
    clearInterval(syncTimer);
    clearInterval(followupTimer);
    clearInterval(nudgeTimer);
    if (noAnswerChatterTimer) clearInterval(noAnswerChatterTimer);
    if (inboundTextTimer) clearInterval(inboundTextTimer);
    if (dialerConnectTimer) clearInterval(dialerConnectTimer);
    if (dialerTimeTimer) clearInterval(dialerTimeTimer);
    clearInterval(reputationTimer);
    clearInterval(directoryTimer);
    clearInterval(repLegTimer);
    if (idleRunTimer) clearInterval(idleRunTimer);
    if (aiCallSweepTimer) clearInterval(aiCallSweepTimer);
    await app.close();
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);

  // '::' is dual-stack on Linux: public traffic (IPv4) is unchanged, and Railway private networking (IPv6-only in older environments) can reach the internal AI call routes.
  await app.listen(listenOptions(cfg.API_PORT));
  app.log.info({ url: cfg.API_PUBLIC_URL }, 'cti-api listening');
}

// Last-resort process guards. Hot paths intentionally fire-and-forget promises
// (client `void api(...)`, server `setInterval` workers), and on modern Node an
// unhandled rejection or uncaught exception terminates the process — which for a
// live 2-rep beta means both reps' calls drop at once. Log and keep serving; an
// isolated stray error is not worth a full outage. Startup failures still exit
// via main().catch below.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal-guard] unhandledRejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] uncaughtException (kept alive):', err);
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

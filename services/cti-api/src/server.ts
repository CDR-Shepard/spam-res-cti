import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { loadConfig } from './config.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFirewallRoutes } from './routes/firewall.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerTelephonyRoutes } from './routes/telephony.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerCtiRoutes } from './routes/cti.js';
import { registerInboundRoutes } from './routes/inbound.js';
import { registerReputationRoutes } from './routes/reputation.js';
import { registerIntegrationRoutes } from './routes/integrations.js';
import { startSyncLoop } from './salesforce/sync.js';
import { startReputationWorker } from './reputation/worker.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'production' ? 'info' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
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
  await registerCtiRoutes(app);
  await registerInboundRoutes(app);
  await registerReputationRoutes(app);
  await registerIntegrationRoutes(app);

  const syncTimer = startSyncLoop(5000);
  const reputationTimer = startReputationWorker(app.log, cfg.REPUTATION_WORKER_INTERVAL_MS);

  const close = async () => {
    clearInterval(syncTimer);
    clearInterval(reputationTimer);
    await app.close();
  };
  process.on('SIGTERM', close);
  process.on('SIGINT', close);

  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
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

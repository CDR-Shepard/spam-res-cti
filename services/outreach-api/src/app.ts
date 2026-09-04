import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import { registerHealthRoutes, type Readiness } from './routes/health.js';
import { registerSpa } from './routes/spa.js';

export interface AppDeps {
  cfg: AppConfig;
  readiness: () => Promise<Readiness>;
  /** Absolute path of the built SPA; omit in tests. */
  spaDist?: string;
  /** Route plugins registered under /api (added by later tasks). */
  apiRoutes?: Array<(app: FastifyInstance) => Promise<void>>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg } = deps;
  const app = Fastify({
    logger: {
      level: cfg.NODE_ENV === 'production' ? 'info' : cfg.NODE_ENV === 'test' ? 'silent' : 'debug',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    trustProxy: 1,
    bodyLimit: 1024 * 1024,
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => cfg.NODE_ENV !== 'production' && (req.ip === '127.0.0.1' || req.ip === '::1'),
  });
  const allow = (cfg.CORS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || cfg.NODE_ENV !== 'production') return cb(null, true);
      return cb(null, allow.includes(origin) || origin === cfg.APP_PUBLIC_URL || origin === cfg.API_PUBLIC_URL);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id', 'X-Org-Id'],
  });
  // Signed so the auth routes can bind the OAuth nonce and the session handoff
  // cookie to this server's secret (see routes/auth.ts): a tampered cookie value
  // fails `unsignCookie`/`reply.setCookie({ signed: true })` before it's ever read.
  await app.register(cookie, { secret: cfg.SESSION_SECRET });
  await registerHealthRoutes(app, deps.readiness);
  for (const plugin of deps.apiRoutes ?? []) {
    await app.register(async (scope) => plugin(scope), { prefix: '/api' });
  }
  if (deps.spaDist) await registerSpa(app, deps.spaDist);
  return app;
}

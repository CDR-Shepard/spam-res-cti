import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));
  app.get('/readyz', async () => {
    const cfg = loadConfig();
    return {
      ok: true,
      provider: cfg.TELEPHONY_PROVIDER,
      salesforceConfigured: Boolean(cfg.SALESFORCE_CLIENT_ID && cfg.SALESFORCE_REDIRECT_URI),
    };
  });
}

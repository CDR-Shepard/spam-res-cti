import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../config.js';
import { getPool } from '../db/index.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  // Liveness: cheap and never touches the DB, so a transient DB blip doesn't
  // make the platform kill and restart an otherwise-healthy container.
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  // Readiness: probes the DB and surfaces launch-critical config so an operator
  // can confirm at a glance (curl /readyz) that the deploy is actually ready to
  // take calls — including whether a REAL DNC scrub is loaded (not the demo seed).
  app.get('/readyz', async (_req, reply) => {
    const cfg = loadConfig();
    let dbOk = false;
    let realDncEntries: number | null = null;
    try {
      await getPool().query('select 1');
      dbOk = true;
    } catch (err) {
      app.log.error({ err }, 'readyz db probe failed');
    }
    if (dbOk) {
      try {
        // Rows NOT from the demo seed = a real scrub. 0 means cold outbound is
        // not being checked against the National DNC registry (legal exposure).
        const r = await getPool().query(
          "select count(*)::int as n from federal_dnc_entries where source <> 'demo_seed'",
        );
        realDncEntries = (r.rows[0]?.n as number | undefined) ?? 0;
      } catch {
        /* table may not exist yet (pre-migration) — leave null */
      }
    }
    const body = {
      ok: dbOk,
      dbOk,
      provider: cfg.TELEPHONY_PROVIDER,
      salesforceConfigured: Boolean(cfg.SALESFORCE_CLIENT_ID && cfg.SALESFORCE_REDIRECT_URI),
      salesforceOrgLocked: Boolean(cfg.SALESFORCE_ALLOWED_ORG_ID),
      twilioConfigured: Boolean(cfg.TWILIO_API_KEY_SID && cfg.TWILIO_TWIML_APP_SID),
      realDncEntries,
      dncScrubLoaded: (realDncEntries ?? 0) > 0,
    };
    return reply.code(dbOk ? 200 : 503).send(body);
  });
}

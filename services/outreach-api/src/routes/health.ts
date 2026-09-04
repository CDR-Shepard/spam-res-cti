import type { FastifyInstance } from 'fastify';

export interface Readiness {
  dbOk: boolean;
  jobsOk: boolean;
}

export async function registerHealthRoutes(app: FastifyInstance, readiness: () => Promise<Readiness>): Promise<void> {
  // Liveness never touches the DB, so a transient DB blip cannot get the container killed.
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));
  // Readiness reports the DB and the job runner; 503 when either is down.
  app.get('/readyz', async (_req, reply) => {
    const r = await readiness();
    const ok = r.dbOk && r.jobsOk;
    return reply.code(ok ? 200 : 503).send({ ok, ...r });
  });
}

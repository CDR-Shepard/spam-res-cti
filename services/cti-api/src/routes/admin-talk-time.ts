/**
 * GET /admin/talk-time?from=YYYY-MM-DD&to=YYYY-MM-DD — the talk-time report
 * (talk-time spec): one row per rep, with per-day detail, over the org's
 * Pacific days `from`..`to` inclusive (at most 92). Admin-only and org-scoped,
 * exactly like the other /admin/* routes.
 */
import type { FastifyInstance } from 'fastify';
import { resolveSession } from '@cti/auth';
import { getDb } from '@cti/db';
import { parseTalkRange, type TalkRange, type TalkTimeReport } from '../reports/talk-time.js';
import { loadTalkTimeReport } from '../reports/talk-time-query.js';

export interface TalkTimeRouteDeps {
  load: (orgId: string, range: TalkRange, now: Date) => Promise<TalkTimeReport>;
  now: () => Date;
}

const liveDeps: TalkTimeRouteDeps = {
  load: (orgId, range, now) => loadTalkTimeReport(getDb(), orgId, range, now),
  now: () => new Date(),
};

export async function registerAdminTalkTimeRoutes(app: FastifyInstance, deps: TalkTimeRouteDeps = liveDeps): Promise<void> {
  app.get('/admin/talk-time', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const parsed = parseTalkRange(req.query as { from?: unknown; to?: unknown });
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return deps.load(s.orgId, parsed.range, deps.now());
  });
}

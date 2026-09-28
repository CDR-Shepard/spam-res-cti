/**
 * Reset CTI: an admin signs a rep's web softphone out and resets its sound
 * settings, and the rep's tab does it the next time it is idle.
 * Design: docs/superpowers/specs/2026-09-28-cti-reset-design.md.
 *
 *  - GET  /auth/reset-signal             { resetDue } for the CALLING session.
 *        Every softphone tab polls it every 20 s. It costs the same two reads
 *        as every authed route (session + user). It has its own rate-limit
 *        bucket, keyed per session token, so an office of reps behind one IP
 *        never spends the global per-IP budget on it.
 *  - POST /auth/reset-complete           Sent by the tab that reset: stamp the
 *        user "done" and revoke THIS session only. Never every session: the
 *        iPhone and desktop apps share the sessions table.
 *  - POST /admin/team/:userId/reset-cti  Admin: one human user in the org.
 *  - POST /admin/team/reset-cti          Admin: every human user in the org
 *        except the admin asking.
 *
 * Timestamps are the DATABASE's now(), the clock that stamps
 * sessions.created_at. If app-server time ran ahead of the database, every
 * new session would look older than the request: a sign-in loop.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  humanUserById,
  humanUsersInOrg,
  isCtiResetDue,
  resolveSession,
  resolveSessionDetail,
  revokeSession,
  sha256,
} from '@cti/auth';
import { getDb, schema } from '@cti/db';

/** Polls allowed per session token per minute. A rep's tabs share one token:
 *  3 tabs × 3 polls, plus the polls a tab makes on becoming visible, well inside this. */
export const RESET_SIGNAL_RATE_MAX = 60;

/** The poll's rate-limit key: a hash of the session token (never the token
 *  itself), else the IP for a request that has none. */
export function resetSignalRateKey(req: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const auth = req.headers.authorization;
  return auth ? `reset-signal:${sha256(auth)}` : `reset-signal-ip:${req.ip}`;
}

const TargetParams = z.object({ userId: z.string().uuid() });

export async function registerCtiResetRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/auth/reset-signal',
    { config: { rateLimit: { max: RESET_SIGNAL_RATE_MAX, timeWindow: '1 minute', keyGenerator: resetSignalRateKey } } },
    async (req, reply) => {
      const detail = await resolveSessionDetail(req.headers.authorization);
      if (!detail) return reply.code(401).send({ error: 'Unauthorized' });
      reply.header('cache-control', 'no-store');
      return { resetDue: isCtiResetDue(detail.ctiResetRequestedAt, detail.sessionCreatedAt) };
    },
  );

  app.post('/auth/reset-complete', async (req, reply) => {
    const bearer = req.headers.authorization;
    const detail = await resolveSessionDetail(bearer);
    if (!detail || !bearer) return reply.code(401).send({ error: 'Unauthorized' });
    // Only a session that is due may stamp "done" or revoke itself here.
    if (!isCtiResetDue(detail.ctiResetRequestedAt, detail.sessionCreatedAt)) {
      return reply.code(409).send({ error: 'No reset pending' });
    }
    await getDb()
      .update(schema.users)
      .set({ ctiResetCompletedAt: sql`now()` })
      .where(eq(schema.users.id, detail.user.userId));
    await revokeSession(bearer);
    req.log.info({ userId: detail.user.userId }, 'cti_reset_completed');
    return { ok: true };
  });

  app.post('/admin/team/:userId/reset-cti', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const params = TargetParams.safeParse(req.params);
    if (!params.success) return reply.code(404).send({ error: 'Not found' });
    // Same org and human only, in the WHERE itself (IDOR-proof, the PATCH /admin/team/:userId shape).
    const [updated] = await getDb()
      .update(schema.users)
      .set({ ctiResetRequestedAt: sql`now()`, ctiResetRequestedBy: s.userId })
      .where(humanUserById(s.orgId, params.data.userId))
      .returning({
        id: schema.users.id,
        ctiResetRequestedAt: schema.users.ctiResetRequestedAt,
        ctiResetCompletedAt: schema.users.ctiResetCompletedAt,
      });
    if (!updated) return reply.code(404).send({ error: 'Not found' });
    req.log.info({ adminId: s.userId, targetUserId: updated.id }, 'cti_reset_requested');
    return { user: updated };
  });

  app.post('/admin/team/reset-cti', async (req, reply) => {
    const s = await resolveSession(req.headers.authorization);
    if (!s) return reply.code(401).send({ error: 'Unauthorized' });
    if (!s.isAdmin) return reply.code(403).send({ error: 'Admin only' });
    const rows = await getDb()
      .update(schema.users)
      .set({ ctiResetRequestedAt: sql`now()`, ctiResetRequestedBy: s.userId })
      .where(and(humanUsersInOrg(s.orgId), ne(schema.users.id, s.userId)))
      .returning({ id: schema.users.id });
    for (const row of rows) req.log.info({ adminId: s.userId, targetUserId: row.id }, 'cti_reset_requested');
    return { count: rows.length };
  });
}

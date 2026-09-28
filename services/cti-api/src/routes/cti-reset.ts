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
 *        M4: can also answer 429 (its own per-token bucket, or the per-IP
 *        failed-lookup ceiling below) or a 5xx (an ordinary infra hiccup —
 *        note the R2 self-heal below is caught and never the cause of one).
 *        Neither means anything about whether a reset is due: the web MUST
 *        treat both as "try again on the next poll," never as resetDue:
 *        false and never as a reason to sign the rep out.
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
 *  itself), else the IP for a request that has none. Strips the "Bearer "
 *  scheme prefix before hashing (M1) so "Bearer X" and a bare "X" land in
 *  the same bucket — a client varying the prefix must not split one rep's
 *  budget across two buckets, whether by accident or on purpose. */
export function resetSignalRateKey(req: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const auth = req.headers.authorization;
  if (!auth) return `reset-signal-ip:${req.ip}`;
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
  return `reset-signal:${sha256(token)}`;
}

const TargetParams = z.object({ userId: z.string().uuid() });

/**
 * I2 (review fix): the per-token bucket below is keyed on the CALLER's own
 * bearer — legitimate, since a rep's own tabs should share one bucket — but
 * that also means a flood of MADE-UP bearers, each hashing to its own fresh
 * bucket, never shares one and never trips it (400 requests, zero 429s, each
 * still costing a sessions lookup). This tracks failed lookups PER IP
 * instead, in a small bounded in-process map (insertion order doubles as LRU
 * recency; capped so a distributed flood cannot grow it without bound), and
 * blocks the IP outright once it passes FAILURE_LIMIT failures inside
 * FAILURE_WINDOW_MS. A real poll holds a real session and never fails, so it
 * never feeds this counter — ordinary office traffic, including many reps
 * behind one NAT'd IP, never approaches the limit. Deliberately NOT a second
 * `@fastify/rate-limit` registration scoped to this route: that plugin marks
 * a shared `rateLimitRan` symbol on the request the first time it runs, and
 * skips itself on a second run for the same request — it cannot be stacked.
 * This is a hand-rolled `onRequest` hook instead, which has no such limit.
 */
const RESET_SIGNAL_FAILURE_LIMIT = 30;
const RESET_SIGNAL_FAILURE_WINDOW_MS = 60_000;
const RESET_SIGNAL_FAILURE_TRACKED_IPS_MAX = 5_000;

export async function registerCtiResetRoutes(app: FastifyInstance): Promise<void> {
  const failedLookupsByIp = new Map<string, { count: number; windowEndsAt: number }>();

  function recordFailedLookup(ip: string): void {
    const now = Date.now();
    const existing = failedLookupsByIp.get(ip);
    const entry = !existing || now >= existing.windowEndsAt
      ? { count: 1, windowEndsAt: now + RESET_SIGNAL_FAILURE_WINDOW_MS }
      : { count: existing.count + 1, windowEndsAt: existing.windowEndsAt };
    failedLookupsByIp.delete(ip); // re-insert so this IP is most-recently-used
    failedLookupsByIp.set(ip, entry);
    if (failedLookupsByIp.size > RESET_SIGNAL_FAILURE_TRACKED_IPS_MAX) {
      const oldestIp = failedLookupsByIp.keys().next().value;
      if (oldestIp !== undefined) failedLookupsByIp.delete(oldestIp);
    }
  }

  function isBlockedForFailedLookups(ip: string): boolean {
    const existing = failedLookupsByIp.get(ip);
    if (!existing) return false;
    if (Date.now() >= existing.windowEndsAt) {
      failedLookupsByIp.delete(ip);
      return false;
    }
    return existing.count > RESET_SIGNAL_FAILURE_LIMIT;
  }

  app.get(
    '/auth/reset-signal',
    {
      config: { rateLimit: { max: RESET_SIGNAL_RATE_MAX, timeWindow: '1 minute', keyGenerator: resetSignalRateKey } },
      onRequest: async (req, reply) => {
        if (isBlockedForFailedLookups(req.ip)) {
          return reply.code(429).send({ error: 'Too many failed attempts' });
        }
      },
    },
    async (req, reply) => {
      const detail = await resolveSessionDetail(req.headers.authorization);
      if (!detail) {
        recordFailedLookup(req.ip);
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      const resetDue = isCtiResetDue(detail.ctiResetRequestedAt, detail.sessionCreatedAt);
      /**
       * R2 (controller ruling): self-heal a session that actually reset but
       * whose POST /auth/reset-complete never landed (e.g. it failed). Only
       * a session created AFTER the request could exist at all — that is
       * exactly "not due" — so pair that with "a reset is outstanding"
       * (requested_at newer than or equal to completed_at) and stamp
       * completed_at here too, so the Team panel never shows "pending"
       * forever for a rep who already signed back in.
       *
       * I1 (review fix): ctiResetRequestedAt never goes back to null — there
       * is no flag to clear (see migration 0045) — so a gate keyed on just
       * "requestedAt !== null" stays true for the rest of every session ever
       * created after a user's FIRST reset, attempting this UPDATE on every
       * single poll forever, not rarely. Checking ctiResetCompletedAt here
       * (free: it came back on the same SessionDetail, no extra query) is
       * what keeps the attempt itself rare — restricted to the narrow window
       * between a session going fresh and completed_at catching up. The SQL
       * WHERE's `coalesce` comparison stays as the race backstop: it can
       * still legitimately no-op if a concurrent request/complete raced this
       * read, but it is no longer the ONLY thing keeping this off the hot
       * path.
       */
      const resetOutstanding =
        detail.ctiResetRequestedAt !== null &&
        (detail.ctiResetCompletedAt === null ||
          detail.ctiResetRequestedAt.getTime() >= detail.ctiResetCompletedAt.getTime());
      if (!resetDue && resetOutstanding) {
        // M2 (review fix): this is a best-effort self-heal riding on top of a
        // route whose real job is just answering { resetDue }. A poll runs
        // every 20 s from every tab — a transient failure here (pool
        // exhaustion, a lock timeout, anything) must never turn a routine
        // poll into a 500. Caught, logged, and the normal response still
        // goes out; the next poll gets another chance at the same no-op-safe
        // guarded UPDATE.
        try {
          await getDb()
            .update(schema.users)
            .set({ ctiResetCompletedAt: sql`now()` })
            .where(
              and(
                eq(schema.users.id, detail.user.userId),
                sql`${schema.users.ctiResetRequestedAt} > coalesce(${schema.users.ctiResetCompletedAt}, 'epoch')`,
              ),
            );
        } catch (err) {
          req.log.warn({ err, userId: detail.user.userId }, 'cti_reset_signal_self_heal_failed');
        }
      }
      reply.header('cache-control', 'no-store');
      return { resetDue };
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

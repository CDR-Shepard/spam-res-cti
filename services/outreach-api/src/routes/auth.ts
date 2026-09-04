import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { issueSession, resolveSession, revokeSession, ServiceUserSessionError, SuspendedTenantError, type SessionUser } from '@cti/auth';
import type { SessionUser as SessionUserDto } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { IdentityExchangeError } from '../auth/identity-provider.js';
import { completeSignIn } from '../auth/sign-in.js';
import { signState, verifyState } from '../auth/state.js';
import type { AppConfig } from '../config.js';
import { sendError } from '../http/errors.js';
import { toTenantDto } from '../tenancy/scope.js';

export const HANDOFF_COOKIE = 'outreach_session_handoff';
const HANDOFF_PATH = '/api/auth/session';

export interface AuthRouteDeps {
  cfg: AppConfig;
  db: Db;
  /** null when WorkOS is not configured: sign-in routes answer 503. */
  idp: IdentityProvider | null;
}

const StartQuery = z.object({ returnTo: z.string().regex(/^\/(?!\/)/).optional() });
const CallbackQuery = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional(), error_description: z.string().optional() });

function toSessionUserDto(s: SessionUser, displayName: string | null): SessionUserDto {
  return { userId: s.userId, orgId: s.orgId, email: s.email, displayName, isAdmin: s.isAdmin, isSuperAdmin: s.isSuperAdmin, kind: 'human' };
}

function signInRedirect(cfg: AppConfig, reply: FastifyReply, error: string): FastifyReply {
  return reply.redirect(`${cfg.APP_PUBLIC_URL}/sign-in?error=${encodeURIComponent(error)}`);
}

async function userAndTenant(db: Db, session: SessionUser) {
  const [user, tenant] = await Promise.all([
    db.query.users.findFirst({ where: eq(schema.users.id, session.userId), columns: { displayName: true } }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, session.orgId) }),
  ]);
  return { user: toSessionUserDto(session, user?.displayName ?? null), tenant: tenant ? toTenantDto(tenant) : null };
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { cfg, db, idp } = deps;

  app.get('/auth/workos/start', async (req, reply) => {
    if (!idp) return sendError(reply, 503, 'SIGN_IN_DISABLED', 'Sign-in is not configured on this server');
    const q = StartQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'BAD_REQUEST', 'Invalid returnTo');
    const state = signState(cfg.SESSION_SECRET, { returnTo: q.data.returnTo });
    return reply.redirect(idp.authorizationUrl({ state }));
  });

  app.get('/auth/workos/callback', async (req, reply) => {
    if (!idp) return sendError(reply, 503, 'SIGN_IN_DISABLED', 'Sign-in is not configured on this server');
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'BAD_REQUEST', 'Missing state');
    const state = verifyState(cfg.SESSION_SECRET, q.data.state);
    if (!state) return sendError(reply, 400, 'BAD_STATE', 'Sign-in state is invalid or expired; start again');
    if (q.data.error || !q.data.code) return signInRedirect(cfg, reply, q.data.error ?? 'missing_code');
    try {
      const outcome = await completeSignIn({ db, idp }, q.data.code);
      if (!outcome.ok) return signInRedirect(cfg, reply, outcome.reason);
      const session = await issueSession(outcome.userId);
      const value = Buffer.from(JSON.stringify({ token: session.token, expiresAt: session.expiresAt.toISOString() }), 'utf8').toString('base64url');
      reply.setCookie(HANDOFF_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: HANDOFF_PATH, maxAge: 60 });
      const target = new URL('/auth/callback', cfg.APP_PUBLIC_URL);
      if (state.returnTo) target.searchParams.set('returnTo', state.returnTo);
      return reply.redirect(target.toString());
    } catch (err) {
      if (err instanceof IdentityExchangeError) return signInRedirect(cfg, reply, 'invalid_code');
      if (err instanceof SuspendedTenantError) return signInRedirect(cfg, reply, 'tenant_suspended');
      if (err instanceof ServiceUserSessionError) return signInRedirect(cfg, reply, 'forbidden');
      req.log.error({ err: (err as Error).message }, 'sign-in callback failed');
      return signInRedirect(cfg, reply, 'server_error');
    }
  });

  app.get('/auth/session', async (req, reply) => {
    const raw = req.cookies[HANDOFF_COOKIE];
    if (!raw) return sendError(reply, 401, 'NO_HANDOFF', 'No pending sign-in');
    reply.clearCookie(HANDOFF_COOKIE, { path: HANDOFF_PATH });
    let parsed: { token: string; expiresAt: string };
    try {
      parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { token: string; expiresAt: string };
    } catch {
      return sendError(reply, 401, 'NO_HANDOFF', 'Malformed sign-in handoff');
    }
    const session = await resolveSession(`Bearer ${parsed.token}`);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Session is not valid');
    const { user, tenant } = await userAndTenant(db, session);
    if (!tenant) return sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return { token: parsed.token, expiresAt: parsed.expiresAt, user, tenant };
  });

  app.get('/auth/me', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Sign in required');
    const { user, tenant } = await userAndTenant(db, session);
    if (!tenant) return sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return { user, tenant };
  });

  app.post('/auth/logout', async (req, reply) => {
    if (req.headers.authorization) await revokeSession(req.headers.authorization);
    return reply.code(204).send();
  });
}

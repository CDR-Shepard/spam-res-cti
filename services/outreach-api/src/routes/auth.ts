import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { issueSession, resolveSession, revokeSession, ServiceUserSessionError, SuspendedTenantError, type SessionUser } from '@cti/auth';
import type { SessionUser as SessionUserDto } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { IdentityProvider } from '../auth/identity-provider.js';
import { IdentityExchangeError } from '../auth/identity-provider.js';
import { completeSignIn } from '../auth/sign-in.js';
import { isSafeReturnTo, signState, verifyState } from '../auth/state.js';
import type { AppConfig } from '../config.js';
import { sendError } from '../http/errors.js';
import { toTenantDto } from '../tenancy/scope.js';

export const HANDOFF_COOKIE = 'outreach_session_handoff';
const HANDOFF_PATH = '/api/auth/session';
/** Set at /auth/workos/start, checked at /auth/workos/callback: binds the callback to the same browser that started the flow (login-CSRF defense — see auth/state.ts's SignedState). */
const NONCE_COOKIE = 'outreach_oauth_nonce';
const NONCE_PATH = '/api/auth/workos/callback';
/** Shape of the handoff cookie's decoded payload; anything else (including the JSON literal `null`) is treated as no handoff at all. */
const HandoffPayload = z.object({ token: z.string().min(1), expiresAt: z.string().datetime() });

export interface AuthRouteDeps {
  cfg: AppConfig;
  db: Db;
  /** null when WorkOS is not configured: the browser-facing sign-in routes redirect to `/sign-in?error=sign_in_disabled`. */
  idp: IdentityProvider | null;
}

const StartQuery = z.object({ returnTo: z.string().refine(isSafeReturnTo).optional() });
const CallbackQuery = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional(), error_description: z.string().optional() });

function toSessionUserDto(s: SessionUser, displayName: string | null): SessionUserDto {
  return { userId: s.userId, orgId: s.orgId, email: s.email, displayName, isAdmin: s.isAdmin, isSuperAdmin: s.isSuperAdmin, kind: 'human' };
}

/** `new URL(path, cfg.APP_PUBLIC_URL)` with optional query params — the one place both app-facing redirects (sign-in error, post-callback handoff) build their target. */
function appUrl(cfg: AppConfig, path: string, params?: Record<string, string>): URL {
  const url = new URL(path, cfg.APP_PUBLIC_URL);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

/** Back to the app's sign-in page with a reason; `returnTo` (only ever a *verified* one) rides along so the page's "Continue" re-targets the user's destination. */
function signInRedirect(cfg: AppConfig, reply: FastifyReply, error: string, returnTo?: string): FastifyReply {
  return reply.redirect(appUrl(cfg, '/sign-in', returnTo ? { error, returnTo } : { error }).toString());
}

/** Tenant guard: the resolved row must actually be the session's own org, not just fakeDb's/a bug's first row (see tenancy/scope.ts's identical guard). */
async function userAndTenant(db: Db, session: SessionUser) {
  const [user, tenant] = await Promise.all([
    db.query.users.findFirst({ where: eq(schema.users.id, session.userId), columns: { displayName: true } }),
    db.query.organizations.findFirst({ where: eq(schema.organizations.id, session.orgId) }),
  ]);
  const safeTenant = tenant && tenant.id === session.orgId ? toTenantDto(tenant) : null;
  return { user: toSessionUserDto(session, user?.displayName ?? null), tenant: safeTenant };
}

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { cfg, db, idp } = deps;

  app.get('/auth/workos/start', async (req, reply) => {
    // Reached by `window.location.assign(...)` — a top-level navigation, like the
    // callback — so failures redirect to the sign-in page rather than answering JSON.
    if (!idp) return signInRedirect(cfg, reply, 'sign_in_disabled');
    const q = StartQuery.safeParse(req.query);
    if (!q.success) return signInRedirect(cfg, reply, 'bad_return_to');
    const { state, nonce } = signState(cfg.SESSION_SECRET, { returnTo: q.data.returnTo });
    reply.setCookie(NONCE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: NONCE_PATH, maxAge: 600 });
    return reply.redirect(idp.authorizationUrl({ state }));
  });

  app.get('/auth/workos/callback', async (req, reply) => {
    // Every exit here is a top-level browser navigation back from the provider,
    // so failures redirect to the app's sign-in page with a reason (never a JSON
    // body the user cannot act on). Clear the nonce on every callback attempt,
    // success or not, before any branch can exit.
    reply.clearCookie(NONCE_COOKIE, { path: NONCE_PATH });
    if (!idp) return signInRedirect(cfg, reply, 'sign_in_disabled');
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return signInRedirect(cfg, reply, 'bad_state');
    const state = verifyState(cfg.SESSION_SECRET, q.data.state);
    if (!state) return signInRedirect(cfg, reply, 'bad_state');
    // Login-CSRF binding: the browser completing the callback must be the one
    // that started it (a second tab starting sign-in overwrites the cookie, so
    // the first tab's callback legitimately lands here too — hence a redirect).
    const nonceCookie = req.cookies[NONCE_COOKIE];
    if (!nonceCookie || nonceCookie !== state.nonce) return signInRedirect(cfg, reply, 'bad_state', state.returnTo);
    if (q.data.error || !q.data.code) return signInRedirect(cfg, reply, q.data.error ?? 'missing_code');
    try {
      const outcome = await completeSignIn({ db, idp }, q.data.code);
      if (!outcome.ok) return signInRedirect(cfg, reply, outcome.reason);
      const session = await issueSession(outcome.userId);
      const value = Buffer.from(JSON.stringify({ token: session.token, expiresAt: session.expiresAt.toISOString() }), 'utf8').toString('base64url');
      reply.setCookie(HANDOFF_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: HANDOFF_PATH, maxAge: 60, signed: true });
      const target = appUrl(cfg, '/auth/callback', state.returnTo ? { returnTo: state.returnTo } : undefined);
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
    const unsigned = reply.unsignCookie(raw);
    if (!unsigned.valid) return sendError(reply, 401, 'NO_HANDOFF', 'Malformed sign-in handoff');
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8'));
    } catch {
      return sendError(reply, 401, 'NO_HANDOFF', 'Malformed sign-in handoff');
    }
    const payload = HandoffPayload.safeParse(json);
    if (!payload.success) return sendError(reply, 401, 'NO_HANDOFF', 'Malformed sign-in handoff');
    const session = await resolveSession(`Bearer ${payload.data.token}`);
    if (!session) return sendError(reply, 401, 'UNAUTHENTICATED', 'Session is not valid');
    const { user, tenant } = await userAndTenant(db, session);
    if (!tenant) return sendError(reply, 403, 'TENANT_FORBIDDEN', 'Unknown tenant');
    return { token: payload.data.token, expiresAt: payload.data.expiresAt, user, tenant };
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

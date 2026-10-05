/**
 * The hand-off every sign-in provider ends with: issue the outreach session, park it in a
 * short-lived signed cookie scoped to GET /api/auth/session, and send the browser to the
 * app's /auth/callback (which exchanges the cookie for the bearer token exactly once).
 */
import type { FastifyReply } from 'fastify';
import { issueSession } from '@cti/auth';
import type { AppConfig } from '../config.js';

export const HANDOFF_COOKIE = 'outreach_session_handoff';
export const HANDOFF_PATH = '/api/auth/session';

/** `new URL(path, cfg.APP_PUBLIC_URL)` with optional query params — the one place both app-facing redirects (sign-in error, post-callback handoff) build their target. */
export function appUrl(cfg: AppConfig, path: string, params?: Record<string, string>): URL {
  const url = new URL(path, cfg.APP_PUBLIC_URL);
  for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value);
  return url;
}

/** Back to the app's sign-in page with a reason; `returnTo` (only ever a *verified* one) rides along so the page's "Continue" re-targets the user's destination. */
export function signInRedirect(cfg: AppConfig, reply: FastifyReply, error: string, returnTo?: string): FastifyReply {
  return reply.redirect(appUrl(cfg, '/sign-in', returnTo ? { error, returnTo } : { error }).toString());
}

/** Issue the outreach session and the short-lived handoff cookie, then send the browser to the app's /auth/callback. Shared by every sign-in provider. */
export async function issueHandoff(reply: FastifyReply, cfg: AppConfig, userId: string, returnTo?: string): Promise<FastifyReply> {
  const session = await issueSession(userId);
  const value = Buffer.from(JSON.stringify({ token: session.token, expiresAt: session.expiresAt.toISOString() }), 'utf8').toString('base64url');
  reply.setCookie(HANDOFF_COOKIE, value, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: HANDOFF_PATH, maxAge: 60, signed: true });
  return reply.redirect(appUrl(cfg, '/auth/callback', returnTo ? { returnTo } : undefined).toString());
}

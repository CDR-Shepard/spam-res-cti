/**
 * Sign in with Salesforce (plan 1C Part 0): the CTI's External Client App, Authorization Code +
 * PKCE, no secret. The callback maps the Salesforce identity to a user the CTI already has
 * (auth/salesforce-user.ts) and ends in the same session handoff the WorkOS callback issues.
 * Every exit is a top-level browser navigation, so failures redirect to /sign-in?error=<reason>.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ServiceUserSessionError, SuspendedTenantError } from '@cti/auth';
import type { Db } from '@cti/db';
import { pkcePair } from '@cti/salesforce';
import { issueHandoff, signInRedirect } from '../auth/handoff.js';
import { readSalesforceIdentity, salesforceSignInUrl, SalesforceSignInError, type SalesforceSignInConfig } from '../auth/salesforce-identity.js';
import { matchSalesforceUser } from '../auth/salesforce-user.js';
import { isSafeReturnTo, signState, verifyState } from '../auth/state.js';
import type { AppConfig } from '../config.js';

/** Set at /auth/salesforce/start (`<nonce>.<pkce verifier>`, signed), read and cleared at the callback: binds it to the browser that started the flow. */
export const SF_SIGNIN_COOKIE = 'outreach_sf_signin';
const SF_SIGNIN_PATH = '/api/auth/salesforce/callback';
const StartQuery = z.object({ returnTo: z.string().refine(isSafeReturnTo).optional() });
const CallbackQuery = z.object({ code: z.string().optional(), state: z.string(), error: z.string().optional() });

export interface SalesforceAuthDeps {
  cfg: AppConfig;
  db: Db;
  /** null when sign-in is not configured: both routes redirect to `/sign-in?error=sign_in_disabled`. */
  signIn: SalesforceSignInConfig | null;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export async function registerSalesforceAuthRoutes(app: FastifyInstance, deps: SalesforceAuthDeps): Promise<void> {
  const { cfg, db, signIn } = deps;

  app.get('/auth/salesforce/start', async (req, reply) => {
    if (!signIn) return signInRedirect(cfg, reply, 'sign_in_disabled');
    const q = StartQuery.safeParse(req.query);
    if (!q.success) return signInRedirect(cfg, reply, 'bad_return_to');
    const { state, nonce } = signState(cfg.SESSION_SECRET, { returnTo: q.data.returnTo });
    const { verifier, challenge } = pkcePair();
    reply.setCookie(SF_SIGNIN_COOKIE, `${nonce}.${verifier}`, { httpOnly: true, sameSite: 'lax', secure: cfg.NODE_ENV === 'production', path: SF_SIGNIN_PATH, maxAge: 600, signed: true });
    return reply.redirect(salesforceSignInUrl(signIn, { state, codeChallenge: challenge }));
  });

  app.get('/auth/salesforce/callback', async (req, reply) => {
    // Clear the cookie on every attempt, success or not, before any branch can exit.
    reply.clearCookie(SF_SIGNIN_COOKIE, { path: SF_SIGNIN_PATH });
    if (!signIn) return signInRedirect(cfg, reply, 'sign_in_disabled');
    const q = CallbackQuery.safeParse(req.query);
    if (!q.success) return signInRedirect(cfg, reply, 'bad_state');
    const state = verifyState(cfg.SESSION_SECRET, q.data.state);
    if (!state) return signInRedirect(cfg, reply, 'bad_state');
    // `base64url` (the PKCE verifier and the state nonce) contains no '.', so split('.', 2) is safe.
    const raw = req.cookies[SF_SIGNIN_COOKIE];
    const unsigned = raw ? reply.unsignCookie(raw) : null;
    const [nonce, verifier] = unsigned?.valid && unsigned.value ? unsigned.value.split('.', 2) : [];
    if (!nonce || !verifier || nonce !== state.nonce) return signInRedirect(cfg, reply, 'bad_state', state.returnTo);
    if (q.data.error || !q.data.code) return signInRedirect(cfg, reply, q.data.error === 'access_denied' ? 'access_denied' : 'missing_code');
    try {
      const identity = await readSalesforceIdentity(signIn, q.data.code, verifier, { fetchImpl: deps.fetchImpl, sleep: deps.sleep, log: req.log });
      const match = await matchSalesforceUser(db, identity);
      if (!match.ok) {
        req.log.info({ reason: match.reason }, 'salesforce sign-in refused');
        return signInRedirect(cfg, reply, match.reason);
      }
      return await issueHandoff(reply, cfg, match.userId, state.returnTo);
    } catch (err) {
      if (err instanceof SalesforceSignInError) return signInRedirect(cfg, reply, err.reason);
      if (err instanceof SuspendedTenantError) return signInRedirect(cfg, reply, 'tenant_suspended');
      if (err instanceof ServiceUserSessionError) return signInRedirect(cfg, reply, 'forbidden');
      req.log.error({ errName: (err as Error).name }, 'salesforce sign-in callback failed');
      return signInRedirect(cfg, reply, 'server_error');
    }
  });
}

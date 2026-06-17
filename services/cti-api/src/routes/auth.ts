/**
 * Auth routes:
 *  - POST /auth/dev-session   → issue a session for the seeded dev user (MVP only).
 *  - GET  /auth/me            → identity of the session bearer.
 *  - POST /auth/salesforce/start    → returns { authUrl, handshake } for browser flow.
 *  - GET  /auth/salesforce/callback → Salesforce OAuth callback (no session header).
 *  - GET  /auth/salesforce/status?handshake=…  → desktop poll for connection result.
 *  - POST /auth/salesforce/disconnect
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, schema } from '../db/index.js';
import { issueSession, resolveSession } from '../auth/session.js';
import { buildStartArtifacts, exchangeCodeForTokens, fetchProfilePhoto, fetchUserInfo } from '../salesforce/oauth.js';
import { encryptString } from '../crypto.js';
import { loadConfig } from '../config.js';

const DEV_USER_ID = '00000000-0000-0000-0000-00000000beef';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/dev-session', async (_req, reply) => {
    // The dev-session backdoor issues a real 30-day session with no
    // credentials. It MUST NOT exist in production — gate it behind NODE_ENV.
    // Replace with real SSO before any production deployment.
    if (loadConfig().NODE_ENV === 'production') {
      return reply.code(404).send({ error: 'Not found' });
    }
    const db = getDb();
    const user = await db.query.users.findFirst({ where: eq(schema.users.id, DEV_USER_ID) });
    if (!user) {
      return reply.code(500).send({ error: 'Dev user not seeded; run npm run migrate' });
    }
    const session = await issueSession(user.id);
    return {
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, orgId: user.orgId },
    };
  });

  app.get('/auth/me', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const sfConn = await db.query.salesforceConnections.findFirst({
      where: eq(schema.salesforceConnections.userId, session.userId),
    });
    return {
      user: session,
      salesforce: sfConn
        ? {
            connected: true,
            instanceUrl: sfConn.instanceUrl,
            sfUserId: sfConn.sfUserId,
            sfOrgId: sfConn.sfOrgId,
            scope: sfConn.scope,
            updatedAt: sfConn.updatedAt,
            name: sfConn.sfUserName,
            email: sfConn.sfUserEmail,
            photoDataUrl:
              sfConn.sfPhotoB64 && sfConn.sfPhotoContentType
                ? `data:${sfConn.sfPhotoContentType};base64,${sfConn.sfPhotoB64}`
                : null,
          }
        : { connected: false },
    };
  });

  app.post('/auth/salesforce/start', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    let artifacts;
    try {
      artifacts = buildStartArtifacts();
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    await db.insert(schema.salesforceOauthState).values({
      state: artifacts.state,
      pkceVerifier: artifacts.verifier,
      userId: session.userId,
      desktopHandshakeToken: artifacts.handshake,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return { authUrl: artifacts.authUrl, handshake: artifacts.handshake };
  });

  // "Sign in with Salesforce" — no existing session required. The callback
  // find-or-creates the org+user from the SF identity and the login-status poll
  // hands back a session. This is the primary production login (the dev-session
  // backdoor is disabled in prod).
  app.post('/auth/salesforce/login/start', async (_req, reply) => {
    const db = getDb();
    let artifacts;
    try {
      artifacts = buildStartArtifacts();
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    await db.insert(schema.salesforceOauthState).values({
      state: artifacts.state,
      pkceVerifier: artifacts.verifier,
      userId: null, // null userId => callback treats this as a LOGIN
      desktopHandshakeToken: artifacts.handshake,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return { authUrl: artifacts.authUrl, handshake: artifacts.handshake };
  });

  const callbackQuery = z.object({
    code: z.string().optional(),
    state: z.string(),
    error: z.string().optional(),
    error_description: z.string().optional(),
  });

  app.get('/auth/salesforce/callback', async (req, reply) => {
    const parsed = callbackQuery.safeParse(req.query);
    if (!parsed.success) return reply.code(400).type('text/html').send(htmlPage('Bad request', 'Missing or invalid state.'));
    const { code, state, error, error_description } = parsed.data;

    const db = getDb();
    const stateRow = await db.query.salesforceOauthState.findFirst({
      where: eq(schema.salesforceOauthState.state, state),
    });
    if (!stateRow || stateRow.consumedAt || stateRow.expiresAt < new Date()) {
      return reply.code(400).type('text/html').send(htmlPage('Invalid state', 'Try signing in again from the app.'));
    }
    // Login mode (no pre-existing user) vs connect mode (augment current user).
    const isLogin = !stateRow.userId;

    if (error || !code) {
      await db
        .update(schema.salesforceOauthState)
        .set({ consumedAt: new Date() })
        .where(eq(schema.salesforceOauthState.state, state));
      return reply
        .type('text/html')
        .send(htmlPage('Salesforce login canceled', error_description ?? error ?? 'No code returned. You can close this window.'));
    }

    try {
      const tok = await exchangeCodeForTokens(code, stateRow.pkceVerifier);

      // Org allowlist gate (login only): only the configured Salesforce org may
      // self-provision accounts here.
      const allowedOrg = loadConfig().SALESFORCE_ALLOWED_ORG_ID;
      if (isLogin && allowedOrg && tok.sfOrgId.slice(0, 15) !== allowedOrg.slice(0, 15)) {
        await db
          .update(schema.salesforceOauthState)
          .set({ consumedAt: new Date() })
          .where(eq(schema.salesforceOauthState.state, state));
        app.log.warn({ sfOrgId: tok.sfOrgId }, 'salesforce_login_org_not_allowed');
        return reply
          .code(403)
          .type('text/html')
          .send(htmlPage('Salesforce org not authorized', 'This Salesforce organization is not authorized to use this app. Contact your administrator.'));
      }

      const enc = {
        access: encryptString(tok.access_token),
        refresh: tok.refresh_token ? encryptString(tok.refresh_token) : null,
      };

      // Best-effort profile fetch; failure here doesn't block the connect.
      let profile: {
        sfUserName: string | null;
        sfUserEmail: string | null;
        sfPhotoB64: string | null;
        sfPhotoContentType: string | null;
        sfProfileFetchedAt: Date | null;
      } = {
        sfUserName: null,
        sfUserEmail: null,
        sfPhotoB64: null,
        sfPhotoContentType: null,
        sfProfileFetchedAt: null,
      };
      // SF's /oauth2/userinfo can 401 immediately after token exchange (the
      // token isn't always queryable for a beat). Retry a few times with
      // backoff before giving up — the connection still saves either way.
      async function fetchProfileWithRetry(): Promise<void> {
        const delays = [0, 500, 1500, 3500]; // 4 attempts, up to ~5.5s total
        for (let i = 0; i < delays.length; i++) {
          if (delays[i]! > 0) await new Promise((r) => setTimeout(r, delays[i]!));
          try {
            const info = await fetchUserInfo(tok.access_token, tok.instance_url);
            profile.sfUserName = info.name ?? null;
            profile.sfUserEmail = info.email ?? null;
            profile.sfProfileFetchedAt = new Date();
            if (info.picture) {
              const photo = await fetchProfilePhoto(info.picture, tok.access_token);
              if (photo) {
                profile.sfPhotoB64 = photo.base64;
                profile.sfPhotoContentType = photo.contentType;
              }
            }
            return; // success
          } catch (e) {
            if (i === delays.length - 1) {
              app.log.warn({ err: e, attempts: i + 1 }, 'salesforce_profile_fetch_failed');
            } else {
              app.log.debug({ err: e, attempt: i + 1 }, 'salesforce_profile_fetch_retry');
            }
          }
        }
      }
      await fetchProfileWithRetry();

      // Resolve the user this connection belongs to. In login mode, find-or-create
      // the local org (keyed by SF org id) and the user (keyed by email).
      let targetUserId: string;
      if (isLogin) {
        let org = await db.query.organizations.findFirst({
          where: eq(schema.organizations.sfOrgId, tok.sfOrgId),
        });
        const orgIsNew = !org;
        if (!org) {
          const [createdOrg] = await db
            .insert(schema.organizations)
            .values({ name: `Salesforce Org ${tok.sfOrgId}`, sfOrgId: tok.sfOrgId })
            .returning();
          org = createdOrg!;
        }
        const email = (profile.sfUserEmail?.trim() || `sf-${tok.sfUserId}@${tok.sfOrgId}.salesforce.local`).toLowerCase();
        // The first user provisioned for a brand-new org is the admin; plus any
        // emails in ADMIN_EMAILS. Admins manage numbers/assignment/campaigns.
        const adminEmails = (loadConfig().ADMIN_EMAILS ?? '')
          .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
        const shouldBeAdmin = orgIsNew || adminEmails.includes(email);
        let user = await db.query.users.findFirst({ where: eq(schema.users.email, email) });
        if (!user) {
          const [createdUser] = await db
            .insert(schema.users)
            .values({ orgId: org.id, email, displayName: profile.sfUserName ?? null, isAdmin: shouldBeAdmin })
            .returning();
          user = createdUser!;
        } else if (shouldBeAdmin && !user.isAdmin) {
          await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, user.id));
        }
        targetUserId = user.id;
      } else {
        targetUserId = stateRow.userId!;
      }

      const existing = await db.query.salesforceConnections.findFirst({
        where: eq(schema.salesforceConnections.userId, targetUserId),
      });
      if (existing) {
        await db
          .update(schema.salesforceConnections)
          .set({
            instanceUrl: tok.instance_url,
            sfUserId: tok.sfUserId,
            sfOrgId: tok.sfOrgId,
            accessTokenEnc: enc.access,
            refreshTokenEnc: enc.refresh ?? existing.refreshTokenEnc,
            scope: tok.scope ?? null,
            issuedAt: new Date(),
            updatedAt: new Date(),
            ...profile,
          })
          .where(eq(schema.salesforceConnections.id, existing.id));
      } else {
        await db.insert(schema.salesforceConnections).values({
          userId: targetUserId,
          instanceUrl: tok.instance_url,
          sfUserId: tok.sfUserId,
          sfOrgId: tok.sfOrgId,
          accessTokenEnc: enc.access,
          refreshTokenEnc: enc.refresh,
          scope: tok.scope ?? null,
          ...profile,
        });
      }
      await db
        .update(schema.salesforceOauthState)
        .set({ consumedAt: new Date(), ...(isLogin ? { loginUserId: targetUserId } : {}) })
        .where(eq(schema.salesforceOauthState.state, state));
      return reply
        .type('text/html')
        .send(htmlPage(isLogin ? 'Signed in with Salesforce' : 'Salesforce connected', 'You can close this window and return to the CTI app.'));
    } catch (err) {
      app.log.error({ err }, 'salesforce_callback_failed');
      return reply
        .code(500)
        .type('text/html')
        .send(htmlPage(
          'Salesforce connection failed',
          'Something went wrong completing the Salesforce sign-in. You can close this window and try again from the app.',
        ));
    }
  });

  app.get('/auth/salesforce/status', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const q = z.object({ handshake: z.string() }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'handshake required' });
    const db = getDb();
    const stateRow = await db.query.salesforceOauthState.findFirst({
      where: and(
        eq(schema.salesforceOauthState.desktopHandshakeToken, q.data.handshake),
        eq(schema.salesforceOauthState.userId, session.userId),
      ),
    });
    if (!stateRow) return { status: 'unknown' };
    if (!stateRow.consumedAt) return { status: 'pending' };
    const conn = await db.query.salesforceConnections.findFirst({
      where: eq(schema.salesforceConnections.userId, session.userId),
    });
    return conn ? { status: 'connected' } : { status: 'failed' };
  });

  // Login-status poll (NO session): the client polls with the handshake from
  // /login/start. Once the OAuth callback has completed, this mints exactly one
  // session for the resolved user and returns it. The handshake is the bearer
  // of trust; minting is single-use (session_retrieved_at), short-lived (10m).
  app.get('/auth/salesforce/login/status', async (req, reply) => {
    const q = z.object({ handshake: z.string().min(8) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'handshake required' });
    const db = getDb();
    const stateRow = await db.query.salesforceOauthState.findFirst({
      where: eq(schema.salesforceOauthState.desktopHandshakeToken, q.data.handshake),
    });
    if (!stateRow) return { status: 'unknown' };
    if (!stateRow.consumedAt) return { status: 'pending' };
    if (!stateRow.loginUserId) return { status: 'failed' }; // canceled or org-gated
    // Claim the single-use session mint atomically so concurrent polls can't
    // each mint a session.
    const claim = await db
      .update(schema.salesforceOauthState)
      .set({ sessionRetrievedAt: new Date() })
      .where(
        and(
          eq(schema.salesforceOauthState.state, stateRow.state),
          isNull(schema.salesforceOauthState.sessionRetrievedAt),
        ),
      )
      .returning({ state: schema.salesforceOauthState.state });
    if (claim.length === 0) return { status: 'done' }; // already minted once
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, stateRow.loginUserId),
    });
    if (!user) return { status: 'failed' };
    const session = await issueSession(user.id);
    return {
      status: 'connected',
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      user: { id: user.id, email: user.email, displayName: user.displayName, orgId: user.orgId },
    };
  });

  app.post('/auth/salesforce/refresh-profile', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const conn = await db.query.salesforceConnections.findFirst({
      where: eq(schema.salesforceConnections.userId, session.userId),
    });
    if (!conn) return reply.code(404).send({ error: 'Not connected to Salesforce' });
    // Reuse the SF REST client's access token (auto-refreshes on 401).
    // The userinfo + photo fetchers operate with a fresh access token via
    // the same accessTokenEnc we already store.
    const { decryptString } = await import('../crypto.js');
    let accessToken: string;
    try {
      accessToken = decryptString(conn.accessTokenEnc);
    } catch {
      return reply.code(500).send({ error: 'Bad stored token' });
    }
    try {
      const info = await fetchUserInfo(accessToken, conn.instanceUrl);
      let photoB64: string | null = null;
      let photoCt: string | null = null;
      if (info.picture) {
        const photo = await fetchProfilePhoto(info.picture, accessToken);
        if (photo) { photoB64 = photo.base64; photoCt = photo.contentType; }
      }
      await db
        .update(schema.salesforceConnections)
        .set({
          sfUserName: info.name ?? null,
          sfUserEmail: info.email ?? null,
          sfPhotoB64: photoB64,
          sfPhotoContentType: photoCt,
          sfProfileFetchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.salesforceConnections.id, conn.id));
      return { ok: true, name: info.name, email: info.email, hasPhoto: !!photoB64 };
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/auth/salesforce/disconnect', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    await db
      .delete(schema.salesforceConnections)
      .where(eq(schema.salesforceConnections.userId, session.userId));
    return { ok: true };
  });
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:48px auto;max-width:480px;color:#222}
h1{font-size:18px;margin-bottom:8px}p{color:#555}</style>
<h1>${escape(title)}</h1><p>${escape(body)}</p>`;
}
function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

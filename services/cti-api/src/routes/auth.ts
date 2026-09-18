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
import { getDb, schema } from '@cti/db';
import { createTenant, encryptString, humanUserByEmail, issueSession, resolveSession } from '@cti/auth';
import { buildStartArtifacts, exchangeCodeForTokens, fetchProfileName, fetchProfilePhoto, fetchUserInfo } from '../salesforce/oauth.js';
import { normalize } from '@cti/phone';
import { loadConfig } from '../config.js';
import { ensureCtiPermissionSetLive } from '../salesforce/permission-set-live.js';
import { assignStarterNumbersLive } from '../fleet/auto-assign-live.js';

const DEV_USER_ID = '00000000-0000-0000-0000-00000000beef';

/**
 * The PATCH /auth/me body — exported so routes/auth.test.ts pins THIS schema.
 * Each field is optional so a caller can change one setting without knowing
 * the other; an empty body is refused rather than silently doing nothing.
 */
export const PatchMeBody = z
  .object({
    noAnswerForwardE164: z.string().nullable().optional(),
    dialerHoldMusic: z.boolean().optional(),
  })
  .refine((b) => b.noAnswerForwardE164 !== undefined || b.dialerHoldMusic !== undefined, {
    message: 'nothing to update',
  });

/**
 * Give a rep who has just signed in their starter numbers, if they hold none.
 *
 * Same shape and same reason as `ensurePermissionSetOnConnect` below: it runs
 * inside the unauthenticated OAuth callback, which has no route harness, so the
 * lookup it does and its throw-safety are pinned here on an extracted helper.
 *
 * Unlike the permission-set hook this does NOT wait for the power dialer to be
 * switched on. Numbers are what the softphone dials from at all — manual calls
 * included — so a rep needs them the moment they can sign in.
 *
 * Resolves to the outcome, or null if the user vanished. NEVER rejects.
 */
export async function assignStarterNumbersOnConnect(
  deps: {
    findUser: (userId: string) => Promise<{ orgId: string; email: string } | undefined>;
    assign: (who: { orgId: string; userId: string; email: string }) => Promise<unknown>;
  },
  targetUserId: string,
): Promise<unknown | null> {
  try {
    const user = await deps.findUser(targetUserId);
    if (!user) return null;
    // The org and email come from the USER ROW, never from the request: this is
    // what keeps a sign-in from claiming another tenant's reserve.
    return await deps.assign({ orgId: user.orgId, userId: targetUserId, email: user.email });
  } catch {
    return null;
  }
}

/**
 * Grant the CTI permission set to a rep who has just connected Salesforce, if
 * they are switched on for the power dialer.
 *
 * Extracted and exported so the gate, the org it passes, and its throw-safety
 * are testable: this runs inside the unauthenticated OAuth callback, which has
 * no route harness, and an untested branch there is the wrong kind of quiet.
 *
 * Resolves to the outcome, or to null when there was nothing to do. NEVER
 * rejects — every caller is on a response path that must not fail because of it.
 */
export async function ensurePermissionSetOnConnect(
  deps: {
    /** Returns the target's org and dialer flag, or undefined if they vanished. */
    findUser: (userId: string) => Promise<{ orgId: string; powerDialerEnabled: boolean } | undefined>;
    ensure: (a: { orgId: string; targetUserId: string }) => Promise<unknown>;
  },
  targetUserId: string,
): Promise<unknown | null> {
  try {
    const connected = await deps.findUser(targetUserId);
    // Not enabled for the dialer means they write no Tasks through the CTI, so
    // there is nothing for the marker field to be useful on yet. The admin
    // toggle grants it at the moment that changes.
    if (!connected?.powerDialerEnabled) return null;
    return await deps.ensure({ orgId: connected.orgId, targetUserId });
  } catch {
    return null;
  }
}

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
    const [profile, sfConn] = await Promise.all([
      db.query.users.findFirst({
        where: eq(schema.users.id, session.userId),
        columns: { noAnswerForwardE164: true, dialerHoldMusic: true },
      }),
      db.query.salesforceConnections.findFirst({
        where: eq(schema.salesforceConnections.userId, session.userId),
      }),
    ]);
    return {
      user: {
        ...session,
        noAnswerForwardE164: profile?.noAnswerForwardE164 ?? null,
        dialerHoldMusic: profile?.dialerHoldMusic ?? true,
      },
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

  /**
   * Self-service profile update. Currently just the no-answer failover number:
   * where an unanswered inbound callback to any DID this rep is rung on should
   * roll over to (their cell) before voicemail. Send `null`/`""` to clear.
   * Reps set this for themselves — no admin role required.
   */
  app.patch('/auth/me', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const parsed = PatchMeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });

    const db = getDb();
    const patch: { noAnswerForwardE164?: string | null; dialerHoldMusic?: boolean } = {};
    if (parsed.data.dialerHoldMusic !== undefined) patch.dialerHoldMusic = parsed.data.dialerHoldMusic;
    let forwardE164: string | null = null;
    const raw = parsed.data.noAnswerForwardE164?.trim();
    if (raw) {
      const norm = normalize(raw);
      if (!norm.ok || !norm.value) return reply.code(400).send({ error: 'Invalid forwarding number' });
      forwardE164 = norm.value.e164;
      // Guard against a forwarding loop: refuse to point the failover at one of
      // this org's own DIDs, which would just ring back into our inbound handler.
      const ownDid = await db.query.outboundNumbers.findFirst({
        where: and(
          eq(schema.outboundNumbers.orgId, session.orgId),
          eq(schema.outboundNumbers.e164, forwardE164),
        ),
        columns: { id: true },
      });
      if (ownDid) {
        return reply
          .code(400)
          .send({ error: 'Cannot forward to one of your own calling numbers' });
      }
    }

    if (parsed.data.noAnswerForwardE164 !== undefined) patch.noAnswerForwardE164 = forwardE164;
    await db.update(schema.users).set(patch).where(eq(schema.users.id, session.userId));
    return { ok: true, ...patch };
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
          // New tenant from a first Salesforce login: org + AI Agent service
          // user + default campaign, in one transaction (see @cti/auth createTenant).
          const created = await createTenant(db, { name: `Salesforce Org ${tok.sfOrgId}`, sfOrgId: tok.sfOrgId });
          org = created.org;
        }
        const email = (profile.sfUserEmail?.trim() || `sf-${tok.sfUserId}@${tok.sfOrgId}.salesforce.local`).toLowerCase();
        // App-admin (manage + ASSIGN outbound numbers) is driven by the
        // Salesforce Profile: only users on an allowed profile (default
        // "System Administrator") are admins. ADMIN_EMAILS is an explicit
        // operator override, and the first user of a brand-new org bootstraps
        // admin so nobody is locked out. A rep on any other profile is never an
        // admin and thus can never assign numbers (the /admin routes 403 them).
        const cfg = loadConfig();
        const adminEmails = (cfg.ADMIN_EMAILS ?? '')
          .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
        const adminProfiles = (cfg.SALESFORCE_ADMIN_PROFILES ?? 'System Administrator')
          .split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
        const sfProfileName = await fetchProfileName(tok.access_token, tok.instance_url, tok.sfUserId);
        const profileKnown = sfProfileName != null;
        const isSysAdminProfile = profileKnown && adminProfiles.includes(sfProfileName!.toLowerCase());
        const explicitAdmin = adminEmails.includes(email);
        if (isLogin) app.log.info(
          { email, sfProfile: sfProfileName ?? '(unknown)', isSysAdminProfile, explicitAdmin, orgIsNew },
          'salesforce_login_admin_resolve',
        );
        let user = await db.query.users.findFirst({ where: humanUserByEmail(org.id, email) });
        if (!user) {
          const shouldBeAdmin = isSysAdminProfile || explicitAdmin || orgIsNew;
          const [createdUser] = await db
            .insert(schema.users)
            .values({ orgId: org.id, email, displayName: profile.sfUserName ?? null, isAdmin: shouldBeAdmin })
            .returning();
          user = createdUser!;
        } else {
          // Re-sync admin rights to the CURRENT Salesforce profile on every login
          // — promote AND demote — so a rep can never keep admin and a profile
          // change takes effect immediately. Guardrails against lockout: never
          // demote an explicit ADMIN_EMAILS admin, and if the profile lookup
          // failed (profileKnown === false) leave admin status untouched rather
          // than risk demoting the org's only admin on a transient error.
          const target = profileKnown ? (isSysAdminProfile || explicitAdmin) : (explicitAdmin || user.isAdmin);
          if (user.isAdmin !== target) {
            await db.update(schema.users).set({ isAdmin: target }).where(eq(schema.users.id, user.id));
          }
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

      // The other half of the automatic permission-set grant. The admin toggle
      // covers "enabled after connecting"; this covers the reverse order, which
      // is the common one for a new hire — switched on first, connects
      // Salesforce later. Only now do we know their Salesforce user id.
      //
      // Off the response path and behind its OWN guard. The connection row and
      // consumedAt are already committed, so the rep's sign-in has succeeded no
      // matter what happens next; without this guard a pool blip on the user
      // lookup would fall into the outer catch and render "Salesforce
      // connection failed" over a sign-in that actually worked.
      // Starter numbers for a rep who holds none — so a new hire can dial the
      // moment they sign in, with no operator in the loop. Off the response path
      // and self-guarding, exactly like the permission-set hook below.
      void assignStarterNumbersOnConnect(
        {
          findUser: (id) =>
            db.query.users.findFirst({
              where: eq(schema.users.id, id),
              columns: { orgId: true, email: true },
            }),
          assign: assignStarterNumbersLive,
        },
        targetUserId,
      ).then((outcome) => {
        const o = outcome as { status?: string; shortLa?: number; shortSd?: number } | null;
        if (!o || o.status === 'already') return; // every sign-in but the first: stay quiet
        // A dry reserve is the one outcome someone has to act on (buy more), so
        // it is a warn; a clean first assignment is an info.
        const loud = o.status === 'failed' || (o.shortLa ?? 0) > 0 || (o.shortSd ?? 0) > 0;
        (loud ? app.log.warn : app.log.info).call(app.log, { target: targetUserId, outcome }, 'starter_numbers_on_connect');
      });

      void ensurePermissionSetOnConnect(
        {
          findUser: (id) =>
            db.query.users.findFirst({
              where: eq(schema.users.id, id),
              columns: { orgId: true, powerDialerEnabled: true },
            }),
          ensure: ensureCtiPermissionSetLive,
        },
        targetUserId,
      ).then((outcome) => {
        if (outcome) app.log.info({ target: targetUserId, outcome }, 'cti_permission_set_ensure_on_connect');
      });
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
    const user = await db.query.users.findFirst({
      where: eq(schema.users.id, stateRow.loginUserId),
    });
    if (!user) return { status: 'failed' };
    if (user.kind === 'service') return { status: 'failed' }; // service users can never hold a session; don't burn the single-use claim
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
    const { decryptString } = await import('@cti/auth');
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

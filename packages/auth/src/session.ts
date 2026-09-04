/**
 * Opaque bearer sessions. The backend issues a random token, stores only its
 * sha256, and resolves it to the owning user. Any client (softphone, desktop,
 * iOS, product web app) exchanges its own sign-in for one of these, so every
 * service authorizes the same way.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema, type UserKind } from '@cti/db';
import { randomToken, sha256 } from './crypto.js';

const DEFAULT_TTL_DAYS = 30;

export interface SessionUser {
  userId: string;
  orgId: string;
  email: string;
  isAdmin: boolean;
  powerDialerEnabled: boolean;
  kind: UserKind;
  isSuperAdmin: boolean;
}

/** A tenant's AI Agent (kind = 'service') acts through attribution, never through a session. */
export class ServiceUserSessionError extends Error {
  constructor(userId: string) {
    super(`Service user ${userId} cannot hold a session`);
    this.name = 'ServiceUserSessionError';
  }
}

export async function issueSession(userId: string, ttlDays = DEFAULT_TTL_DAYS): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, userId) });
  if (!user) throw new Error('Unknown user');
  if (user.kind === 'service') throw new ServiceUserSessionError(userId);
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  await db.insert(schema.sessions).values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

function bearerToken(bearer: string | undefined): string | null {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  return token || null;
}

export async function resolveSession(bearer: string | undefined): Promise<SessionUser | null> {
  const token = bearerToken(bearer);
  if (!token) return null;
  const db = getDb();
  const row = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.tokenHash, sha256(token)),
      gt(schema.sessions.expiresAt, new Date()),
      isNull(schema.sessions.revokedAt),
    ),
  });
  if (!row) return null;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, row.userId) });
  if (!user || user.kind === 'service') return null;
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    isAdmin: user.isAdmin,
    powerDialerEnabled: user.powerDialerEnabled,
    kind: user.kind,
    isSuperAdmin: user.isSuperAdmin,
  };
}

export async function revokeSession(bearer: string): Promise<void> {
  const token = bearerToken(bearer);
  if (!token) return;
  await getDb()
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, sha256(token)));
}

/**
 * Desktop ↔ backend session.
 *
 * MVP design: the backend issues opaque session tokens for a known dev user.
 * The desktop stores the session token in OS keychain via Electron safeStorage.
 * For real multi-user deployment, add a sign-in flow that returns one of these tokens.
 */
import { and, eq, gt, isNull } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { randomToken, sha256 } from '../crypto.js';

const DEFAULT_TTL_DAYS = 30;

export async function issueSession(userId: string, ttlDays = DEFAULT_TTL_DAYS): Promise<{ token: string; expiresAt: Date }> {
  const db = getDb();
  const token = randomToken(32);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  await db.insert(schema.sessions).values({ userId, tokenHash, expiresAt });
  return { token, expiresAt };
}

export async function resolveSession(bearer: string | undefined): Promise<{
  userId: string;
  orgId: string;
  email: string;
} | null> {
  if (!bearer) return null;
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  if (!token) return null;
  const tokenHash = sha256(token);
  const db = getDb();
  const row = await db.query.sessions.findFirst({
    where: and(
      eq(schema.sessions.tokenHash, tokenHash),
      gt(schema.sessions.expiresAt, new Date()),
      isNull(schema.sessions.revokedAt),
    ),
  });
  if (!row) return null;
  const user = await db.query.users.findFirst({ where: eq(schema.users.id, row.userId) });
  if (!user) return null;
  return { userId: user.id, orgId: user.orgId, email: user.email };
}

export async function revokeSession(bearer: string): Promise<void> {
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : bearer;
  const tokenHash = sha256(token);
  const db = getDb();
  await db
    .update(schema.sessions)
    .set({ revokedAt: new Date() })
    .where(eq(schema.sessions.tokenHash, tokenHash));
}

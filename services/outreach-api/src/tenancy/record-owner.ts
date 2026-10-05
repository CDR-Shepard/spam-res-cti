/**
 * Who may decide about a record (Needs Review, call plans): admins decide anything; anyone
 * else only records they own in Salesforce, matched through the CTI's salesforce_connections.
 */
import { eq } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import type { RequestContext } from './scope.js';

/** Salesforce's case-sensitive Id core: the first 15 characters (an 18-character Id adds a checksum). */
export const SF_ID_CORE = 15;

/** Salesforce Ids compare on their case-sensitive 15-character core, so a 15- and an 18-character form match. */
export function sameSfId(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length < SF_ID_CORE || b.length < SF_ID_CORE) return false;
  return a.slice(0, SF_ID_CORE) === b.slice(0, SF_ID_CORE);
}

/** The Salesforce user the signed-in person connected as (the CTI's salesforce_connections), or null. */
export async function ownSfUserId(db: Db, userId: string): Promise<string | null> {
  const [conn] = await db
    .select({ sfUserId: schema.salesforceConnections.sfUserId })
    .from(schema.salesforceConnections)
    .where(eq(schema.salesforceConnections.userId, userId))
    .limit(1);
  return conn?.sfUserId ?? null;
}

const isAdmin = (ctx: RequestContext): boolean => ctx.session.isAdmin || ctx.session.isSuperAdmin;

/** The pure form, for lists: `mine` is looked up once per request. */
export function mayDecideWith(ctx: RequestContext, mine: string | null, ownerSfUserId: string | null): boolean {
  return isAdmin(ctx) || sameSfId(mine, ownerSfUserId);
}

export async function mayDecide(db: Db, ctx: RequestContext, ownerSfUserId: string | null): Promise<boolean> {
  if (isAdmin(ctx)) return true;
  if (!ownerSfUserId) return false;
  return sameSfId(await ownSfUserId(db, ctx.session.userId), ownerSfUserId);
}

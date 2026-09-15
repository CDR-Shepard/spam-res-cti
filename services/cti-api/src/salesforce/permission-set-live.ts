/**
 * Production wiring for the CTI permission-set assigner. Kept apart from
 * permission-set.ts so that module stays a pure, fully testable unit with no
 * database or Salesforce client bound into it.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@cti/db';
import { sfFetch, soqlQuery } from './client.js';
import {
  ensureCtiPermissionSetForUser,
  type EnsureOutcome,
  type PermissionSetDeps,
  type PermissionSetLookup,
} from './permission-set.js';

function liveDeps(): PermissionSetDeps & PermissionSetLookup {
  const db = getDb();
  return {
    soqlQuery,
    sfFetch,
    sfUserIdOf: async (userId: string) => {
      const conn = await db.query.salesforceConnections.findFirst({
        where: eq(schema.salesforceConnections.userId, userId),
        columns: { sfUserId: true },
      });
      return conn?.sfUserId ?? null;
    },
    adminsWithConnection: async (orgId: string) => {
      // Most recently connected first: the freshest token is the least likely
      // to spend this call on a refresh, and a long-dormant admin connection is
      // the most likely to have been revoked.
      const rows = await db
        .select({ userId: schema.users.id })
        .from(schema.users)
        .innerJoin(
          schema.salesforceConnections,
          eq(schema.salesforceConnections.userId, schema.users.id),
        )
        .where(and(eq(schema.users.orgId, orgId), eq(schema.users.isAdmin, true)))
        .orderBy(desc(schema.salesforceConnections.updatedAt));
      return rows.map((r) => r.userId);
    },
  };
}

/**
 * Best-effort: give a CTI user the Salesforce permission set that makes
 * `CTI_Origin__c` writable for them. Returns the outcome for logging; never
 * throws, so no caller has to guard it.
 */
export async function ensureCtiPermissionSetLive(args: {
  orgId: string;
  targetUserId: string;
  preferredAdminUserId?: string;
}): Promise<EnsureOutcome> {
  try {
    return await ensureCtiPermissionSetForUser(liveDeps(), args);
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

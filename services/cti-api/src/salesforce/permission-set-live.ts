/**
 * Production wiring for the CTI permission-set assigner. Kept apart from
 * permission-set.ts so that module stays a pure, fully testable unit with no
 * database or Salesforce client bound into it.
 */
import { and, desc, eq } from 'drizzle-orm';
import { humanUsersInOrg } from '@cti/auth';
import { getDb, schema } from '@cti/db';
import { sfFetch, soqlQuery } from './client.js';
import { SF_CALL_TIMEOUT_MS, withTimeout } from './followup-worker.js';
import {
  ensureCtiPermissionSetForUser,
  type EnsureOutcome,
  type PermissionSetDeps,
  type PermissionSetLookup,
} from './permission-set.js';

/**
 * The admin-selection query, exported so a test can pin the SQL it emits. The
 * org filter is the ONLY thing standing between this feature and using one
 * tenant's Salesforce token on another tenant's user, and a fake DB cannot
 * prove a WHERE clause — see permission-set-live.test.ts.
 */
export function adminsWithConnectionQuery(db: ReturnType<typeof getDb>, orgId: string) {
  return db
    .select({ userId: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.salesforceConnections, eq(schema.salesforceConnections.userId, schema.users.id))
    .where(and(humanUsersInOrg(orgId), eq(schema.users.isAdmin, true)))
    .orderBy(desc(schema.salesforceConnections.updatedAt));
}

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
      // Freshest Salesforce activity first. `updatedAt` is stamped by the
      // connect upsert, by refreshAndPersist and by the profile refresh (the
      // table has no $onUpdate, so it is exactly those three writers) — so this
      // is "most recently connected OR refreshed", which is what we actually
      // want: the least likely token to need a refresh, and the least likely to
      // have been revoked.
      //
      // humanUsersInOrg carries the kind = 'human' filter every other user query
      // in this codebase uses, so the AI Agent service user can never be picked
      // as the acting admin. The org filter is what keeps one tenant's
      // Salesforce token from ever acting on another tenant's user.
      const rows = await adminsWithConnectionQuery(db, orgId);
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
    // Bounded on purpose. This runs inside the admin toggle's HTTP response and
    // on the Salesforce sign-in path; sfFetch otherwise inherits undici's 300s
    // default, so a degraded Salesforce would hang the admin's tab long enough
    // for the optimistic switch in TeamPanel to snap back and tell them the
    // change failed — while the database row says it succeeded.
    return await withTimeout(
      ensureCtiPermissionSetForUser(liveDeps(), args),
      SF_CALL_TIMEOUT_MS,
      'cti permission set',
    );
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

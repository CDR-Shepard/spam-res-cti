/**
 * Keeps the CTI's Salesforce permission set on every rep who uses the CTI, so
 * nobody has to remember a Setup click when a rep is switched on.
 *
 * WHY THIS EXISTS. `Activity.CTI_Origin__c` (see cti-origin.ts) is how reports
 * tell a CTI-written Task from one a person typed, and field-level security is
 * granted per user. The CTI writes Tasks through each rep's OWN Salesforce
 * session, so a rep without the permission set gets `INVALID_FIELD` and their
 * tasks are created unstamped. Assigning it by hand does not survive the next
 * new hire.
 *
 * WHO DOES THE ASSIGNING. A rep cannot grant themselves a permission set —
 * creating a `PermissionSetAssignment` needs "Assign Permission Sets", which
 * reps do not have. So every call here runs through an ADMIN's Salesforce
 * connection, never the target's.
 *
 * BEST EFFORT, ALWAYS. Nothing in this module may fail the operation that
 * triggered it. Switching a rep on, or connecting Salesforce, must succeed even
 * when the org has no admin connected, the permission set was never deployed, or
 * Salesforce is down. The worst case is the pre-existing one: tasks get created
 * without the marker, which `postFollowUpCopy` and `createCallTask` already
 * handle by retrying without it.
 */

import { soqlEscape } from './soql.js';

/** DeveloperName of the permission set that grants read+edit on CTI_Origin__c. */
export const CTI_PERMISSION_SET_NAME = 'CTI_Task_Origin';

/** Skip reason that means "someone has to fix Salesforce", not "nothing to do". */
export const PERMISSION_SET_MISSING = `permission set ${CTI_PERMISSION_SET_NAME} not in org`;

/**
 * How many admins to try before giving up. An admin-specific refusal
 * (INSUFFICIENT_ACCESS) is worth retrying as someone else; an unbounded walk is
 * not, because with Salesforce down one enablement would become one failed
 * round trip per admin in the org, all inside an awaited HTTP response.
 */
export const MAX_ADMIN_ATTEMPTS = 3;

/** What the DB lookup has to supply. Kept narrow so callers can fake it. */
export interface PermissionSetLookup {
  /** The target rep's Salesforce user id (005…), or null if they never connected. */
  sfUserIdOf: (userId: string) => Promise<string | null>;
  /**
   * CTI user ids of admins in the org who have a live Salesforce connection,
   * most recently connected first. Only these can assign a permission set.
   */
  adminsWithConnection: (orgId: string) => Promise<string[]>;
}

export interface PermissionSetDeps {
  soqlQuery: <T>(userId: string, soql: string) => Promise<T[]>;
  /** Method is the same literal union `sfFetch` takes, so the real client is
   *  assignable here without a cast (a wider `string` would not be). */
  sfFetch: (
    userId: string,
    path: string,
    init?: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown },
  ) => Promise<{ status: number; json: unknown }>;
}

export type EnsureOutcome =
  /** We created the assignment just now. */
  | { status: 'assigned' }
  /** The rep already had it — nothing to do. */
  | { status: 'already' }
  /** A precondition is missing. Expected, not an error; says which. */
  | { status: 'skipped'; reason: string }
  /** Salesforce refused or was unreachable. Logged, never thrown. */
  | { status: 'failed'; reason: string };

/**
 * Give `targetSfUserId` the CTI permission set, acting as `adminUserId`.
 *
 * Idempotent by query-then-create, and idempotent again on the way back: two
 * admins enabling the same rep at once race, and Salesforce answers the loser
 * with DUPLICATE_VALUE, which is success as far as the caller is concerned.
 */
export async function ensureCtiPermissionSet(
  deps: PermissionSetDeps,
  adminUserId: string,
  targetSfUserId: string,
): Promise<EnsureOutcome> {
  try {
    const sets = await deps.soqlQuery<{ Id: string }>(
      adminUserId,
      `SELECT Id FROM PermissionSet WHERE Name = '${soqlEscape(CTI_PERMISSION_SET_NAME)}' LIMIT 1`,
    );
    const permissionSetId = sets[0]?.Id;
    if (!permissionSetId) {
      // A MISCONFIGURATION, not a normal precondition — the caller logs this
      // one at warn. Without that distinction the single most likely real
      // failure (permission set renamed or never deployed) is invisible: the
      // feature silently no-ops for every rep, forever, at info level.
      return { status: 'skipped', reason: PERMISSION_SET_MISSING };
    }

    const existing = await deps.soqlQuery<{ Id: string }>(
      adminUserId,
      `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '${soqlEscape(permissionSetId)}' ` +
        `AND AssigneeId = '${soqlEscape(targetSfUserId)}' LIMIT 1`,
    );
    if (existing.length > 0) return { status: 'already' };

    const res = await deps.sfFetch(adminUserId, '/sobjects/PermissionSetAssignment', {
      method: 'POST',
      body: { PermissionSetId: permissionSetId, AssigneeId: targetSfUserId },
    });
    if (res.status < 400) return { status: 'assigned' };

    // Lost a race with another admin (or another replica) — the rep has it,
    // which is the only thing the caller cares about.
    if (isDuplicateAssignment(res.json)) return { status: 'already' };
    return { status: 'failed', reason: `salesforce ${res.status}: ${JSON.stringify(res.json)}` };
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Salesforce's answer when the assignment already exists. `DUPLICATE_VALUE` is
 * the documented code; the message check is a belt-and-braces fallback for API
 * versions that return the same condition under a vaguer code.
 */
export function isDuplicateAssignment(json: unknown): boolean {
  const entries = Array.isArray(json) ? json : [json];
  return entries.some((e) => {
    const entry = e as { errorCode?: unknown; message?: unknown } | null;
    if (entry?.errorCode === 'DUPLICATE_VALUE') return true;
    return typeof entry?.message === 'string' && /duplicate value found|already assigned/i.test(entry.message);
  });
}

/**
 * Ensure the CTI permission set for one CTI user, resolving both the target's
 * Salesforce id and an admin to act as.
 *
 * `preferredAdminUserId` is the admin who triggered this (the one flipping the
 * toggle). Trying them first means the common path does zero extra DB work and
 * the audit trail in Salesforce names the person who actually made the change.
 * On the connect path there is no such admin, so we fall back to any admin in
 * the org with a Salesforce connection.
 *
 * Never throws. Every failure mode is a value the caller can log.
 */
export async function ensureCtiPermissionSetForUser(
  deps: PermissionSetDeps & PermissionSetLookup,
  args: { orgId: string; targetUserId: string; preferredAdminUserId?: string },
): Promise<EnsureOutcome> {
  try {
    const targetSfUserId = await deps.sfUserIdOf(args.targetUserId);
    if (!targetSfUserId) {
      // Normal for a rep enabled before they have connected Salesforce. The
      // connect path runs this again, which is why that hook exists.
      return { status: 'skipped', reason: 'target has no Salesforce connection yet' };
    }

    const admins = await deps.adminsWithConnection(args.orgId);
    // Only promote the triggering admin if they are actually in the list —
    // being a CTI admin does not mean they have connected Salesforce, and
    // calling as someone with no token just burns a round trip.
    const ordered =
      args.preferredAdminUserId && admins.includes(args.preferredAdminUserId)
        ? [args.preferredAdminUserId, ...admins.filter((a) => a !== args.preferredAdminUserId)]
        : admins;
    if (ordered.length === 0) {
      return { status: 'skipped', reason: 'no admin in this org has connected Salesforce' };
    }

    // Try each admin in turn: the preferred one may lack "Assign Permission
    // Sets" even though they are a CTI admin, and giving up on the first
    // failure would strand the rep for a reason another admin could fix.
    let last: EnsureOutcome = { status: 'failed', reason: 'no admin attempted' };
    for (const adminUserId of ordered.slice(0, MAX_ADMIN_ATTEMPTS)) {
      last = await ensureCtiPermissionSet(deps, adminUserId, targetSfUserId);
      if (last.status === 'assigned' || last.status === 'already') return last;
      // A missing permission set is an org-global fact: every admin returns the
      // same answer, so asking the next one only burns another round trip.
      if (last.status === 'skipped' && last.reason === PERMISSION_SET_MISSING) return last;
    }
    return last;
  } catch (err) {
    return { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}

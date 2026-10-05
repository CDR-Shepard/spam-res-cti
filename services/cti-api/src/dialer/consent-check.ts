/**
 * The power dialer's consent gate (spam-defense audit §1): which of these
 * numbers may the dialer NOT call?
 *
 * The gate itself — `blockedTargets` and its `ConsentBlock` verdicts — lives in
 * @cti/firewall (suppression.ts), where its full rationale is documented, so
 * the outreach planner and this dialer read suppression through ONE
 * definition. It is re-exported here so create-session.ts, routes/dialer.ts,
 * and the tests keep this import site. Only the dialer's fail-open wrapper
 * stays in this file.
 */
import type { getDb } from '@cti/db';
import { blockedTargets, type ConsentBlock } from '@cti/firewall';

export { blockedTargets, type ConsentBlock } from '@cti/firewall';

type Db = ReturnType<typeof getDb>;

/**
 * Fail OPEN, the same calculus `workedRecentlySafe` already accepted: a broken
 * consent READ must not leave the team with a dead queue. The protection that
 * matters is not lost when this errors — click-to-dial still runs the firewall
 * fail-closed, and the sync/rollover gates are untouched — so a repeat dial
 * risk beats a whole shift unable to dial. The warn tag is distinct from
 * `[already-worked]` so a log search can tell which of the two open gates went
 * quiet.
 */
export async function blockedTargetsSafe(
  db: Db,
  orgId: string,
  numbers: readonly string[],
): Promise<Map<string, ConsentBlock>> {
  try {
    return await blockedTargets(db, orgId, numbers);
  } catch (err) {
    console.warn('[consent-check] check failed — failing OPEN (no skips):', (err as Error).message);
    return new Map();
  }
}

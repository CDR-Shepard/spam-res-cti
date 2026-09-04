/**
 * The power dialer's consent gate (spam-defense audit §1): which of these
 * numbers may the dialer NOT call?
 *
 * Click-to-dial has always been fail-closed — `packages/firewall/src/evaluate.ts` checks the
 * internal opt-out list (:364), the manual block list (:379) and the federal
 * DNC cache (:728) before every dial, and `routes/calls.ts` turns a BLOCK into
 * a 403. The power dialer enforced NONE of it: `create-session.ts` /
 * `engine.ts` never referenced those tables. This module is that missing gate,
 * applied ONCE at queue build so a blocked target becomes a VISIBLE skipped row
 * the rep can see the reason for, instead of a call that silently goes out.
 *
 * TABLE SEMANTICS ARE THE FIREWALL'S, DELIBERATELY VERBATIM — a second,
 * subtly-different definition of "may we call this number" is exactly the drift
 * this fix exists to remove:
 *  - `opt_outs`        org-scoped exact e164 match → always blocks.
 *  - `blocked_numbers` org-scoped exact e164 match → always blocks.
 *  - `federal_dnc_entries` exact e164 match, NOT org-scoped and NOT filtered on
 *    `source` → always blocks, in EVERY `dnc_mode` (the federal_dnc gate in evaluate.ts:
 *    "A number that IS in the loaded cache always blocks, regardless of org
 *    mode"). `dnc_mode` only decides how a MISS is *labeled* upstream
 *    (`DNC_PRESCRUBBED` / `DNC_OK` / `DNC_NOT_LOADED`) — a miss never blocks in
 *    any mode. So for queue building the org's mode is a genuine no-op:
 *    `external_prescrubbed` (this org's mode) adds no skip and removes none,
 *    and the pre-scrub attestation keeps being an offline promise this system
 *    does not verify. Nothing here re-implements the mode logic; there is no
 *    mode-dependent branch to get wrong.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '@cti/db';
import { schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;

/** Why the dialer may not call a number. Ordered strongest-first below. */
export type ConsentBlock = 'opted_out' | 'blocked' | 'dnc';

/**
 * The verdict per number, for the numbers that are blocked (an unlisted number
 * is simply absent from the map). One value per number, so when a number is on
 * more than one list the FIRST of these wins — the same order the firewall
 * pushes its checks in (opt-out :364, block list :379, federal DNC :728), so
 * the reason the rep sees on the dialer matches the reason click-to-dial would
 * have shown for the same number.
 */
export async function blockedTargets(
  db: Db,
  orgId: string,
  numbers: readonly string[],
): Promise<Map<string, ConsentBlock>> {
  const out = new Map<string, ConsentBlock>();
  if (numbers.length === 0) return out;
  const list = [...numbers];
  const [optedOut, blocked, dnc] = await Promise.all([
    db
      .select({ e164: schema.optOuts.e164 })
      .from(schema.optOuts)
      .where(and(eq(schema.optOuts.orgId, orgId), inArray(schema.optOuts.e164, list))),
    db
      .select({ e164: schema.blockedNumbers.e164 })
      .from(schema.blockedNumbers)
      .where(and(eq(schema.blockedNumbers.orgId, orgId), inArray(schema.blockedNumbers.e164, list))),
    db
      .select({ e164: schema.federalDncEntries.e164 })
      .from(schema.federalDncEntries)
      .where(inArray(schema.federalDncEntries.e164, list)),
  ]);
  // Weakest first, strongest last: a later set overwrites, so opt-out ends up
  // winning over the block list, which wins over DNC.
  for (const r of dnc) out.set(r.e164, 'dnc');
  for (const r of blocked) out.set(r.e164, 'blocked');
  for (const r of optedOut) out.set(r.e164, 'opted_out');
  return out;
}

/**
 * Fail OPEN, the same calculus `workedTodaySafe` already accepted: a broken
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

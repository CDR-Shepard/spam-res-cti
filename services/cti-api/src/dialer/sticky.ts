/**
 * Sticky-on-connect for the power dialer: when a dialer-pool DID call actually
 * connects, remember (org, rep, lead) -> that DID so a subsequent callback
 * from the lead to the same pool DID rings the rep the lead already talked to
 * — same shape as the click-to-dial sticky write in `routes/calls.ts`, just
 * triggered from the dialer engine instead of the manual-dial route.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';

export interface StickyUpsertInput {
  orgId: string;
  userId: string;
  leadE164: string;
  poolDid: string;
}

export interface StickyUpsertValues {
  orgId: string;
  assignedUserId: string;
  recipientE164: string;
  e164: string;
}

/** Pure: maps the engine's naming (userId/leadE164/poolDid) onto the sticky_numbers row shape. */
export function stickyUpsertValues(input: StickyUpsertInput): StickyUpsertValues {
  return {
    orgId: input.orgId,
    assignedUserId: input.userId,
    recipientE164: input.leadE164,
    e164: input.poolDid,
  };
}

/**
 * Upsert the sticky binding for a connected dialer call. Mirrors the exact
 * upsert shape used by the click-to-dial sticky write in `routes/calls.ts`
 * (same conflict target, same last-used-wins `set`).
 */
export async function recordConnectSticky(db: ReturnType<typeof getDb>, input: StickyUpsertInput): Promise<void> {
  const values = stickyUpsertValues(input);
  await db
    .insert(schema.stickyNumbers)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.stickyNumbers.orgId, schema.stickyNumbers.assignedUserId, schema.stickyNumbers.recipientE164],
      set: { e164: values.e164, lastUsedAt: new Date() },
    });
}

/**
 * Reverse lookup for inbound routing: given a caller ringing a dialer-pool
 * DID, find the rep that DID is currently sticky to for that caller (newest
 * binding first — a caller could theoretically be sticky to more than one rep
 * across different pool DIDs, but for a single DID there should only ever be
 * one row per (org, recipient, e164) since the upsert target is (org, rep,
 * recipient) — `orderBy` + `limit(1)` is defensive, not load-bearing).
 */
export async function stickyAgentForCaller(
  db: ReturnType<typeof getDb>,
  orgId: string,
  callerE164: string,
  dialedPoolDid: string,
): Promise<string | null> {
  const rows = await db
    .select({ assignedUserId: schema.stickyNumbers.assignedUserId })
    .from(schema.stickyNumbers)
    .where(
      and(
        eq(schema.stickyNumbers.orgId, orgId),
        eq(schema.stickyNumbers.recipientE164, callerE164),
        eq(schema.stickyNumbers.e164, dialedPoolDid),
      ),
    )
    .orderBy(desc(schema.stickyNumbers.lastUsedAt))
    .limit(1);
  return rows[0]?.assignedUserId ?? null;
}

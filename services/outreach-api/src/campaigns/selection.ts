/** The lead picker's selection (campaign_selections). An ai_call campaign enrolls only these. */
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { chunk, type Tx } from './enroll.js';

/** A connection or an open transaction: the store functions run on either. */
type Executor = Db | Tx;

/** Rows per INSERT/DELETE statement (3 bind parameters each for the insert, well under 65,535). */
const SELECTION_BATCH = 2_000;
const s = schema.campaignSelections;

export async function selectRecords(
  db: Executor,
  args: { orgId: string; campaignId: string; userId: string | null; sfRecordIds: readonly string[] },
): Promise<number> {
  let added = 0;
  for (const batch of chunk([...new Set(args.sfRecordIds)], SELECTION_BATCH)) {
    const rows = await db
      .insert(s)
      .values(batch.map((sfRecordId) => ({ campaignId: args.campaignId, orgId: args.orgId, sfRecordId, selectedBy: args.userId })))
      .onConflictDoNothing({ target: [s.campaignId, s.sfRecordId] })
      .returning({ id: s.sfRecordId });
    added += rows.length;
  }
  return added;
}

/**
 * One PUT /selection as ONE transaction: clear, add (every batch), remove, then the count.
 * The refresh reads `campaign_selections` while this runs, so it must see the selection
 * as it was or as it is, never a cleared or half-inserted one. `add` holds only Ids the
 * caller already checked against the campaign's members.
 */
export async function applySelectionChange(
  db: Db,
  args: { orgId: string; campaignId: string; userId: string | null; clear: boolean; add: readonly string[]; remove: readonly string[] },
): Promise<number> {
  return db.transaction(async (tx) => {
    if (args.clear) await clearSelection(tx, args.campaignId);
    await selectRecords(tx, { orgId: args.orgId, campaignId: args.campaignId, userId: args.userId, sfRecordIds: args.add });
    if (args.remove.length > 0) await deselectRecords(tx, args.campaignId, args.remove);
    return selectedCount(tx, args.campaignId);
  });
}

export async function deselectRecords(db: Executor, campaignId: string, sfRecordIds: readonly string[]): Promise<number> {
  let removed = 0;
  for (const batch of chunk([...new Set(sfRecordIds)], SELECTION_BATCH)) {
    const rows = await db.delete(s).where(and(eq(s.campaignId, campaignId), inArray(s.sfRecordId, batch))).returning({ id: s.sfRecordId });
    removed += rows.length;
  }
  return removed;
}

export async function clearSelection(db: Executor, campaignId: string): Promise<number> {
  const rows = await db.delete(s).where(eq(s.campaignId, campaignId)).returning({ id: s.sfRecordId });
  return rows.length;
}

export async function selectedCount(db: Executor, campaignId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(s).where(eq(s.campaignId, campaignId));
  return Number(row?.n ?? 0);
}

export async function selectedAmong(db: Db, campaignId: string, sfRecordIds: readonly string[]): Promise<Set<string>> {
  if (sfRecordIds.length === 0) return new Set();
  const rows = await db.select({ id: s.sfRecordId }).from(s).where(and(eq(s.campaignId, campaignId), inArray(s.sfRecordId, [...sfRecordIds])));
  return new Set(rows.map((r) => r.id));
}

export async function allSelectedIds(db: Db, campaignId: string): Promise<Set<string>> {
  const rows = await db.select({ id: s.sfRecordId }).from(s).where(eq(s.campaignId, campaignId)).orderBy(sql`${s.selectedAt}`);
  return new Set(rows.map((r) => r.id));
}

/** The lead picker's selection (campaign_selections). An ai_call campaign enrolls only these. */
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { chunk } from './enroll.js';

/** Rows per INSERT/DELETE statement (3 bind parameters each for the insert, well under 65,535). */
const SELECTION_BATCH = 2_000;
const s = schema.campaignSelections;

export async function selectRecords(
  db: Db,
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

export async function deselectRecords(db: Db, campaignId: string, sfRecordIds: readonly string[]): Promise<number> {
  let removed = 0;
  for (const batch of chunk([...new Set(sfRecordIds)], SELECTION_BATCH)) {
    const rows = await db.delete(s).where(and(eq(s.campaignId, campaignId), inArray(s.sfRecordId, batch))).returning({ id: s.sfRecordId });
    removed += rows.length;
  }
  return removed;
}

export async function clearSelection(db: Db, campaignId: string): Promise<number> {
  const rows = await db.delete(s).where(eq(s.campaignId, campaignId)).returning({ id: s.sfRecordId });
  return rows.length;
}

export async function selectedCount(db: Db, campaignId: string): Promise<number> {
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

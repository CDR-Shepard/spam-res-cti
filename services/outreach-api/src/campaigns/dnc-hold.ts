/**
 * Do-not-contact holds (spec §7.3). A record the AI flagged do-not-contact waits in
 * Needs Review until a person decides; nothing plans or queues a touch for it meanwhile.
 *
 * The triage tick holds a flagged person when it stores the result. That can miss: the
 * enrollment may have left `active` between the claim and the store, and a later
 * enrollment of the same record is not re-triaged when its notes are unchanged. So the
 * planner and the call-queue re-check ask again, from the stored triage rows, before
 * every touch (`holdIfFlagged`).
 *
 * A flag is pending while some triage of the record flagged do-not-contact and is newer
 * than the one a person last dismissed (`crm_records.dnc_dismissed_triage_id`). Any
 * doubt holds: a flag that no longer validates, or a dismissal that points at a missing
 * triage row, still holds the person for a human.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DoNotContactCategory, TriageResult } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { OPEN_TOUCH_STATUSES } from './enroll.js';

export interface DncFlag {
  /** The record_triage row the flag came from. */
  triageId: string;
  category: DoNotContactCategory;
  quote: string;
}

/** `touches.skip_reason` for a touch cancelled because its person went to Needs Review. */
export const NEEDS_REVIEW_SKIP_REASON = 'needs_review';

const DoNotContact = TriageResult.shape.doNotContact.unwrap();
const MAX_QUOTE = 300;

/** A stored flag as the review screen shows it. A flag that no longer validates still holds, as `other`. */
function toFlag(triageId: string, raw: unknown): DncFlag {
  const parsed = DoNotContact.safeParse(raw);
  if (parsed.success) return { triageId, category: parsed.data.category, quote: parsed.data.quote };
  const quote = (raw as { quote?: unknown } | null)?.quote;
  return { triageId, category: 'other', quote: typeof quote === 'string' ? quote.slice(0, MAX_QUOTE) : '' };
}

/** The newest do-not-contact flag on the record that nobody dismissed, or null. */
export async function pendingDncFlag(db: Db, crmRecordId: string): Promise<DncFlag | null> {
  const result = await db.execute(sql`
    select rt.id, rt.result -> 'doNotContact' as flag
    from record_triage rt
    join crm_records r on r.id = rt.crm_record_id and r.org_id = rt.org_id
    left join record_triage d on d.id = r.dnc_dismissed_triage_id
    where rt.crm_record_id = ${crmRecordId}
      and jsonb_typeof(rt.result -> 'doNotContact') = 'object'
      and (d.id is null or rt.created_at > d.created_at)
    order by rt.created_at desc, rt.id desc
    limit 1`);
  const row = (result as unknown as { rows: Array<{ id: string; flag: unknown }> }).rows[0];
  return row ? toFlag(row.id, row.flag) : null;
}

/**
 * Moves the target's ACTIVE enrollments to `needs_review` with the flag, and skips their
 * touches that have not started (`planned|held|queued`; a `dialing` touch is left to
 * reconciliation). Run it inside the caller's transaction. Returns the enrollments held.
 */
export async function holdForReview(
  tx: Db,
  target: { crmRecordId: string } | { enrollmentId: string },
  flag: DncFlag,
  now: Date,
): Promise<string[]> {
  const e = schema.campaignEnrollments;
  const which = 'crmRecordId' in target ? eq(e.crmRecordId, target.crmRecordId) : eq(e.id, target.enrollmentId);
  const held = await tx
    .update(e)
    .set({
      status: 'needs_review',
      reviewCategory: flag.category,
      reviewQuote: flag.quote,
      reviewTriageId: flag.triageId,
      flaggedAt: now,
      nextTouchAt: null,
      updatedAt: now,
    })
    .where(and(which, eq(e.status, 'active')))
    .returning({ id: e.id });
  const ids = held.map((h) => h.id);
  if (ids.length > 0) {
    await tx
      .update(schema.touches)
      .set({ status: 'skipped', skipReason: NEEDS_REVIEW_SKIP_REASON, updatedAt: now })
      .where(and(inArray(schema.touches.enrollmentId, ids), inArray(schema.touches.status, [...OPEN_TOUCH_STATUSES])));
  }
  return ids;
}

/**
 * Before a touch is planned or queued: when the record carries a pending do-not-contact
 * flag, hold this enrollment for review and return true. True means "do not touch this
 * person", even when the enrollment was no longer active to be held.
 */
export async function holdIfFlagged(db: Db, args: { enrollmentId: string; crmRecordId: string; now: Date }): Promise<boolean> {
  const flag = await pendingDncFlag(db, args.crmRecordId);
  if (!flag) return false;
  await db.transaction(async (tx) => {
    await holdForReview(tx, { enrollmentId: args.enrollmentId }, flag, args.now);
  });
  return true;
}

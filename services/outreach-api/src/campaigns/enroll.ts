/**
 * Records and enrollments — the write side of a campaign refresh.
 *
 * - `upsertRecords` keeps one `crm_records` row per Salesforce record per tenant.
 * - `enrollRecords` enforces "one active campaign per person" with the partial unique
 *   index `enrollment_contact_keys_active_unique` on `(org_id, key) WHERE active`: a
 *   record whose phone or email is already held by an active enrollment anywhere in the
 *   tenant is not enrolled. The index, not a read-then-write check, decides, so two
 *   campaigns refreshing at the same moment cannot both enroll the same person.
 * - `exitEnrollment` releases the person's keys and cancels the touches not yet started.
 */
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { EnrollmentStatus } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { SfRecordSnapshot } from './records.js';

export const DAY_MS = 86_400_000;
const UPSERT_BATCH = 200;

/** When a new (or re-enrolled) enrollment's first touch is due: the campaign's first touch day after `now`. */
export const firstTouchAt = (now: Date, touchDays: readonly number[]): Date => new Date(now.getTime() + (touchDays[0] ?? 0) * DAY_MS);
const UNIQUE_VIOLATION = '23505';
const ACTIVE_KEY_INDEX = 'enrollment_contact_keys_active_unique';

/**
 * Touch statuses that have not started; an exit or a review flag cancels them.
 * Not the planner's "open" set: that one (`OPEN_TOUCH_STATUSES` in planner/run.ts) also
 * contains `dialing`, because a touch mid-dial still blocks planning another, whereas an
 * exit must leave a `dialing` touch to reconciliation.
 */
export const OPEN_TOUCH_STATUSES = ['planned', 'held', 'queued'] as const;
/** `exit_reason` of an enrollment ended because its campaign was archived. */
export const CAMPAIGN_ARCHIVED_EXIT_REASON = 'campaign_archived';
/** Enrollment statuses that are finished; nothing moves them again. */
export const TERMINAL_ENROLLMENT_STATUSES = ['exited', 'completed'] as const;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Column updates on conflict. Each expression reads the OLD row as `crm_records.` and the
 * incoming row as `excluded.`; Postgres evaluates the whole SET list against the old row,
 * so `triage_needed` compares the previous `sf_last_modified_at` with the new one.
 */
const UPSERT_SET = {
  sfObject: sql.raw('excluded.sf_object'),
  name: sql.raw('excluded.name'),
  ownerSfUserId: sql.raw('excluded.owner_sf_user_id'),
  ownerName: sql.raw('excluded.owner_name'),
  leadManagerSfUserId: sql.raw('excluded.lead_manager_sf_user_id'),
  phones: sql.raw('excluded.phones'),
  email: sql.raw('excluded.email'),
  state: sql.raw('excluded.state'),
  webFormSource: sql.raw('excluded.web_form_source'),
  // A sync never clears consent that is already true; only an explicit revocation may.
  consentAiCall: sql.raw('crm_records.consent_ai_call OR excluded.consent_ai_call'),
  sfDoNotCall: sql.raw('excluded.sf_do_not_call'),
  sfEmailOptOut: sql.raw('excluded.sf_email_opt_out'),
  skipOnDialer: sql.raw('excluded.skip_on_dialer'),
  isClosed: sql.raw('excluded.is_closed'),
  triageNeeded: sql.raw(
    'crm_records.triage_needed OR crm_records.sf_last_modified_at IS DISTINCT FROM excluded.sf_last_modified_at',
  ),
  // A changed record is triaged without waiting out the failure backoff.
  triageAttemptedAt: sql.raw(
    'CASE WHEN crm_records.sf_last_modified_at IS DISTINCT FROM excluded.sf_last_modified_at THEN NULL ELSE crm_records.triage_attempted_at END',
  ),
  sfLastModifiedAt: sql.raw('excluded.sf_last_modified_at'),
  syncedAt: sql`now()`,
};

function toRow(orgId: string, s: SfRecordSnapshot): typeof schema.crmRecords.$inferInsert {
  return {
    orgId,
    sfObject: s.sfObject,
    sfRecordId: s.sfRecordId,
    name: s.name,
    ownerSfUserId: s.ownerSfUserId,
    ownerName: s.ownerName,
    leadManagerSfUserId: s.leadManagerSfUserId,
    phones: s.phones,
    email: s.email,
    state: s.state,
    webFormSource: s.webFormSource,
    consentAiCall: s.consentAiCall,
    sfDoNotCall: s.sfDoNotCall,
    sfEmailOptOut: s.sfEmailOptOut,
    skipOnDialer: s.skipOnDialer,
    isClosed: s.isClosed,
    triageNeeded: true,
    sfLastModifiedAt: s.lastModifiedAt,
  };
}

/**
 * Inserts or updates one `crm_records` row per snapshot, 200 per statement. Returns, per
 * sfRecordId, the row id and `changed`: true for a new row or when `sf_last_modified_at`
 * moved. A new or changed row gets `triage_needed = true`; an unchanged row keeps its flag.
 */
export async function upsertRecords(
  db: Db,
  orgId: string,
  snapshots: SfRecordSnapshot[],
): Promise<Map<string, { id: string; changed: boolean }>> {
  const out = new Map<string, { id: string; changed: boolean }>();
  // One row per Id: Postgres rejects an upsert that touches the same row twice.
  const unique = [...new Map(snapshots.map((s) => [s.sfRecordId, s])).values()];
  for (const batch of chunk(unique, UPSERT_BATCH)) {
    const ids = batch.map((s) => s.sfRecordId);
    const before = await db
      .select({ sfRecordId: schema.crmRecords.sfRecordId, lastModified: schema.crmRecords.sfLastModifiedAt })
      .from(schema.crmRecords)
      .where(and(eq(schema.crmRecords.orgId, orgId), inArray(schema.crmRecords.sfRecordId, ids)));
    const prior = new Map(before.map((r) => [r.sfRecordId, r.lastModified?.getTime() ?? null]));
    const incoming = new Map(batch.map((s) => [s.sfRecordId, s.lastModifiedAt?.getTime() ?? null]));
    const rows = await db
      .insert(schema.crmRecords)
      .values(batch.map((s) => toRow(orgId, s)))
      .onConflictDoUpdate({ target: [schema.crmRecords.orgId, schema.crmRecords.sfRecordId], set: UPSERT_SET })
      .returning({ id: schema.crmRecords.id, sfRecordId: schema.crmRecords.sfRecordId });
    for (const r of rows) {
      const changed = !prior.has(r.sfRecordId) || prior.get(r.sfRecordId) !== incoming.get(r.sfRecordId);
      out.set(r.sfRecordId, { id: r.id, changed });
    }
  }
  return out;
}

/** node-postgres puts `code`/`constraint` on the error; tolerate a wrapper that nests it in `cause`. */
function pgErrorFields(err: unknown): { code?: unknown; constraint?: unknown } {
  if (!err || typeof err !== 'object') return {};
  const e = err as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (e.code !== undefined) return e;
  return e.cause && typeof e.cause === 'object' ? (e.cause as { code?: unknown; constraint?: unknown }) : {};
}

export function isActiveKeyConflict(err: unknown): boolean {
  const { code, constraint } = pgErrorFields(err);
  return code === UNIQUE_VIOLATION && constraint === ACTIVE_KEY_INDEX;
}

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** `EXISTS` in SQL: the lead is (still) ticked in the campaign's lead picker. */
export function selectionExists(campaignId: SQL | string, sfRecordId: SQL | string): SQL {
  return sql`EXISTS (SELECT 1 FROM campaign_selections cs WHERE cs.campaign_id = ${campaignId} AND cs.sf_record_id = ${sfRecordId})`;
}

/** One statement: the enrollment row if and only if the lead is still selected and not yet enrolled here. */
async function insertSelectedEnrollment(
  tx: Tx,
  input: { orgId: string; campaignId: string; now: Date; callStage?: 'research' | null },
  record: { crmRecordId: string; sfRecordId?: string },
  nextTouchAt: Date,
): Promise<{ id: string } | undefined> {
  if (!record.sfRecordId) throw new Error('an AI call enrollment needs the lead\'s Salesforce Id');
  const result = await tx.execute(sql`
    INSERT INTO campaign_enrollments (org_id, campaign_id, crm_record_id, status, next_touch_at, call_stage, enrolled_at)
    SELECT ${input.orgId}::uuid, ${input.campaignId}::uuid, ${record.crmRecordId}::uuid, 'active', ${nextTouchAt.toISOString()}::timestamptz, ${input.callStage}, ${input.now.toISOString()}::timestamptz
    WHERE ${selectionExists(sql`${input.campaignId}::uuid`, sql`${record.sfRecordId}`)}
    ON CONFLICT (campaign_id, crm_record_id) DO NOTHING
    RETURNING id`);
  return (result as unknown as { rows: Array<{ id: string }> }).rows[0];
}

/**
 * Enrolls each record in its own transaction: the enrollment row, then its contact keys
 * (sorted, so concurrent transactions take key locks in the same order). A key held by
 * another active enrollment raises a unique violation; the transaction rolls back, which
 * removes the new enrollment, and the record counts as `skippedInOtherCampaign`. A record
 * already enrolled in this campaign (in any status) is left alone and counts as neither.
 * A record with no keys is skipped (counted in `skippedNoKeys`), never enrolled.
 */
export async function enrollRecords(
  db: Db,
  input: {
    orgId: string;
    campaignId: string;
    touchDays: number[];
    now: Date;
    /** `sfRecordId` is needed when `callStage` is set: the enroll re-checks the lead is still selected. */
    records: Array<{ crmRecordId: string; keys: string[]; sfRecordId?: string }>;
    /**
     * AI call campaigns enroll at `research`; sequence campaigns leave it null. An AI call
     * enrollment is inserted only while the lead is STILL in `campaign_selections`, decided
     * by the insert statement itself: the refresh read the selection seconds earlier.
     */
    callStage?: 'research' | null;
  },
): Promise<{ enrolled: number; skippedInOtherCampaign: number; skippedNoKeys: number }> {
  const nextTouchAt = firstTouchAt(input.now, input.touchDays);
  let enrolled = 0;
  let skippedInOtherCampaign = 0;
  let skippedNoKeys = 0;
  for (const record of input.records) {
    const keys = [...new Set(record.keys)].sort();
    // No key means no way to hold the person to one active campaign: never enroll without one.
    if (keys.length === 0) {
      skippedNoKeys += 1;
      continue;
    }
    try {
      const inserted = await db.transaction(async (tx) => {
        const row = input.callStage
          ? await insertSelectedEnrollment(tx, input, record, nextTouchAt)
          : (
              await tx
                .insert(schema.campaignEnrollments)
                .values({ orgId: input.orgId, campaignId: input.campaignId, crmRecordId: record.crmRecordId, status: 'active', nextTouchAt, enrolledAt: input.now })
                .onConflictDoNothing({ target: [schema.campaignEnrollments.campaignId, schema.campaignEnrollments.crmRecordId] })
                .returning({ id: schema.campaignEnrollments.id })
            )[0];
        if (!row) return false;
        await tx
          .insert(schema.enrollmentContactKeys)
          .values(keys.map((key) => ({ enrollmentId: row.id, orgId: input.orgId, key, active: true })));
        return true;
      });
      if (inserted) enrolled += 1;
    } catch (err) {
      if (!isActiveKeyConflict(err)) throw err;
      skippedInOtherCampaign += 1;
    }
  }
  return { enrolled, skippedInOtherCampaign, skippedNoKeys };
}

/** A status an enrollment can be exited from (a finished one never moves again). */
export type ExitableStatus = Exclude<EnrollmentStatus, (typeof TERMINAL_ENROLLMENT_STATUSES)[number]>;

/**
 * Ends an enrollment: status (`exited` by default, `completed` for a finished sequence)
 * and `exit_reason`; its contact keys go inactive so the person may join another
 * campaign; its `planned|held|queued` touches become `skipped` with `skip_reason = reason`
 * (a `dialing` touch is left to reconciliation).
 *
 * `from` is the status the caller decided on. The update matches only a row still in one
 * of those statuses: a caller that read `active` must not end an enrollment the triage tick
 * moved to `needs_review` since (that would drop a do-not-contact flag from Needs Review and
 * free the person's keys). When no row matches, nothing else is touched and it returns false.
 *
 * `onlyIfDeselected` (AI call campaigns, reason `deselected`) adds the same kind of guard on
 * the lead picker: the refresh decided on a selection it read seconds ago, so the UPDATE
 * itself requires the lead to be absent from `campaign_selections` right now.
 */
export async function exitEnrollment(
  db: Db,
  enrollmentId: string,
  opts: { from: readonly ExitableStatus[]; reason: string; status?: 'exited' | 'completed'; onlyIfDeselected?: boolean },
): Promise<boolean> {
  const { from, reason, status = 'exited', onlyIfDeselected = false } = opts;
  if (from.length === 0) throw new Error('exitEnrollment needs at least one expected status');
  return db.transaction(async (tx) => {
    const ended = await tx
      .update(schema.campaignEnrollments)
      .set({ status, exitReason: reason, nextTouchAt: null, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.campaignEnrollments.id, enrollmentId),
          inArray(schema.campaignEnrollments.status, [...from]),
          onlyIfDeselected ? sql`NOT ${selectionExists(sql`campaign_enrollments.campaign_id`, sql`(SELECT r.sf_record_id FROM crm_records r WHERE r.id = campaign_enrollments.crm_record_id)`)}` : undefined,
        ),
      )
      .returning({ id: schema.campaignEnrollments.id });
    if (ended.length === 0) return false;
    await tx
      .update(schema.enrollmentContactKeys)
      .set({ active: false })
      .where(eq(schema.enrollmentContactKeys.enrollmentId, enrollmentId));
    await tx
      .update(schema.touches)
      .set({ status: 'skipped', skipReason: reason, updatedAt: sql`now()` })
      .where(and(eq(schema.touches.enrollmentId, enrollmentId), inArray(schema.touches.status, [...OPEN_TOUCH_STATUSES])));
    return true;
  });
}

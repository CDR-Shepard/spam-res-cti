/**
 * Tasks feed triage (the notes fingerprint covers a record's last 10 Tasks), but Salesforce
 * does not move a Lead's or Opportunity's `LastModifiedDate` when a Task is logged against
 * it, so a record sync alone never sees a new call note such as "stop calling me". The
 * refresh therefore asks Salesforce which enrolled records got a Task since the last
 * successful refresh and marks them for triage again.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { soqlEscape, type SalesforceClient } from '@cti/salesforce';
import { chunk, TERMINAL_ENROLLMENT_STATUSES } from './enroll.js';
import { RECORD_BATCH_SIZE, SF_ID } from './records.js';

/**
 * The cutoff reaches this far before the last refresh, so a Task saved while that refresh
 * ran, or a Salesforce clock a little ahead of ours, is not missed. A record matched twice
 * costs one notes fetch; the model runs only if the notes fingerprint changed.
 */
export const TASK_ACTIVITY_OVERLAP_MS = 5 * 60_000;

/** SOQL dateTime literal: UTC, whole seconds (rounded down, so the cutoff only widens). */
function soqlDateTime(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Pure: Tasks on any of `ids` (as Who or What) modified after `after`. Ids are shape-checked first. */
export function taskActivitySoql(ids: readonly string[], after: Date): string {
  const list = ids
    .filter((id) => SF_ID.test(id))
    .map((id) => `'${soqlEscape(id)}'`)
    .join(',');
  return `SELECT WhoId, WhatId FROM Task WHERE (WhoId IN (${list}) OR WhatId IN (${list})) AND LastModifiedDate > ${soqlDateTime(after)}`;
}

/** Salesforce compares Ids on their case-sensitive 15-character core (an 18-character Id adds a checksum). */
const core = (id: string): string => id.slice(0, 15);

/**
 * Marks the campaign's enrolled records (any unfinished enrollment) that got a Task since
 * `since` as needing triage: `triage_needed = true`, `triage_attempted_at = NULL` (which
 * also makes an in-flight triage of the record stale; see triage/run.ts). 200 ids per
 * Salesforce query. Returns how many records were marked.
 */
export async function flagRecordsWithNewTasks(
  db: Db,
  client: SalesforceClient,
  args: { campaignId: string; since: Date },
): Promise<number> {
  const rows = await db
    .select({ id: schema.crmRecords.id, sfRecordId: schema.crmRecords.sfRecordId })
    .from(schema.campaignEnrollments)
    .innerJoin(schema.crmRecords, eq(schema.crmRecords.id, schema.campaignEnrollments.crmRecordId))
    .where(
      and(
        eq(schema.campaignEnrollments.campaignId, args.campaignId),
        notInArray(schema.campaignEnrollments.status, [...TERMINAL_ENROLLMENT_STATUSES]),
      ),
    )
    .orderBy(schema.crmRecords.sfRecordId);
  const byId = new Map<string, string>();
  const byCore = new Map<string, string>();
  for (const r of rows) {
    if (!SF_ID.test(r.sfRecordId)) continue;
    byId.set(r.sfRecordId, r.id);
    byCore.set(core(r.sfRecordId), r.id);
  }
  if (byId.size === 0) return 0;
  const recordOf = (ref: unknown): string | undefined =>
    typeof ref === 'string' ? (byId.get(ref) ?? byCore.get(core(ref))) : undefined;

  const after = new Date(args.since.getTime() - TASK_ACTIVITY_OVERLAP_MS);
  const ids = rows.map((r) => r.sfRecordId).filter((id) => SF_ID.test(id));
  const matched = new Set<string>();
  for (const batch of chunk(ids, RECORD_BATCH_SIZE)) {
    const tasks = await client.queryAll<{ WhoId?: unknown; WhatId?: unknown }>(taskActivitySoql(batch, after));
    for (const task of tasks) {
      for (const ref of [task.WhoId, task.WhatId]) {
        const recordId = recordOf(ref);
        if (recordId) matched.add(recordId);
      }
    }
  }
  if (matched.size === 0) return 0;
  for (const batch of chunk([...matched], RECORD_BATCH_SIZE)) {
    await db
      .update(schema.crmRecords)
      .set({ triageNeeded: true, triageAttemptedAt: null })
      .where(inArray(schema.crmRecords.id, batch));
  }
  return matched.size;
}

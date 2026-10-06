/**
 * Test a record, "What would be written to Salesforce" (plan 1E Task 11): the dry run's row. `ai_record_test_calls.dry_run`
 * holds, in turn:
 *
 *   null                  never asked
 *   { pending: true, … }  being worked out: `claimedAt` is the press that holds it (one at a time, across replicas; a claim
 *                         older than CLAIM_STALE_MS is free again, so a crash never locks the call), and `mapping` is the
 *                         mapping model's answer, kept as soon as it is paid for, so a later failure never pays again
 *   RecordTestDryRun      the answer; pressing again reads it
 *
 * The pending shape never parses as a RecordTestDryRun, so the page reads it as "not yet". Reads and writes this table only.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { RecordTestDryRun } from '@cti/contracts';
import type { Db } from '@cti/db';
import { Disposition, type MappedAnswers } from '../writeback/mapping-model.js';

/** A press's claim lapses after this: the model call and the reads finish well within it. */
export const CLAIM_STALE_MS = 3 * 60_000;

const MappedAnswersSchema = z.object({
  disposition: Disposition,
  dispositionEvidence: z.string().optional(),
  values: z.record(z.object({ value: z.union([z.string(), z.array(z.string()), z.number(), z.boolean()]), evidence: z.string() })),
});
/** The mapping model's answer: the seller's answers, or (failed) the model answered without them. */
const StoredMapping = z.object({ mapped: MappedAnswersSchema.nullable(), failed: z.boolean() });
export type StoredMapping = { mapped: MappedAnswers | null; failed: boolean };
const Pending = z.object({ pending: z.literal(true), claimedAt: z.string().nullable(), mapping: StoredMapping.nullable() });

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const isPending = sql`(dry_run->>'pending') = 'true'`;

/** The stored mapping of a dry run being worked out; null when there is none (or the column holds something else). */
export function storedMappingOf(dryRun: unknown): StoredMapping | null {
  const pending = Pending.safeParse(dryRun);
  return pending.success ? pending.data.mapping : null;
}

export type Claim = { claimed: true; mapping: StoredMapping | null } | { claimed: false; done: RecordTestDryRun | null };

/** Takes the call's dry run for this press, keeping any stored mapping. Not claimed: the answer, or null (another press holds it). */
export async function claimDryRun(db: Db, orgId: string, callId: string, now: Date): Promise<Claim> {
  const stale = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const taken = await db.execute(sql`
    update ai_record_test_calls
    set dry_run = jsonb_build_object('pending', true, 'claimedAt', ${now.toISOString()}::text, 'mapping', coalesce(dry_run->'mapping', 'null'::jsonb))
    where id = ${callId}::uuid and org_id = ${orgId}::uuid
      and (dry_run is null or (${isPending} and (dry_run->>'claimedAt' is null or (dry_run->>'claimedAt')::timestamptz < ${stale}::timestamptz)))
    returning dry_run`);
  const row = rows<{ dry_run: unknown }>(taken)[0];
  if (row) return { claimed: true, mapping: storedMappingOf(row.dry_run) };
  const current = await db.execute(sql`select dry_run from ai_record_test_calls where id = ${callId}::uuid and org_id = ${orgId}::uuid`);
  const done = RecordTestDryRun.safeParse(rows<{ dry_run: unknown }>(current)[0]?.dry_run);
  return { claimed: false, done: done.success ? done.data : null };
}

/** Keeps the mapping model's answer on the pending row, the moment it is paid for. */
export async function saveMapping(db: Db, orgId: string, callId: string, mapping: StoredMapping): Promise<void> {
  const json = JSON.stringify(StoredMapping.parse(mapping));
  await db.execute(sql`
    update ai_record_test_calls set dry_run = jsonb_set(dry_run, '{mapping}', ${json}::jsonb)
    where id = ${callId}::uuid and org_id = ${orgId}::uuid and ${isPending}`);
}

/** A press that failed lets go, so the next press can start at once (the stored mapping stays). */
export async function releaseDryRun(db: Db, orgId: string, callId: string): Promise<void> {
  await db.execute(sql`
    update ai_record_test_calls set dry_run = jsonb_set(dry_run, '{claimedAt}', 'null'::jsonb)
    where id = ${callId}::uuid and org_id = ${orgId}::uuid and ${isPending}`);
}

/** Stores the answer once; a press that raced another gets the one stored first. */
export async function storeDryRun(db: Db, orgId: string, callId: string, dryRun: RecordTestDryRun): Promise<RecordTestDryRun> {
  const json = JSON.stringify(dryRun);
  const done = await db.execute(sql`
    update ai_record_test_calls set dry_run = ${json}::jsonb
    where id = ${callId}::uuid and org_id = ${orgId}::uuid and (dry_run is null or ${isPending}) returning id`);
  if (rows(done).length > 0) return dryRun;
  const again = await db.execute(sql`select dry_run from ai_record_test_calls where id = ${callId}::uuid and org_id = ${orgId}::uuid`);
  const stored = RecordTestDryRun.safeParse(rows<{ dry_run: unknown }>(again)[0]?.dry_run);
  return stored.success ? stored.data : dryRun;
}

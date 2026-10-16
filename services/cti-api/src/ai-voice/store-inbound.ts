/**
 * The SQL only an INBOUND test call runs (plan 2026-10-16 inbound agent testing; final review M-2, M-3). Builders
 * only — `drizzleAiCallStore` (store.ts) runs them; store-inbound.test.ts pins the rendered SQL. Every statement is
 * limited to `direction = 'inbound'` rows, so no outbound call is ever read or written by them.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { INBOUND_STATUSES } from '@cti/contracts';
import { getDb, schema } from '@cti/db';

type Db = ReturnType<typeof getDb>;
const t = schema.aiCalls;

/** The status among the saved fields when it is one of the four (save_caller_details drops any other), else null. */
const savedStatus = (fields: Record<string, string>): string | null =>
  (INBOUND_STATUSES as readonly string[]).includes(fields.status ?? '') ? (fields.status as string) : null;

/**
 * save_caller_details' write: the fields merged into `qualification`, exactly as `mergeQualification` merges an outbound
 * call's. With a valid status it also sets the OUTCOME — but only on a row that has already ended: finalize computes the
 * outcome from the saved status, so a save that lands after finalize (the caller hung up while it was in flight) must
 * not leave a call that saved a status reading "Incomplete" (final review M-2). A live row's outcome is finalize's.
 */
export const mergeCallerDetailsQuery = (db: Db, id: string, fields: Record<string, string>) => {
  const status = savedStatus(fields);
  return db
    .update(t)
    .set({
      qualification: sql`${t.qualification} || ${JSON.stringify(fields)}::jsonb`,
      ...(status !== null ? { outcome: sql`case when ${t.endedAt} is not null then ${status} else ${t.outcome} end` } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(t.id, id), eq(t.direction, 'inbound')));
};

/**
 * The open inbound row this org already has for a CallSid (ai_calls_call_sid_unique holds one per CallSid): what a
 * replayed inbound webhook streams to instead of falling back to today's routing.
 */
export const openInboundByCallSidQuery = (db: Db, orgId: string, callSid: string) =>
  db
    .select()
    .from(t)
    .where(and(eq(t.orgId, orgId), eq(t.callSid, callSid), eq(t.direction, 'inbound'), isNull(t.endedAt)))
    .limit(1);

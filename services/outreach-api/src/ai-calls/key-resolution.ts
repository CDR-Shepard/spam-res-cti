/**
 * What cti-api did with an idempotency key outreach-api kept (final fixes round 2).
 *
 * A touch whose `trigger_key` is set may have reached cti-api: a transport failure, an `in_flight` answer, a reaped tick.
 * cti-api reserves the key in `ai_call_requests` BEFORE it dials and stores every answer under it (request-store.ts). Both
 * services share the database, so before any path drops a kept key (a new key after a 409, a skip, a park), outreach-api
 * reads that table here instead of guessing. Dropping a key whose call was placed would let a later fresh key call the same
 * person a second time.
 *
 * This mirrors cti-api's routes-internal.ts handleTrigger for an existing key, read-only (cti-api code is never imported;
 * the tables are read through @cti/db):
 *  - no row: cti-api never reserved the key, so it never dialed under it (`none`);
 *  - a stored answer: that answer (`answered`);
 *  - no answer, reserved or taken over (updated_at) less than STALE_REQUEST_MS ago: still in flight (`pending`);
 *  - no answer and stale: the ai_calls row a crashed request left (cti-api's findCallSince: same org, the reserving user,
 *    the record, created since the reservation's created_at minus FIND_SLACK_MS), rebuilt as cti-api's `rebuilt` does;
 *    nothing found is `none`. outreach-api never writes the row: cti-api's takeover stays its only writer.
 */
import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { AiCallBlockReason, InternalAiCallResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { TRIGGER_TIMEOUT_MS } from './cti-client.js';
import { IN_FLIGHT_RETRY_MS } from './pacing-rules.js';

/** cti-api's STALE_REQUEST_MS (request-store.ts): an unanswered reservation untouched this long is a crashed request (CF-13). */
export const STALE_REQUEST_MS = IN_FLIGHT_RETRY_MS;
/** cti-api's FIND_SLACK_MS (routes-internal.ts): a crashed request's ai_calls row may predate its reservation by clock skew. */
export const FIND_SLACK_MS = 5_000;

export type KeyResolution =
  | { kind: 'none' }
  | { kind: 'answered'; answer: InternalAiCallResponse }
  /** No answer yet: cti-api answers `in_flight` until `until` (updated_at + STALE_REQUEST_MS). */
  | { kind: 'pending'; createdAt: Date; until: Date };

/** What a planned touch's kept key means for a path about to drop it. `placed`: the call was linked and the touch is sent. */
export type KeptKey = { kind: 'free' } | { kind: 'placed'; aiCallId: string } | { kind: 'pending'; until: Date };

const BLOCK_REASONS: ReadonlySet<string> = new Set(AiCallBlockReason.options);
const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

interface FoundCall {
  id: string;
  status: string;
  blockReason: string | null;
  callSid: string | null;
}

/** cti-api's `rebuilt`: the answer a crashed request would have given, from the ai_calls row it left. Never "not placed" unless sure. */
function rebuilt(row: FoundCall): InternalAiCallResponse {
  if (row.status === 'blocked' && row.blockReason && BLOCK_REASONS.has(row.blockReason)) {
    return { result: 'blocked', reason: row.blockReason as AiCallBlockReason, aiCallId: row.id };
  }
  if (row.status === 'failed' && row.callSid === null) return { result: 'failed', reason: 'twilio_error', aiCallId: row.id };
  return { result: 'placed', aiCallId: row.id };
}

/**
 * cti-api's findCallSince for a record target. The reserving user is the row's `user_id`; it is null only when that user
 * was deleted (ai_calls.started_by keeps its users row, so no call of theirs can exist then): any user's call counts, which
 * can only make a call be found, never missed.
 */
async function findCallSince(db: Db, a: { orgId: string; userId: string | null; sfRecordId: string; since: Date }): Promise<FoundCall | null> {
  const c = schema.aiCalls;
  const where: SQL[] = [eq(c.orgId, a.orgId), eq(c.sfRecordId, a.sfRecordId), gte(c.createdAt, a.since)];
  if (a.userId !== null) where.push(eq(c.startedBy, a.userId));
  const [row] = await db
    .select({ id: c.id, status: c.status, blockReason: c.blockReason, callSid: c.callSid })
    .from(c)
    .where(and(...where))
    .orderBy(desc(c.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * What cti-api did with `key` (see the module comment). `sfRecordId` is the record the trigger named (campaign triggers are
 * always record targets); `now` is the tick's clock, compared with updated_at as cti-api compares its own.
 *
 * `none` means the request never reached cti-api only when no request with this key can still be on its way: the touch
 * was claimed at least TRIGGER_TIMEOUT_MS ago, or its trigger has already answered (a 409). settleKeptKey checks the first.
 */
export async function resolveKey(db: Db, k: { orgId: string; key: string; sfRecordId: string }, now: Date): Promise<KeyResolution> {
  const r = schema.aiCallRequests;
  const [row] = await db
    .select({ userId: r.userId, response: r.response, createdAt: r.createdAt, updatedAt: r.updatedAt })
    .from(r)
    .where(and(eq(r.orgId, k.orgId), eq(r.idempotencyKey, k.key)))
    .limit(1);
  if (!row) return { kind: 'none' };
  if (row.response !== null) {
    const answer = InternalAiCallResponse.safeParse(row.response);
    // An answer this version cannot read falls through to the ai_calls lookup, which can only find a call, never invent "not placed".
    if (answer.success) return { kind: 'answered', answer: answer.data };
  } else if (now.getTime() - row.updatedAt.getTime() < STALE_REQUEST_MS) {
    return { kind: 'pending', createdAt: row.createdAt, until: new Date(row.updatedAt.getTime() + STALE_REQUEST_MS) };
  }
  const since = new Date(row.createdAt.getTime() - FIND_SLACK_MS);
  const found = await findCallSince(db, { orgId: k.orgId, userId: row.userId, sfRecordId: k.sfRecordId, since });
  return found ? { kind: 'answered', answer: rebuilt(found) } : { kind: 'none' };
}

/**
 * A placed answer found under a kept key: the PLANNED touch is sent with that call, exactly as if the trigger had answered
 * (the results tick takes it from there). A lead at `approved` whose approved plan is the touch's (approved again after a
 * hold) goes to `queued`, as a release would, so "Call all approved" cannot make a second touch for the same call.
 * True when the touch was linked.
 */
async function linkPlacedTouch(db: Db, touchId: string, aiCallId: string, now: Date): Promise<boolean> {
  const result = await db.execute(sql`
    with linked as (
      update touches t
      set status = 'sent', sent_at = ${iso(now)}, trigger_key = null, last_block_reason = null, updated_at = ${iso(now)},
          ai_call_id = (select a.id from ai_calls a where a.id = ${aiCallId}::uuid and a.org_id = t.org_id)
      where t.id = ${touchId}::uuid and t.status = 'planned'
      returning t.enrollment_id, t.call_plan_id
    ), queued as (
      update campaign_enrollments e set call_stage = 'queued', updated_at = ${iso(now)}
      from linked l
      where e.id = l.enrollment_id and e.status = 'active' and e.call_stage = 'approved'
        and exists (select 1 from call_plans p where p.id = l.call_plan_id and p.enrollment_id = e.id and p.status = 'approved')
      returning e.id
    )
    select (select count(*)::int from linked) as n`);
  return (rows<{ n: number }>(result)[0]?.n ?? 0) > 0;
}

/**
 * Before a path drops a PLANNED touch's kept key: `free` (no key, cti-api never dialed under it, or it refused) lets the
 * path go on; `placed` linked the call, so the path must not skip the touch; `pending` means cti-api may still be dialing
 * under the key until `until`, so the path leaves the touch and its key alone. A touch claimed less than TRIGGER_TIMEOUT_MS
 * ago whose request cti-api has not reserved (yet) is pending, never `none`.
 */
export async function settleKeptKey(db: Db, touchId: string, now: Date): Promise<KeptKey> {
  const result = await db.execute(sql`
    select t.org_id as "orgId", t.trigger_key as "key", t.claimed_at as "claimedAt", r.sf_record_id as "sfRecordId"
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    where t.id = ${touchId}::uuid and t.status = 'planned' and t.trigger_key is not null`);
  const touch = rows<{ orgId: string; key: string; claimedAt: Date | string | null; sfRecordId: string }>(result)[0];
  if (!touch) return { kind: 'free' };
  const resolved = await resolveKey(db, touch, now);
  if (resolved.kind === 'pending') return { kind: 'pending', until: resolved.until };
  if (resolved.kind === 'answered') {
    if (resolved.answer.result !== 'placed') return { kind: 'free' };
    const aiCallId = resolved.answer.aiCallId;
    return (await linkPlacedTouch(db, touchId, aiCallId, now)) ? { kind: 'placed', aiCallId } : { kind: 'free' };
  }
  const claimedAt = touch.claimedAt === null ? null : new Date(touch.claimedAt);
  if (claimedAt && now.getTime() - claimedAt.getTime() < TRIGGER_TIMEOUT_MS) {
    return { kind: 'pending', until: new Date(claimedAt.getTime() + TRIGGER_TIMEOUT_MS) };
  }
  return { kind: 'free' };
}

/**
 * settleKeptKey for every planned touch with a kept key of these enrollments (a hold). Returns the touches still pending,
 * which the caller must leave alone; a linked touch is `sent` and no longer open.
 */
export async function settleKeptKeys(db: Db, enrollmentIds: readonly string[], now: Date): Promise<string[]> {
  if (enrollmentIds.length === 0) return [];
  const keyed = await db.execute(sql`
    select id from touches
    where enrollment_id in (${sql.join(enrollmentIds.map((id) => sql`${id}::uuid`), sql`, `)})
      and status = 'planned' and trigger_key is not null`);
  const pending: string[] = [];
  for (const { id } of rows<{ id: string }>(keyed)) {
    if ((await settleKeptKey(db, id, now)).kind === 'pending') pending.push(id);
  }
  return pending;
}

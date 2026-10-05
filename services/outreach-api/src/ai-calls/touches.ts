/**
 * The AI call touches the `ai_call.place` tick works on: what is due, what is live, and the
 * compare-and-swaps that move a touch `planned → dialing → sent | planned | failed`.
 *
 * The claim is the last word before a call (CF-2, CF-10, CF-11): in ONE statement it requires
 * the campaign to be an active ai_call campaign, the enrollment active and `queued`, the
 * touch's plan to be the enrollment's approved plan, consent read as exactly `yes` by that
 * plan's own research, no do-not-contact flag pending on the record and none on the plan that
 * nobody dismissed, and the lead still ticked in the campaign's lead picker. The enrollment
 * row is locked FOR SHARE first, in its own statement, so the claim's snapshot is taken after
 * any writer holding it (an approval, a hold, an exit) has committed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { schema, type Db } from '@cti/db';
import { exitEnrollment } from '../campaigns/enroll.js';
import { DNC_PENDING_SQL } from '../call-plans/dnc-sql.js';
import { IN_FLIGHT_RETRY_MS } from './pacing-rules.js';

/** A `dialing` touch with no call after this long lost its tick (a crash mid-trigger). */
export const STALE_DIALING_MS = 5 * 60_000;
export const PLACE_CANDIDATES_PER_ORG = 20;
export const LIVE_AI_CALL_STATUSES = ['queued', 'ringing', 'in_progress', 'transferring'] as const;
/** A placed call counts as live only this long after it was created (a row stuck `queued` must not hold a slot forever). */
export const LIVE_CALL_WINDOW_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface AiTouchCandidate {
  touchId: string;
  orgId: string;
  campaignId: string;
  enrollmentId: string;
  crmRecordId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  seq: number;
  attempts: number;
  callPlanId: string | null;
  requestedBy: string | null;
  phones: Array<{ field: string; e164: string }>;
  /** No earlier ai_call touch of the enrollment was sent: the plan's preferred window applies to its first trigger. */
  firstAiTouch: boolean;
}

export type Settle =
  | { kind: 'placed'; aiCallId: string }
  /** `refundAttempt`: the failure was about the system, not the person (I-1): the claim's attempt is given back. */
  | { kind: 'retry'; at: Date; reason: string; keepKey: boolean; refundAttempt: boolean }
  | { kind: 'failed'; reason: string; aiCallId: string | null };

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

/** The due scope (dueAiCallTouches' test case 1), with touches `t`, enrollments `e`, campaigns `c`. */
const dueScope = (now: Date) => sql`
  t.channel = 'ai_call' and t.status = 'planned' and t.due_at <= ${iso(now)}
  and e.status = 'active' and c.status = 'active' and c.mode = 'ai_call'`;

export async function orgsWithDueAiCalls(db: Db, now: Date): Promise<string[]> {
  const result = await db.execute(sql`
    select distinct t.org_id as "orgId"
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join campaigns c on c.id = e.campaign_id and c.org_id = e.org_id
    where ${dueScope(now)}
    order by 1`);
  return rows<{ orgId: string }>(result).map((r) => r.orgId);
}

export async function dueAiCallTouches(db: Db, orgId: string, now: Date, limit: number): Promise<AiTouchCandidate[]> {
  const result = await db.execute(sql`
    select t.id as "touchId", t.org_id as "orgId", e.campaign_id as "campaignId", t.enrollment_id as "enrollmentId",
           e.crm_record_id as "crmRecordId", r.sf_object as "sfObject", r.sf_record_id as "sfRecordId", t.seq, t.attempts,
           t.call_plan_id as "callPlanId", t.requested_by as "requestedBy", r.phones,
           not exists (
             select 1 from touches x where x.enrollment_id = t.enrollment_id and x.channel = 'ai_call' and x.status = 'sent' and x.id <> t.id
           ) as "firstAiTouch"
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join campaigns c on c.id = e.campaign_id and c.org_id = e.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    where t.org_id = ${orgId}::uuid and ${dueScope(now)}
    order by t.due_at, t.id
    limit ${limit}`);
  return rows<AiTouchCandidate>(result);
}

/** This tenant's `dialing` AI touches plus placed calls still live (created in the last hour). */
export async function liveAiCallCount(db: Db, orgId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - LIVE_CALL_WINDOW_MS);
  const result = await db.execute(sql`
    select (select count(*)::int from touches t where t.org_id = ${orgId}::uuid and t.channel = 'ai_call' and t.status = 'dialing')
         + (select count(*)::int from touches t join ai_calls a on a.id = t.ai_call_id and a.org_id = t.org_id
            where t.org_id = ${orgId}::uuid and t.channel = 'ai_call' and t.status = 'sent'
              and a.status in (${sql.join(LIVE_AI_CALL_STATUSES.map((s) => sql`${s}`), sql`, `)}) and a.created_at > ${iso(since)}) as n`);
  return rows<{ n: number }>(result)[0]?.n ?? 0;
}

/** AI calls this tenant placed in the rolling 24 hours before `now`. */
export async function placedInLastDay(db: Db, orgId: string, now: Date): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n from touches t
    where t.org_id = ${orgId}::uuid and t.channel = 'ai_call' and t.status = 'sent' and t.sent_at > ${iso(new Date(now.getTime() - DAY_MS))}`);
  return rows<{ n: number }>(result)[0]?.n ?? 0;
}

/** Everything that must still hold for this touch to be called (see the module comment). Aliases: t, e, c, r, p, cr. */
const claimable = sql`
  t.status = 'planned' and t.channel = 'ai_call'
  and e.id = t.enrollment_id and e.org_id = t.org_id and e.status = 'active' and e.call_stage = 'queued'
  and c.id = e.campaign_id and c.org_id = e.org_id and c.status = 'active' and c.mode = 'ai_call'
  and r.id = e.crm_record_id and r.org_id = e.org_id
  and p.id = t.call_plan_id and p.enrollment_id = e.id and p.org_id = e.org_id and p.status = 'approved'
  and (not p.dnc_flagged or p.dnc_dismissed_at is not null)
  and cr.id = p.research_id and cr.snapshot ->> 'consent' = 'yes'
  and not ${DNC_PENDING_SQL}
  and exists (select 1 from campaign_selections cs where cs.campaign_id = e.campaign_id and cs.org_id = e.org_id and cs.sf_record_id = r.sf_record_id)`;

/**
 * `planned → dialing`: one more attempt, and the key kept from a retry that may still be in cti-api, or a new one:
 * `touch:<touch id>:<attempt>:<claim time in ms>`. The claim time makes a new key unique even when an attempt was given back
 * (I-1) and the attempt number repeats: cti-api stores every answer under its key, so a repeated key would only replay the
 * old refusal. A touch is claimed again only once due again, always at a later tick, so the claim time never repeats.
 */
export async function claimAiTouch(db: Db, touchId: string, now: Date): Promise<{ attempts: number; triggerKey: string } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select 1 from campaign_enrollments where id = (select enrollment_id from touches where id = ${touchId}::uuid) for share`);
    const result = await tx.execute(sql`
      update touches t
      set status = 'dialing', claimed_at = ${iso(now)}, updated_at = ${iso(now)}, attempts = t.attempts + 1,
          trigger_key = coalesce(t.trigger_key, 'touch:' || t.id || ':' || (t.attempts + 1) || ':' || ${String(now.getTime())}::text)
      from campaign_enrollments e, campaigns c, crm_records r, call_plans p, call_research cr
      where t.id = ${touchId}::uuid and ${claimable}
      returning t.attempts, t.trigger_key as "triggerKey"`);
    return rows<{ attempts: number; triggerKey: string }>(result)[0] ?? null;
  });
}

/** The answer to a trigger, applied only to a touch still `dialing`. */
export async function settleTouch(db: Db, touchId: string, s: Settle, now: Date): Promise<void> {
  const t = schema.touches;
  const set =
    s.kind === 'placed'
      ? { status: 'sent' as const, sentAt: now, aiCallId: s.aiCallId, triggerKey: null, lastBlockReason: null }
      : s.kind === 'retry'
        ? {
            status: 'planned' as const,
            dueAt: s.at,
            lastBlockReason: s.reason,
            ...(s.keepKey ? {} : { triggerKey: null }),
            ...(s.refundAttempt ? { attempts: sql<number>`greatest(${t.attempts} - 1, 0)` } : {}),
          }
        : { status: 'failed' as const, lastBlockReason: s.reason, triggerKey: null, ...(s.aiCallId ? { aiCallId: s.aiCallId } : {}) };
  await db.update(t).set({ ...set, updatedAt: now }).where(and(eq(t.id, touchId), eq(t.status, 'dialing')));
}

/** Not now (outside the window, or not claimable this tick): a `planned` touch waits until `at`. Nothing is claimed or counted. */
export async function deferTouch(db: Db, touchId: string, at: Date, reason: string): Promise<void> {
  const t = schema.touches;
  await db.update(t).set({ dueAt: at, lastBlockReason: reason, updatedAt: sql`now()` }).where(and(eq(t.id, touchId), eq(t.status, 'planned')));
}

/** A `planned` touch that must not be called (its plan is no longer approved, or the lead is going back to research). */
export async function skipTouch(db: Db, touchId: string, reason: string, now: Date): Promise<boolean> {
  const t = schema.touches;
  const done = await db
    .update(t)
    .set({ status: 'skipped', skipReason: reason, lastBlockReason: reason, updatedAt: now })
    .where(and(eq(t.id, touchId), eq(t.status, 'planned')))
    .returning({ id: t.id });
  return done.length > 0;
}

/** Enrollment states that end it: a stale `dialing` touch of one of these is skipped, never planned again (A3). */
const ENDED_ENROLLMENT_STATUSES = ['exited', 'completed', 'handed_off'] as const;
export const REAPED_ENDED_REASON = 'enrollment_ended';

/**
 * A `dialing` touch with no call whose tick died goes back to `planned`, KEEPING its key: if cti-api got the request, the
 * same key returns its answer and never dials twice. Because the key is kept, it is due no earlier than IN_FLIGHT_RETRY_MS
 * after the original claim (A3, CF-13: cti-api answers in_flight until its reservation is stale). The claim then
 * re-checks everything, so a touch left over from before a reactivation (its plan superseded, CF-3) is never called; the
 * tick skips it. A touch whose enrollment has ended (exited, completed, handed off) is skipped instead, so the results
 * page stops waiting on it. Returns how many touches were reaped either way.
 */
export async function reapStaleDialing(db: Db, now: Date): Promise<number> {
  const staleScope = sql`t.channel = 'ai_call' and t.status = 'dialing' and t.ai_call_id is null
      and t.claimed_at < ${iso(new Date(now.getTime() - STALE_DIALING_MS))}
      and e.id = t.enrollment_id`;
  const ended = sql.join(ENDED_ENROLLMENT_STATUSES.map((s) => sql`${s}`), sql`, `);
  const skipped = await db.execute(sql`
    update touches t set status = 'skipped', skip_reason = ${REAPED_ENDED_REASON}, last_block_reason = ${REAPED_ENDED_REASON}, updated_at = ${iso(now)}
    from campaign_enrollments e
    where ${staleScope} and e.status in (${ended})
    returning t.id`);
  const planned = await db.execute(sql`
    update touches t
    set status = 'planned', due_at = greatest(${iso(now)}, t.claimed_at + make_interval(secs => ${IN_FLIGHT_RETRY_MS / 1000})), updated_at = ${iso(now)}
    from campaign_enrollments e
    where ${staleScope} and e.status not in (${ended})
    returning t.id`);
  return rows<unknown>(skipped).length + rows<unknown>(planned).length;
}

/** Ends an `active` AI call enrollment (keys freed, open touches skipped) and closes its call stage; anything else is left alone. */
export async function finishAiEnrollment(db: Db, enrollmentId: string, reason: string, status: 'exited' | 'completed'): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await exitEnrollment(tx as unknown as Db, enrollmentId, { from: ['active'], reason, status });
    if (ended) {
      await tx.update(schema.campaignEnrollments).set({ callStage: 'done' }).where(eq(schema.campaignEnrollments.id, enrollmentId));
    }
    return ended;
  });
}

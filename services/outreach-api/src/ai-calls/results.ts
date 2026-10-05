/**
 * `ai_call.results`: turns finished AI calls (cti-api writes `ai_calls`; outreach-api only
 * reads it) into the enrollment's next step: a hand-off to a person, an exit, a completion,
 * or another call the next day (decision 9).
 *
 * Each call is counted once: `touches.counted_at` is set by a compare-and-swap, in the same
 * transaction as the step, so a second run (or a second tick running at once) changes nothing.
 * The step itself applies only to an enrollment still `active`: one held in Needs Review
 * meanwhile keeps its hold, and only the touch's outcome is recorded.
 */
import { inArray, sql } from 'drizzle-orm';
import { AiCallOutcome } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import type { RunnerLogger } from '../jobs/boss.js';
import { outreachSettings } from '../settings.js';
import { nextStepFor, TERMINAL_AI_CALL_STATUSES, type NextStep } from './outcomes.js';
import { nextAttemptAt } from './pacing-rules.js';
import { finishAiEnrollment } from './touches.js';

export const RESULTS_BATCH = 100;

export interface ResultCounts {
  handedOff: number;
  exited: number;
  completed: number;
  retried: number;
}

interface Finished {
  touch_id: string;
  enrollment_id: string;
  call_plan_id: string | null;
  requested_by: string | null;
  org_id: string;
  outcome: string | null;
  phones: Array<{ field: string; e164: string }>;
  answered: number;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

async function finishedCalls(db: Db): Promise<Finished[]> {
  const result = await db.execute(sql`
    select t.id as touch_id, t.enrollment_id, t.call_plan_id, t.requested_by, t.org_id, a.outcome, r.phones,
           (select count(*)::int from touches x where x.enrollment_id = t.enrollment_id and x.channel = 'ai_call' and x.status = 'sent') as answered
    from touches t
    join ai_calls a on a.id = t.ai_call_id and a.org_id = t.org_id
    join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    where t.channel = 'ai_call' and t.status = 'sent' and t.counted_at is null
      and a.status in (${sql.join(TERMINAL_AI_CALL_STATUSES.map((s) => sql`${s}`), sql`, `)})
    order by a.ended_at nulls last, t.id
    limit ${RESULTS_BATCH}`);
  return rows<Finished>(result);
}

/**
 * The next call, the next day, carrying the same plan and approver. Only for a lead still `active` whose touch's plan is
 * still the approved plan of this enrollment (A2: a lead reactivated while the call was live has its plan superseded, and
 * research makes the next one), with no touch that has not started (a `dialing` touch only counts when it carries this plan: one left from before a reactivation, CF-3,
 * is the reconciler's). The pacer re-checks everything (the plan still approved, consent, selection) before it calls.
 */
function insertRetry(f: Finished, dueAt: Date) {
  return sql`
    insert into touches (org_id, enrollment_id, seq, channel, status, due_at, gate_audit, call_plan_id, requested_by)
    select e.org_id, e.id,
           greatest(e.touches_done, coalesce((select max(t.seq) from touches t where t.enrollment_id = e.id), 0)) + 1,
           'ai_call', 'planned', ${iso(dueAt)}, '[]'::jsonb, ${f.call_plan_id}::uuid, ${f.requested_by}::uuid
    from campaign_enrollments e
    where e.id = ${f.enrollment_id}::uuid and e.status = 'active'
      and exists (
        select 1 from call_plans p
        where p.id = ${f.call_plan_id}::uuid and p.enrollment_id = e.id and p.status = 'approved')
      and not exists (
        select 1 from touches t
        where t.enrollment_id = e.id
          and (t.status in ('planned', 'held', 'queued') or (t.status = 'dialing' and t.call_plan_id is not distinct from ${f.call_plan_id}::uuid)))
    for share of e
    on conflict (enrollment_id, seq) do nothing
    returning id`;
}

async function applyStep(tx: Db, f: Finished, step: NextStep, now: Date): Promise<keyof ResultCounts | null> {
  switch (step.kind) {
    case 'hand_off': {
      const done = await tx.execute(sql`
        update campaign_enrollments set status = 'handed_off', call_stage = 'done', next_touch_at = null, updated_at = ${iso(now)}
        where id = ${f.enrollment_id}::uuid and status = 'active' returning id`);
      return rows<unknown>(done).length > 0 ? 'handedOff' : null;
    }
    case 'exit':
      return (await finishAiEnrollment(tx, f.enrollment_id, step.reason, 'exited')) ? 'exited' : null;
    case 'complete':
      return (await finishAiEnrollment(tx, f.enrollment_id, step.reason, 'completed')) ? 'completed' : null;
    case 'retry': {
      const inserted = await tx.execute(insertRetry(f, nextAttemptAt(f.phones[0]?.e164 ?? null, now)));
      return rows<unknown>(inserted).length > 0 ? 'retried' : null;
    }
  }
}

/** One finished call in one transaction: counted once, then the step. Returns what happened to the enrollment, if anything. */
async function collectOne(db: Db, f: Finished, maxAttempts: number, now: Date): Promise<keyof ResultCounts | null> {
  const outcome = AiCallOutcome.safeParse(f.outcome);
  return db.transaction(async (tx) => {
    const counted = await tx.execute(sql`
      update touches set outcome = ${f.outcome}, counted_at = ${iso(now)}, updated_at = ${iso(now)}
      where id = ${f.touch_id}::uuid and counted_at is null returning id`);
    if (rows<unknown>(counted).length === 0) return null;
    await tx.execute(sql`
      update campaign_enrollments set touches_done = touches_done + 1, updated_at = ${iso(now)} where id = ${f.enrollment_id}::uuid`);
    const step = nextStepFor(outcome.success ? outcome.data : null, f.answered, maxAttempts);
    return applyStep(tx as unknown as Db, f, step, now);
  });
}

async function maxAttemptsByOrg(db: Db, orgIds: string[]): Promise<Map<string, number>> {
  if (orgIds.length === 0) return new Map();
  const orgs = await db.select({ id: schema.organizations.id, settings: schema.organizations.settings }).from(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  return new Map(orgs.map((o) => [o.id, outreachSettings({ settings: o.settings }).aiCallMaxAttempts]));
}

export async function collectAiCallResults(db: Db, now: Date, log: RunnerLogger): Promise<ResultCounts> {
  const counts: ResultCounts = { handedOff: 0, exited: 0, completed: 0, retried: 0 };
  const finished = await finishedCalls(db);
  const maxAttempts = await maxAttemptsByOrg(db, [...new Set(finished.map((f) => f.org_id))]);
  for (const f of finished) {
    try {
      const done = await collectOne(db, f, maxAttempts.get(f.org_id) ?? outreachSettings({ settings: {} }).aiCallMaxAttempts, now);
      if (done) counts[done] += 1;
    } catch (err) {
      // This call stays uncounted and is tried again next tick; the rest of the batch goes on.
      log.error({ touchId: f.touch_id, errName: errName(err) }, 'ai_call.results: applying a call result failed');
    }
  }
  return counts;
}

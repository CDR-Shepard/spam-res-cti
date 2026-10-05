/**
 * The `touch.plan` tick: plan the next touch for every due enrollment, then
 * move due rep-call touches of ACTIVE campaigns into the call queue.
 *
 * Durable state lives in `touches` and `campaign_enrollments`; the tick is
 * safe to run twice at once. A touch insert re-checks "no open touch" inside
 * the same statement, and the unique (enrollment_id, seq) key turns a lost
 * race into a no-op.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { TriageResult, type ContactChannel, type TouchChannel } from '@cti/contracts';
import type { Db } from '@cti/db';
import { blockedTargets as firewallBlockedTargets, resolveRecipientState, resolveTimezone, type ConsentBlock } from '@cti/firewall';
import { holdIfFlagged } from '../campaigns/dnc-hold.js';
import { exitEnrollment } from '../campaigns/enroll.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { outreachSettings } from '../settings.js';
import { localDayStart, recipientTimezone } from './local-time.js';
import { isMobileField } from '../campaigns/eligibility.js';
import { DEFAULT_ORDER, HUMAN_DIAL_DEFER_MS, planTouch, recheckQueuedCall, type PlanDecision, type PlanInput } from './rules.js';

export type BlockLookup = (db: Db, orgId: string, numbers: readonly string[]) => Promise<Map<string, ConsentBlock>>;

export interface PlanDeps {
  db: Db;
  now: Date;
  log: RunnerLogger;
  batch?: number; // 200
  /** Injected in tests; defaults to the firewall's `blockedTargets`. */
  blockedTargets?: BlockLookup;
  /** True when the AI is configured: a record still waiting for triage is not
   *  planned until triage has run, or until 24 hours after enrollment, so the
   *  first touch uses the notes instead of the default channel order. */
  waitForTriage?: boolean;
}

const DEFAULT_BATCH = 200;
/** Touch statuses that count as "open": at most one per enrollment at a time (the plan view relies on it). */
export const OPEN_TOUCH_STATUSES = ['planned', 'held', 'queued', 'dialing'] as const;
const Phones = z.array(z.object({ field: z.string(), e164: z.string() }));
type Phone = z.infer<typeof Phones>[number];
type TouchDecision = Extract<PlanDecision, { kind: 'touch' }>;
type Outcome = 'planned' | 'exited' | 'held' | 'skipped';

interface DueRow {
  id: string;
  org_id: string;
  crm_record_id: string;
  touches_done: number;
  touch_days: number[];
  phones: unknown;
  email: string | null;
  state: string | null;
  consent_ai_call: boolean;
  sf_do_not_call: boolean;
  sf_email_opt_out: boolean;
  is_closed: boolean;
  skip_on_dialer: boolean;
  settings: unknown;
}

function rowsOf<T>(result: unknown): T[] {
  return (result as { rows: T[] }).rows;
}

const iso = (d: Date): string => d.toISOString();

async function loadDue(db: Db, now: Date, batch: number, waitForTriage: boolean): Promise<DueRow[]> {
  const triageWait = waitForTriage
    ? sql`and (not r.triage_needed or e.enrolled_at <= ${iso(now)}::timestamptz - interval '24 hours')`
    : sql``;
  const result = await db.execute(sql`
    select e.id, e.org_id, e.crm_record_id, e.touches_done, c.touch_days,
           r.phones, r.email, r.state, r.consent_ai_call, r.sf_do_not_call, r.sf_email_opt_out,
           r.is_closed, r.skip_on_dialer, o.settings
    from campaign_enrollments e
    join campaigns c on c.id = e.campaign_id
    join crm_records r on r.id = e.crm_record_id
    join organizations o on o.id = e.org_id
    where e.status = 'active'
      and c.status in ('dry_run', 'active')
      and e.next_touch_at <= ${iso(now)}::timestamptz
      ${triageWait}
      and not exists (
        select 1 from touches t
        where t.enrollment_id = e.id and t.status in ${[...OPEN_TOUCH_STATUSES]}
      )
    order by e.next_touch_at, e.id
    limit ${batch}`);
  return rowsOf<DueRow>(result);
}

async function latestTriageChannels(db: Db, crmRecordId: string, log: RunnerLogger): Promise<ContactChannel[]> {
  const result = await db.execute(sql`
    select result from record_triage where crm_record_id = ${crmRecordId} order by created_at desc limit 1`);
  const row = rowsOf<{ result: unknown }>(result)[0];
  if (!row) return [];
  const parsed = TriageResult.safeParse(row.result);
  if (!parsed.success) {
    log.warn({ crmRecordId }, 'planner: stored triage failed validation; using the default order');
    return [];
  }
  return parsed.data.channels.map((c) => c.channel);
}

async function lastSentChannel(db: Db, enrollmentId: string): Promise<TouchChannel | null> {
  const result = await db.execute(sql`
    select channel from touches where enrollment_id = ${enrollmentId} and status = 'sent' order by seq desc limit 1`);
  return rowsOf<{ channel: TouchChannel }>(result)[0]?.channel ?? null;
}

/** Any touch SENT to this person (any of their keys, any campaign) since local midnight. */
async function touchedSince(db: Db, orgId: string, keys: string[], since: Date): Promise<boolean> {
  if (keys.length === 0) return false;
  const result = await db.execute(sql`
    select exists (
      select 1 from touches t
      join enrollment_contact_keys k on k.enrollment_id = t.enrollment_id
      where k.org_id = ${orgId} and k.key in ${keys}
        and t.status = 'sent' and t.sent_at >= ${iso(since)}::timestamptz
    ) as touched`);
  return rowsOf<{ touched: boolean }>(result)[0]?.touched === true;
}

/** Latest human dial in the last 24 h: power-dial attempts plus click-to-dial calls (the daily cap's two sources). */
async function lastHumanDial(db: Db, orgId: string, numbers: string[], now: Date): Promise<Date | null> {
  if (numbers.length === 0) return null;
  const since = iso(new Date(now.getTime() - HUMAN_DIAL_DEFER_MS));
  const result = await db.execute(sql`
    select greatest(
      (select max(dialed_at) from dialer_dial_attempts
        where org_id = ${orgId} and to_number in ${numbers} and dialed_at >= ${since}::timestamptz),
      (select max(created_at) from calls
        where org_id = ${orgId} and direction = 'outbound' and normalized_to_number in ${numbers} and created_at >= ${since}::timestamptz)
    ) as at`);
  const at = rowsOf<{ at: Date | string | null }>(result)[0]?.at;
  return at ? new Date(at) : null;
}

/** Record state when it resolves to a US state, else the area code of the first mobile (then first) number. */
function recipientState(raw: string | null, phones: readonly Phone[]): string | null {
  const fromRecord = raw ? resolveTimezone({ state: raw }) : null;
  const code = fromRecord?.source === 'state' ? fromRecord.matched : null;
  const number = phones.find((p) => isMobileField(p.field)) ?? phones[0];
  return resolveRecipientState(code, number?.e164 ?? '');
}

async function safeBlocks(deps: PlanDeps, lookup: BlockLookup, row: DueRow, numbers: string[]): Promise<Map<string, ConsentBlock> | null> {
  try {
    return await lookup(deps.db, row.org_id, numbers);
  } catch (err) {
    deps.log.warn({ enrollmentId: row.id, err: (err as Error).message }, 'planner: suppression read failed; skipping this enrollment this tick (fail closed)');
    return null;
  }
}

async function loadPlanInput(deps: PlanDeps, lookup: BlockLookup, row: DueRow): Promise<PlanInput | null> {
  const { db, now, log } = deps;
  const parsedPhones = Phones.safeParse(row.phones);
  const phones = parsedPhones.success ? parsedPhones.data : [];
  const numbers = phones.map((p) => p.e164);
  const blocks = await safeBlocks(deps, lookup, row, numbers);
  if (!blocks) return null;
  const keys = [...numbers, ...(row.email ? [row.email.toLowerCase()] : [])];
  const today = localDayStart(now, recipientTimezone(numbers[0] ?? null));
  const [triageChannels, lastChannel, touchedToday, lastHumanDialAt] = await Promise.all([
    latestTriageChannels(db, row.crm_record_id, log),
    lastSentChannel(db, row.id),
    touchedSince(db, row.org_id, keys, today),
    lastHumanDial(db, row.org_id, numbers, now),
  ]);
  return {
    now,
    liveChannels: new Set(outreachSettings({ settings: row.settings }).liveChannels),
    triageChannels,
    defaultOrder: [...DEFAULT_ORDER],
    phones,
    email: row.email,
    consentAiCall: row.consent_ai_call,
    blocks,
    sfDoNotCall: row.sf_do_not_call,
    sfEmailOptOut: row.sf_email_opt_out,
    state: recipientState(row.state, phones),
    lastChannel,
    touchedToday,
    lastHumanDialAt,
    isClosed: row.is_closed,
    skipOnDialer: row.skip_on_dialer,
  };
}

/**
 * Insert the touch only if the enrollment is still active and still has no
 * open touch — checked in the same statement. seq is touches_done + 1, or one
 * past the highest seq already used when a touch was skipped without
 * advancing (needs-review), so the unique key never blocks a resumed enrollment.
 */
async function insertTouch(db: Db, enrollmentId: string, d: TouchDecision): Promise<boolean> {
  const result = await db.execute(sql`
    insert into touches (org_id, enrollment_id, seq, channel, status, due_at, gate_audit)
    select e.org_id, e.id,
           greatest(e.touches_done, coalesce((select max(t.seq) from touches t where t.enrollment_id = e.id), 0)) + 1,
           ${d.channel}, ${d.status}, ${iso(d.dueAt)}::timestamptz, ${JSON.stringify(d.audit)}::jsonb
    from campaign_enrollments e
    where e.id = ${enrollmentId} and e.status = 'active'
      and not exists (
        select 1 from touches t
        where t.enrollment_id = e.id and t.status in ${[...OPEN_TOUCH_STATUSES]}
      )
    on conflict (enrollment_id, seq) do nothing
    returning id`);
  return rowsOf<{ id: string }>(result).length > 0;
}

async function planOne(deps: PlanDeps, lookup: BlockLookup, row: DueRow): Promise<Outcome> {
  const { db, log } = deps;
  try {
    // A do-not-contact flag goes to a person before anything else happens to the enrollment.
    if (await holdIfFlagged(db, { enrollmentId: row.id, crmRecordId: row.crm_record_id, now: deps.now })) {
      log.info({ enrollmentId: row.id }, 'planner: do-not-contact flag pending; held for review instead of planning');
      return 'held';
    }
    if (row.touches_done >= row.touch_days.length) {
      await exitEnrollment(db, row.id, 'sequence_complete', 'completed');
      return 'exited';
    }
    const input = await loadPlanInput(deps, lookup, row);
    if (!input) return 'skipped';
    const decision = planTouch(input);
    if (decision.kind === 'exit') {
      await exitEnrollment(db, row.id, decision.reason);
      log.info({ enrollmentId: row.id, audit: decision.audit }, 'planner: no allowed channel; enrollment exited');
      return 'exited';
    }
    return (await insertTouch(db, row.id, decision)) ? 'planned' : 'skipped';
  } catch (err) {
    log.error({ enrollmentId: row.id, err: (err as Error).message }, 'planner: planning failed; retrying next tick');
    return 'skipped';
  }
}

export async function planDueEnrollments(deps: PlanDeps): Promise<{ planned: number; exited: number; held: number }> {
  const lookup = deps.blockedTargets ?? firewallBlockedTargets;
  const due = await loadDue(deps.db, deps.now, deps.batch ?? DEFAULT_BATCH, deps.waitForTriage ?? false);
  let planned = 0;
  let exited = 0;
  let held = 0;
  for (const row of due) {
    const outcome = await planOne(deps, lookup, row);
    if (outcome === 'planned') planned += 1;
    if (outcome === 'exited') exited += 1;
    if (outcome === 'held') held += 1;
  }
  return { planned, exited, held };
}

interface QueueRow extends DueRow {
  touch_id: string;
}

async function loadQueueCandidates(db: Db, now: Date, batch: number): Promise<QueueRow[]> {
  const result = await db.execute(sql`
    select t.id as touch_id, e.id, e.org_id, e.crm_record_id, e.touches_done, c.touch_days,
           r.phones, r.email, r.state, r.consent_ai_call, r.sf_do_not_call, r.sf_email_opt_out,
           r.is_closed, r.skip_on_dialer, o.settings
    from touches t
    join campaign_enrollments e on e.id = t.enrollment_id
    join campaigns c on c.id = e.campaign_id
    join crm_records r on r.id = e.crm_record_id
    join organizations o on o.id = e.org_id
    where c.status = 'active' and e.status = 'active'
      and t.status = 'planned' and t.channel = 'rep_call'
      and t.due_at <= ${iso(now)}::timestamptz
    order by t.due_at, t.id
    limit ${batch}`);
  return rowsOf<QueueRow>(result);
}

type Recheck = ReturnType<typeof recheckQueuedCall>;

/** The touch's campaign is still `active` (it may have been paused since the candidates were loaded). */
const campaignStillActive = sql`exists (
  select 1 from campaign_enrollments ce join campaigns cc on cc.id = ce.campaign_id
  where ce.id = touches.enrollment_id and cc.status = 'active')`;

/**
 * Apply one re-check verdict with a compare-and-swap on `status = 'planned'` and on the
 * campaign still being `active`, so a campaign paused mid-tick never has a touch queued,
 * deferred or skipped. True when this call changed the touch.
 */
async function applyRecheck(db: Db, touchId: string, verdict: Recheck): Promise<boolean> {
  const audit = JSON.stringify(verdict.audit);
  const result =
    verdict.kind === 'queue'
      ? await db.execute(sql`
          update touches set status = 'queued', gate_audit = gate_audit || ${audit}::jsonb, updated_at = now()
          where id = ${touchId} and status = 'planned' and ${campaignStillActive} returning id`)
      : verdict.kind === 'defer'
        ? await db.execute(sql`
            update touches set due_at = ${iso(verdict.dueAt)}::timestamptz, gate_audit = gate_audit || ${audit}::jsonb, updated_at = now()
            where id = ${touchId} and status = 'planned' and ${campaignStillActive} returning id`)
        : await db.execute(sql`
            update touches set status = 'skipped', skip_reason = ${verdict.reason}, gate_audit = gate_audit || ${audit}::jsonb, updated_at = now()
            where id = ${touchId} and status = 'planned' and ${campaignStillActive} returning id`);
  return rowsOf<{ id: string }>(result).length > 0;
}

export interface PromoteOptions {
  log?: RunnerLogger;
  batch?: number; // 200
  /** Injected in tests; defaults to the firewall's `blockedTargets`. */
  blockedTargets?: BlockLookup;
}

/**
 * In ACTIVE campaigns, due `planned` rep calls join the call queue. Dry-run touches stay
 * `planned`. A touch planned in a dry run can be days old, so each candidate is re-checked
 * with the planner's rules first (`recheckQueuedCall`): suppressed or unreachable → the
 * touch is `skipped` and counted, so the enrollment moves on to its next day; a recent
 * human dial, a touch already sent today, or a closed calling window → it stays `planned`
 * with `due_at` pushed to the next opening. The verdict is appended to `gate_audit`.
 * A record with a pending do-not-contact flag is held for review first (`holdIfFlagged`),
 * which skips the touch.
 * A suppression read that fails leaves the touch planned for the next tick (fail closed).
 * Returns the number of touches queued.
 */
export async function promoteQueuedCalls(db: Db, now: Date, opts: PromoteOptions = {}): Promise<number> {
  const log: RunnerLogger = opts.log ?? console;
  const lookup = opts.blockedTargets ?? firewallBlockedTargets;
  const deps: PlanDeps = { db, now, log, blockedTargets: lookup };
  const candidates = await loadQueueCandidates(db, now, opts.batch ?? DEFAULT_BATCH);
  let queued = 0;
  for (const row of candidates) {
    try {
      // Flagged since the call was planned: hold for review (which skips the touch) instead of queueing it.
      if (await holdIfFlagged(db, { enrollmentId: row.id, crmRecordId: row.crm_record_id, now })) {
        log.info({ touchId: row.touch_id, enrollmentId: row.id }, 'planner: do-not-contact flag pending; held for review instead of queueing');
        continue;
      }
      const input = await loadPlanInput(deps, lookup, row);
      if (!input) continue;
      const verdict = recheckQueuedCall(input);
      const changed = await applyRecheck(db, row.touch_id, verdict);
      if (changed && verdict.kind === 'queue') queued += 1;
      if (changed && verdict.kind === 'skip') await advanceAfterTouch(db, row.touch_id, now);
    } catch (err) {
      log.error({ touchId: row.touch_id, err: (err as Error).message }, 'planner: queue re-check failed; retrying next tick');
    }
  }
  return queued;
}

/**
 * Count a touch that reached `sent`, `failed`, or `skipped` and schedule the next one from
 * the enrollment date: next_touch_at = greatest(now, enrolled_at + touch_days[n] days) for
 * the n-th touch (0-based). After the last day the enrollment completes.
 *
 * Counted exactly once per touch: one statement stamps `touches.counted_at` (only where it
 * is still null, so a concurrent or repeated call matches no row) and, in the same
 * statement, increments `touches_done`. A guard on `touches_done < seq` is not enough,
 * because `seq` has gaps once a touch is skipped without advancing (needs-review).
 */
export async function advanceAfterTouch(db: Db, touchId: string, now: Date): Promise<void> {
  const result = await db.execute(sql`
    with counted as (
      update touches set counted_at = now(), updated_at = now()
      where id = ${touchId} and status in ('sent', 'failed', 'skipped') and counted_at is null
      returning enrollment_id
    )
    update campaign_enrollments e
    set touches_done = e.touches_done + 1,
        next_touch_at = case
          when e.touches_done + 1 >= cardinality(c.touch_days) then e.next_touch_at
          else greatest(${iso(now)}::timestamptz, e.enrolled_at + make_interval(days => c.touch_days[e.touches_done + 2]))
        end,
        updated_at = now()
    from counted, campaigns c
    where e.id = counted.enrollment_id and c.id = e.campaign_id
    returning e.id, e.status, e.touches_done, cardinality(c.touch_days) as total`);
  const row = rowsOf<{ id: string; status: string; touches_done: number; total: number }>(result)[0];
  if (row && row.status === 'active' && row.touches_done >= row.total) {
    await exitEnrollment(db, row.id, 'sequence_complete', 'completed');
  }
}

/** One `touch.plan` tick: plan, then promote, in that order, so a touch due now is queued in the same tick. */
export async function planTick(deps: PlanDeps): Promise<{ planned: number; exited: number; held: number; promoted: number }> {
  const { planned, exited, held } = await planDueEnrollments(deps);
  const promoted = await promoteQueuedCalls(deps.db, deps.now, { log: deps.log, batch: deps.batch, blockedTargets: deps.blockedTargets });
  if (planned + exited + held + promoted > 0) deps.log.info({ planned, exited, held, promoted }, 'touch.plan tick');
  return { planned, exited, held, promoted };
}

/**
 * "Call all approved": one planned ai_call touch per approved enrollment, carrying the plan
 * and its approver. It places no call: the pacer (Task 30) picks the touches up, makes the
 * fresh Salesforce read (CF-1) and re-checks the selection (CF-2) before it triggers anything.
 */
import { and, eq, sql } from 'drizzle-orm';
import { EditableCallPlan, type AiConsentStatus, type ReleaseCallsResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import { selectionExists } from '../campaigns/enroll.js';
import type { RequestContext } from '../tenancy/scope.js';
import { DecisionError } from './decisions.js';
import { DNC_PENDING_SQL } from './dnc-sql.js';
import { planTextProblems } from './plan-text-words.js';
import { gateWarnings, hasBlockingWarning } from './warnings.js';

export const RELEASE_MAX = 500;
/** Pages one call reads at most: with RELEASE_MAX a call looks at no more than 5,000 leads (M-3). */
export const RELEASE_MAX_PAGES = 10;

interface Releasable {
  enrollment_id: string;
  plan_id: string;
  decided_by: string;
  consent: string | null;
  plan: unknown;
  phones: Array<{ field: string; e164: string }>;
  sf_do_not_call: boolean;
  skip_on_dialer: boolean;
  is_closed: boolean;
  state: string | null;
  dnc_pending: boolean;
  dnc_flagged: boolean;
  /** This plan's own flag was dismissed (`call_plans.dnc_dismissed_at`). */
  dnc_dismissed: boolean;
  /** Paging cursor: `enrolled_at` as text keeps its microseconds. */
  enrolled_cursor: string;
}

const CONSENTS: readonly string[] = ['yes', 'no', 'field_missing', 'unknown'];

/**
 * The enrollment is locked FOR NO KEY UPDATE first, in its own statement, so that the insert's statement snapshot is
 * taken only after any editor or approver holding the row has committed. (Not FOR SHARE: two releases of one lead would
 * both hold the share and deadlock on the update, M-1. Now the second waits, then finds the lead already queued.)
 * The insert then requires the lead to be active, still `approved`, still selected, with THIS plan still its approved plan
 * (an edit and a new approval since the read make a different plan the approved one: no touch carries the stale plan, I-1),
 * and no touch that has not started. A `dialing` touch only blocks when it belongs to THIS plan; one left over from before
 * a reactivation (CF-3) is the reconciler's business, and the engine refuses a second simultaneous call to the person anyway.
 */
function insertTouch(r: Releasable, now: Date) {
  return sql`
    insert into touches (org_id, enrollment_id, seq, channel, status, due_at, gate_audit, call_plan_id, requested_by)
    select e.org_id, e.id,
           greatest(e.touches_done, coalesce((select max(t.seq) from touches t where t.enrollment_id = e.id), 0)) + 1,
           'ai_call', 'planned', ${now.toISOString()}::timestamptz, '[]'::jsonb, ${r.plan_id}::uuid, ${r.decided_by}::uuid
    from campaign_enrollments e
    where e.id = ${r.enrollment_id}::uuid and e.status = 'active' and e.call_stage = 'approved'
      and exists (select 1 from call_plans p where p.id = ${r.plan_id}::uuid and p.enrollment_id = e.id and p.status = 'approved')
      and ${selectionExists(sql`e.campaign_id`, sql`(select sf_record_id from crm_records where id = e.crm_record_id)`)}
      and not exists (
        select 1 from touches t
        where t.enrollment_id = e.id
          and (t.status in ('planned', 'held', 'queued') or (t.status = 'dialing' and t.call_plan_id = ${r.plan_id}::uuid)))
    on conflict (enrollment_id, seq) do nothing
    returning id`;
}

async function releaseOne(db: Db, r: Releasable, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from campaign_enrollments where id = ${r.enrollment_id}::uuid for no key update`);
    const inserted = await tx.execute(insertTouch(r, now));
    if ((inserted as unknown as { rows: unknown[] }).rows.length === 0) return false;
    await tx
      .update(schema.campaignEnrollments)
      .set({ callStage: 'queued', updatedAt: now })
      .where(and(eq(schema.campaignEnrollments.id, r.enrollment_id), eq(schema.campaignEnrollments.callStage, 'approved')));
    return true;
  });
}

/** The next page of approved leads after `after` (null: the first), oldest enrollment first; `more` = a lead follows the page. */
async function approvedPage(
  db: Db,
  ctx: RequestContext,
  campaignId: string,
  after: { at: string; id: string } | null,
  size: number,
): Promise<{ rows: Releasable[]; more: boolean }> {
  // The consent is the one the approved plan's own research read (CF-6), never the newest research.
  const result = await db.execute(sql`
    select e.id as enrollment_id, e.enrolled_at::text as enrolled_cursor, p.id as plan_id, p.decided_by, cr.snapshot ->> 'consent' as consent, p.plan,
           r.phones, r.sf_do_not_call, r.skip_on_dialer, r.is_closed, r.state,
           ${DNC_PENDING_SQL} as dnc_pending, p.dnc_flagged, (p.dnc_dismissed_at is not null) as dnc_dismissed
    from campaign_enrollments e
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    join call_plans p on p.enrollment_id = e.id and p.status = 'approved'
    join call_research cr on cr.id = p.research_id
    where e.org_id = ${ctx.orgId}::uuid and e.campaign_id = ${campaignId}::uuid and e.status = 'active' and e.call_stage = 'approved'
      ${after ? sql`and (e.enrolled_at, e.id) > (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
    order by e.enrolled_at, e.id
    limit ${size + 1}`);
  const rows = (result as unknown as { rows: Releasable[] }).rows;
  return { rows: rows.slice(0, size), more: rows.length > size };
}

/** An approved plan the voice agent would refuse is skipped here instead of failing at trigger time; an unreadable one too. */
function planProblems(stored: unknown): string[] {
  const plan = EditableCallPlan.safeParse(stored);
  return plan.success ? planTextProblems(plan.data) : ['the stored plan could not be read'];
}

function releasable(r: Releasable, blocks: Awaited<ReturnType<typeof blockedTargets>>, now: Date): boolean {
  const consent = r.consent && CONSENTS.includes(r.consent) ? (r.consent as AiConsentStatus) : null;
  const warnings = gateWarnings({
    consent,
    record: { phones: r.phones, sfDoNotCall: r.sf_do_not_call, skipOnDialer: r.skip_on_dialer, isClosed: r.is_closed, state: r.state },
    blocks,
    now,
    dnc: { pending: r.dnc_pending, flaggedNotDismissed: r.dnc_flagged && !r.dnc_dismissed },
    planTextProblems: planProblems(r.plan),
  });
  // Only an explicit yes goes out: a null consent has no warning of its own, but it is not consent either.
  return consent === 'yes' && !hasBlockingWarning(warnings);
}

/**
 * `max` caps the calls released, not the leads looked at: pages of `max` leads are read until `max` are released or
 * none are left, so leads the engine would refuse never starve the ones behind them (M-4). `maxPages` bounds the
 * reading (M-3); either cap stopping the call with approved leads unread answers `more: true`.
 */
export async function releaseApprovedCalls(
  db: Db,
  ctx: RequestContext,
  campaignId: string,
  now: Date,
  opts: { max?: number; maxPages?: number } = {},
): Promise<ReleaseCallsResponse> {
  const max = opts.max ?? RELEASE_MAX;
  const maxPages = opts.maxPages ?? RELEASE_MAX_PAGES;
  const [campaign] = await db
    .select({ mode: schema.campaigns.mode, status: schema.campaigns.status })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, ctx.orgId)));
  if (!campaign) throw new DecisionError('NOT_FOUND');
  if (campaign.mode !== 'ai_call') throw new DecisionError('NOT_AI_CALL_CAMPAIGN');
  if (campaign.status !== 'active') throw new DecisionError('CAMPAIGN_NOT_ACTIVE');
  let released = 0;
  let skipped = 0;
  let more = false;
  let after: { at: string; id: string } | null = null;
  for (let pages = 0; pages < maxPages && released < max; pages += 1) {
    const page = await approvedPage(db, ctx, campaignId, after, max);
    if (page.rows.length === 0) break;
    const blocks = await blockedTargets(db, ctx.orgId, [...new Set(page.rows.flatMap((r) => r.phones.map((p) => p.e164)))]);
    let unread = page.more;
    for (const r of page.rows) {
      if (released >= max) {
        unread = true;
        break;
      }
      if (releasable(r, blocks, now) && (await releaseOne(db, r, now))) released += 1;
      else skipped += 1;
    }
    more = unread;
    if (!page.more) break;
    const last = page.rows.at(-1)!;
    after = { at: last.enrolled_cursor, id: last.enrollment_id };
  }
  return { released, skipped, more };
}

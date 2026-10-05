/**
 * "Call all approved": one planned ai_call touch per approved enrollment, carrying the plan
 * and its approver. It places no call: the pacer (Task 30) picks the touches up, makes the
 * fresh Salesforce read (CF-1) and re-checks the selection (CF-2) before it triggers anything.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { AiConsentStatus, ReleaseCallsResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import { selectionExists } from '../campaigns/enroll.js';
import type { RequestContext } from '../tenancy/scope.js';
import { DecisionError } from './decisions.js';
import { DNC_PENDING_SQL } from './dnc-sql.js';
import { gateWarnings, hasBlockingWarning } from './warnings.js';

export const RELEASE_MAX = 500;

interface Releasable {
  enrollment_id: string;
  plan_id: string;
  decided_by: string;
  consent: string | null;
  phones: Array<{ field: string; e164: string }>;
  sf_do_not_call: boolean;
  skip_on_dialer: boolean;
  is_closed: boolean;
  state: string | null;
  dnc_pending: boolean;
  dnc_flagged: boolean;
  dnc_ever_dismissed: boolean;
}

const CONSENTS: readonly string[] = ['yes', 'no', 'field_missing', 'unknown'];

/**
 * The insert is one statement: the enrollment is locked FOR SHARE and must still be active, still
 * `approved` and still selected, and have no touch that has not started. A `dialing` touch only
 * blocks when it belongs to THIS plan; one left over from before a reactivation (CF-3) is the
 * reconciler's business, and the engine refuses a second simultaneous call to the person anyway.
 */
function insertTouch(r: Releasable, now: Date) {
  return sql`
    insert into touches (org_id, enrollment_id, seq, channel, status, due_at, gate_audit, call_plan_id, requested_by)
    select e.org_id, e.id,
           greatest(e.touches_done, coalesce((select max(t.seq) from touches t where t.enrollment_id = e.id), 0)) + 1,
           'ai_call', 'planned', ${now.toISOString()}::timestamptz, '[]'::jsonb, ${r.plan_id}::uuid, ${r.decided_by}::uuid
    from campaign_enrollments e
    where e.id = ${r.enrollment_id}::uuid and e.status = 'active' and e.call_stage = 'approved'
      and ${selectionExists(sql`e.campaign_id`, sql`(select sf_record_id from crm_records where id = e.crm_record_id)`)}
      and not exists (
        select 1 from touches t
        where t.enrollment_id = e.id
          and (t.status in ('planned', 'held', 'queued') or (t.status = 'dialing' and t.call_plan_id = ${r.plan_id}::uuid)))
    for share of e
    on conflict (enrollment_id, seq) do nothing
    returning id`;
}

async function releaseOne(db: Db, r: Releasable, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const inserted = await tx.execute(insertTouch(r, now));
    if ((inserted as unknown as { rows: unknown[] }).rows.length === 0) return false;
    await tx
      .update(schema.campaignEnrollments)
      .set({ callStage: 'queued', updatedAt: now })
      .where(and(eq(schema.campaignEnrollments.id, r.enrollment_id), eq(schema.campaignEnrollments.callStage, 'approved')));
    return true;
  });
}

export async function releaseApprovedCalls(db: Db, ctx: RequestContext, campaignId: string, now: Date): Promise<ReleaseCallsResponse> {
  const [campaign] = await db
    .select({ mode: schema.campaigns.mode, status: schema.campaigns.status })
    .from(schema.campaigns)
    .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, ctx.orgId)));
  if (!campaign) throw new DecisionError('NOT_FOUND');
  if (campaign.mode !== 'ai_call') throw new DecisionError('NOT_AI_CALL_CAMPAIGN');
  if (campaign.status !== 'active') throw new DecisionError('CAMPAIGN_NOT_ACTIVE');
  // The consent is the one the approved plan's own research read (CF-6), never the newest research.
  const result = await db.execute(sql`
    select e.id as enrollment_id, p.id as plan_id, p.decided_by, cr.snapshot ->> 'consent' as consent,
           r.phones, r.sf_do_not_call, r.skip_on_dialer, r.is_closed, r.state,
           ${DNC_PENDING_SQL} as dnc_pending, p.dnc_flagged, (r.dnc_dismissed_triage_id is not null) as dnc_ever_dismissed
    from campaign_enrollments e
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    join call_plans p on p.enrollment_id = e.id and p.status = 'approved'
    join call_research cr on cr.id = p.research_id
    where e.org_id = ${ctx.orgId}::uuid and e.campaign_id = ${campaignId}::uuid and e.status = 'active' and e.call_stage = 'approved'
    order by e.enrolled_at, e.id
    limit ${RELEASE_MAX}`);
  const rows = (result as unknown as { rows: Releasable[] }).rows;
  const blocks = await blockedTargets(db, ctx.orgId, [...new Set(rows.flatMap((r) => r.phones.map((p) => p.e164)))]);
  let released = 0;
  let skipped = 0;
  for (const r of rows) {
    const consent = r.consent && CONSENTS.includes(r.consent) ? (r.consent as AiConsentStatus) : null;
    const warnings = gateWarnings({
      consent,
      record: { phones: r.phones, sfDoNotCall: r.sf_do_not_call, skipOnDialer: r.skip_on_dialer, isClosed: r.is_closed, state: r.state },
      blocks,
      now,
      dnc: { pending: r.dnc_pending, flaggedNotDismissed: r.dnc_flagged && !r.dnc_ever_dismissed },
    });
    // Only an explicit yes goes out: a null consent has no warning of its own, but it is not consent either.
    if (consent !== 'yes' || hasBlockingWarning(warnings) || !(await releaseOne(db, r, now))) skipped += 1;
    else released += 1;
  }
  return { released, skipped };
}

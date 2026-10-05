/**
 * The plan board: one card per active enrollment of an AI call campaign.
 *
 * The research on a card is the research behind the CURRENT plan (`call_plans.research_id`),
 * never "the newest research" (CF-6), so a card, the consent it shows and what Approve checks
 * always agree. A card with no current plan has no research.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AiConsentStatus,
  CallStage,
  EditableCallPlan,
  ResearchSourceSummary,
  type CallPlanCard,
  type CallPlansResponse,
  type EnrollmentStatus,
} from '@cti/contracts';
import type { Db } from '@cti/db';
import { blockedTargets } from '@cti/firewall';
import { loadConnection } from '../crm/connection-store.js';
import { mayDecideWith, ownSfUserId } from '../tenancy/record-owner.js';
import type { RequestContext } from '../tenancy/scope.js';
import { DNC_EVER_DISMISSED_SQL, DNC_PENDING_SQL } from './dnc-sql.js';
import { gateWarnings } from './warnings.js';

export const CARD_PAGE_SIZE = 25;

const Phones = z.array(z.object({ field: z.string(), e164: z.string() })).catch([]);

interface CardRow {
  enrollment_id: string;
  /** ISO with microseconds, so a page boundary never repeats or skips a row that shares a millisecond. */
  enrolled_cursor: string;
  status: EnrollmentStatus;
  call_stage: CallStage;
  call_prepare_error: string | null;
  sf_object: 'Lead' | 'Opportunity';
  sf_record_id: string;
  name: string | null;
  owner_name: string | null;
  owner_sf_user_id: string | null;
  phones: unknown;
  sf_do_not_call: boolean;
  skip_on_dialer: boolean;
  is_closed: boolean;
  state: string | null;
  dnc_pending: boolean;
  dnc_ever_dismissed: boolean;
  research_version: number | null;
  research_at: Date | string | null;
  research_sources: unknown;
  consent: string | null;
  plan_version: number | null;
  plan_status: 'proposed' | 'approved' | null;
  plan_source: 'model' | 'edit' | null;
  plan: unknown;
  plan_created_at: Date | string | null;
  plan_decided_at: Date | string | null;
  plan_dismisser: string | null;
  plan_dismissed_at: Date | string | null;
  dnc_flagged: boolean | null;
}

/** `at` is an ISO timestamp (microseconds allowed). */
export const encodeCardCursor = (at: string, id: string): string => Buffer.from(`${at}|${id}`).toString('base64url');

/** Raw SQL rows give timestamps as strings; the query builder gives Dates. */
const iso = (v: Date | string | null): string | null => (v === null ? null : new Date(v).toISOString());
export function decodeCardCursor(cursor: string | null): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return at && id && !Number.isNaN(Date.parse(at)) && z.string().uuid().safeParse(id).success ? { at, id } : null;
}

const CARD_SELECT = sql`
  select e.id as enrollment_id, to_char(e.enrolled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as enrolled_cursor, e.status, e.call_stage, e.call_prepare_error,
         r.sf_object, r.sf_record_id, r.name, r.owner_name, r.owner_sf_user_id, r.phones, r.sf_do_not_call, r.skip_on_dialer, r.is_closed, r.state,
         ${DNC_PENDING_SQL} as dnc_pending, ${DNC_EVER_DISMISSED_SQL} as dnc_ever_dismissed,
         cr.version as research_version, cr.created_at as research_at, cr.sources as research_sources, cr.snapshot ->> 'consent' as consent,
         p.version as plan_version, p.status as plan_status, p.source as plan_source, p.plan, p.created_at as plan_created_at, p.decided_at as plan_decided_at,
         coalesce(du.display_name, du.email) as plan_dismisser, p.dnc_dismissed_at as plan_dismissed_at, p.dnc_flagged
  from campaign_enrollments e
  join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
  left join call_plans p on p.enrollment_id = e.id and p.status in ('proposed', 'approved')
  left join call_research cr on cr.id = p.research_id
  left join users du on du.id = p.dnc_dismissed_by`;

type Blocks = Awaited<ReturnType<typeof blockedTargets>>;

function dismissal(row: CardRow): { dismissed: boolean; by: string | null; at: string | null } {
  const dismissed = row.dnc_flagged === true && row.dnc_ever_dismissed && !row.dnc_pending;
  // The dismisser lives on the plan itself (resetCallStageAfterDismiss), beside the approval, whatever the plan's status.
  return { dismissed, by: dismissed ? row.plan_dismisser : null, at: dismissed ? iso(row.plan_dismissed_at) : null };
}

function toCard(row: CardRow, ctx: RequestContext, mine: string | null, instanceUrl: string | null, blocks: Blocks, now: Date): CallPlanCard {
  const parsedPlan = row.plan_version !== null ? EditableCallPlan.safeParse(row.plan) : null;
  const parsedConsent = AiConsentStatus.safeParse(row.consent);
  const consent = parsedConsent.success ? parsedConsent.data : null;
  const d = dismissal(row);
  return {
    enrollmentId: row.enrollment_id,
    sfObject: row.sf_object,
    sfRecordId: row.sf_record_id,
    recordUrl: instanceUrl ? `${instanceUrl.replace(/\/$/, '')}/${row.sf_record_id}` : null,
    name: row.name,
    ownerName: row.owner_name,
    enrollmentStatus: row.status,
    callStage: row.call_stage,
    consent,
    warnings: gateWarnings({
      consent,
      record: { phones: Phones.parse(row.phones), sfDoNotCall: row.sf_do_not_call, skipOnDialer: row.skip_on_dialer, isClosed: row.is_closed, state: row.state },
      blocks,
      now,
      dnc: { pending: row.dnc_pending || row.status === 'needs_review', flaggedNotDismissed: row.dnc_flagged === true && !row.dnc_ever_dismissed },
    }),
    research:
      row.research_version !== null
        ? { version: row.research_version, collectedAt: iso(row.research_at)!, sources: z.array(ResearchSourceSummary).catch([]).parse(row.research_sources) }
        : null,
    plan: parsedPlan?.success
      ? {
          version: row.plan_version!,
          status: row.plan_status!,
          source: row.plan_source!,
          plan: parsedPlan.data,
          createdAt: iso(row.plan_created_at)!,
          decidedAt: row.plan_status === 'approved' ? iso(row.plan_decided_at) : null,
          dncFlagDismissed: d.dismissed,
          dncFlagDismissedBy: d.by,
          dncFlagDismissedAt: d.at,
        }
      : null,
    prepareError: row.call_prepare_error ?? (parsedPlan && !parsedPlan.success ? 'The stored plan could not be read; use Research again.' : null),
    mayDecide: mayDecideWith(ctx, mine, row.owner_sf_user_id),
  };
}

async function cardsFrom(db: Db, ctx: RequestContext, rows: CardRow[], now: Date): Promise<CallPlanCard[]> {
  const numbers = [...new Set(rows.flatMap((r) => Phones.parse(r.phones).map((p) => p.e164)))];
  const [mine, conn, blocks] = await Promise.all([ownSfUserId(db, ctx.session.userId), loadConnection(db, ctx.orgId), blockedTargets(db, ctx.orgId, numbers)]);
  return rows.map((r) => toCard(r, ctx, mine, conn?.instanceUrl ?? null, blocks, now));
}

const rowsOf = (result: unknown): CardRow[] => (result as { rows: CardRow[] }).rows;

export async function loadCallPlanCards(
  db: Db,
  ctx: RequestContext,
  campaignId: string,
  opts: { cursor: string | null; stage: CallStage | null; now: Date },
): Promise<CallPlansResponse> {
  const after = decodeCardCursor(opts.cursor);
  const rows = rowsOf(
    await db.execute(sql`${CARD_SELECT}
      where e.org_id = ${ctx.orgId}::uuid and e.campaign_id = ${campaignId}::uuid and e.status = 'active' and e.call_stage is not null
        ${opts.stage ? sql`and e.call_stage = ${opts.stage}` : sql``}
        ${after ? sql`and (e.enrolled_at, e.id) > (${after.at}::timestamptz, ${after.id}::uuid)` : sql``}
      order by e.enrolled_at, e.id
      limit ${CARD_PAGE_SIZE + 1}`),
  );
  const page = rows.slice(0, CARD_PAGE_SIZE);
  const countRows = (await db.execute(sql`
    select call_stage, count(*)::int as n from campaign_enrollments
    where org_id = ${ctx.orgId}::uuid and campaign_id = ${campaignId}::uuid and status = 'active' and call_stage is not null
    group by call_stage`)) as unknown as { rows: Array<{ call_stage: CallStage; n: number }> };
  const counts = Object.fromEntries(CallStage.options.map((s) => [s, countRows.rows.find((c) => c.call_stage === s)?.n ?? 0])) as CallPlansResponse['counts'];
  const last = page.at(-1);
  return {
    cards: await cardsFrom(db, ctx, page, opts.now),
    nextCursor: rows.length > CARD_PAGE_SIZE && last ? encodeCardCursor(last.enrolled_cursor, last.enrollment_id) : null,
    counts,
  };
}

/** One card (any enrollment status), for the routes' responses. Null when not in this tenant. */
export async function loadCallPlanCard(db: Db, ctx: RequestContext, enrollmentId: string, now: Date): Promise<CallPlanCard | null> {
  const rows = rowsOf(await db.execute(sql`${CARD_SELECT} where e.org_id = ${ctx.orgId}::uuid and e.id = ${enrollmentId}::uuid and e.call_stage is not null`));
  return rows.length ? (await cardsFrom(db, ctx, rows, now))[0]! : null;
}

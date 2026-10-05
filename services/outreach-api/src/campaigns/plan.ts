import { and, asc, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { GateStep, TouchChannel, TouchStatus, TriageResult, type CampaignPlanResponse, type EnrollmentStatus, type PlanRow } from '@cti/contracts';
import { schema, type Db } from '@cti/db';

export const PLAN_PAGE_SIZE = 50;
/** A touch in one of these is the enrollment's next touch; otherwise its latest touch is shown. */
const OPEN_TOUCH_STATUSES = ['planned', 'held', 'queued', 'dialing'] as const;

export interface PlanPageArgs {
  orgId: string;
  campaignId: string;
  status?: EnrollmentStatus;
  /** The last enrollment id of the previous page (keyset on enrollment id). */
  cursor?: string;
  limit: number;
}

export function planPageWhere(a: Omit<PlanPageArgs, 'limit'>): SQL {
  const e = schema.campaignEnrollments;
  return and(
    eq(e.orgId, a.orgId),
    eq(e.campaignId, a.campaignId),
    a.status ? eq(e.status, a.status) : undefined,
    a.cursor ? gt(e.id, a.cursor) : undefined,
  )!;
}

/**
 * One page of a campaign's plan: enrollment → its crm_record (same tenant) →
 * the record's latest triage → the enrollment's open touch, else its latest.
 * Both lookups are correlated subqueries pinned to the outer row's org_id.
 */
export function planPageQuery(db: Db, a: PlanPageArgs) {
  const e = schema.campaignEnrollments;
  const r = schema.crmRecords;
  const rt = schema.recordTriage;
  const t = schema.touches;
  const latestTriage = sql<unknown>`(select ${rt.result} from ${rt} where ${rt.crmRecordId} = ${r.id} and ${rt.orgId} = ${r.orgId} order by ${rt.createdAt} desc limit 1)`;
  const nextTouch = sql<unknown>`(select json_build_object('seq', ${t.seq}, 'channel', ${t.channel}, 'status', ${t.status}, 'dueAt', ${t.dueAt}, 'gateAudit', ${t.gateAudit}) from ${t} where ${t.enrollmentId} = ${e.id} and ${t.orgId} = ${e.orgId} order by (${inArray(t.status, [...OPEN_TOUCH_STATUSES])}) desc, ${t.seq} desc limit 1)`;
  return db
    .select({
      enrollmentId: e.id,
      status: e.status,
      exitReason: e.exitReason,
      sfRecordId: r.sfRecordId,
      name: r.name,
      ownerName: r.ownerName,
      triage: latestTriage,
      nextTouch,
    })
    .from(e)
    .innerJoin(r, and(eq(r.id, e.crmRecordId), eq(r.orgId, e.orgId)))
    .where(planPageWhere(a))
    .orderBy(asc(e.id))
    .limit(a.limit);
}

export function planCountsQuery(db: Db, a: { orgId: string; campaignId: string }) {
  const e = schema.campaignEnrollments;
  return db
    .select({ status: e.status, count: sql<number>`count(*)`.mapWith(Number) })
    .from(e)
    .where(and(eq(e.orgId, a.orgId), eq(e.campaignId, a.campaignId)))
    .groupBy(e.status);
}

/** The do-not-contact quote is never shown on the plan; it lives on the Needs Review list. */
const PlanTriage = TriageResult.omit({ doNotContact: true });
const TouchJson = z.object({ seq: z.number(), channel: TouchChannel, status: TouchStatus, dueAt: z.string(), gateAudit: z.unknown() });

export type PlanQueryRow = {
  enrollmentId: string;
  status: EnrollmentStatus;
  exitReason: string | null;
  sfRecordId: string;
  name: string | null;
  ownerName: string | null;
  triage: unknown;
  nextTouch: unknown;
};

function toNextTouch(raw: unknown): PlanRow['nextTouch'] {
  const touch = TouchJson.safeParse(raw);
  if (!touch.success) return null;
  const audit = GateStep.array().safeParse(touch.data.gateAudit);
  const due = new Date(touch.data.dueAt);
  return {
    seq: touch.data.seq,
    channel: touch.data.channel,
    status: touch.data.status,
    dueAt: Number.isNaN(due.getTime()) ? touch.data.dueAt : due.toISOString(),
    gateAudit: audit.success ? audit.data : [],
  };
}

/** Pure: a query row → the PlanRow contract (unparseable triage/touch JSON shows as none, never as a 500). */
export function toPlanRow(row: PlanQueryRow): PlanRow {
  const triage = PlanTriage.safeParse(row.triage);
  return {
    enrollmentId: row.enrollmentId,
    sfRecordId: row.sfRecordId,
    name: row.name,
    ownerName: row.ownerName,
    status: row.status,
    exitReason: row.exitReason,
    triage: triage.success ? triage.data : null,
    nextTouch: toNextTouch(row.nextTouch),
  };
}

export async function loadPlan(db: Db, a: Omit<PlanPageArgs, 'limit'>): Promise<CampaignPlanResponse> {
  const rows: PlanQueryRow[] = await planPageQuery(db, { ...a, limit: PLAN_PAGE_SIZE + 1 });
  const page = rows.slice(0, PLAN_PAGE_SIZE);
  const counts = await planCountsQuery(db, { orgId: a.orgId, campaignId: a.campaignId });
  return {
    rows: page.map(toPlanRow),
    nextCursor: rows.length > PLAN_PAGE_SIZE ? page[page.length - 1]!.enrollmentId : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.count])),
  };
}

/** Row builders for the call plan board and decision tests (real Postgres): an AI call lead with research and a plan. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ResearchSource, type CallStage } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { assembleSnapshot } from '../research/snapshot.js';
import { saveResearch, savePlan } from '../call-plans/store.js';
import { validPlan } from './call-plan-fixtures.js';
import type { RequestContext } from '../tenancy/scope.js';
import { leadId, seedCampaign, seedEnrollment, seedOrg, seedRecord, snapshot } from './outreach-fixtures.js';

/** A request context for a signed-in person (no HTTP involved). */
export const ctxOf = (orgId: string, userId: string, isAdmin: boolean): RequestContext =>
  ({ session: { userId, orgId, isAdmin, isSuperAdmin: false, email: 'x@gg.co', kind: 'human' }, orgId, tenant: {} }) as unknown as RequestContext;

export const SEED_NOW = new Date('2026-10-05T19:00:00.000Z');

let counter = 0;

export async function seedUser(db: Db, orgId: string, over: { sfUserId?: string; displayName?: string } = {}): Promise<string> {
  const [user] = await db
    .insert(schema.users)
    .values({ orgId, email: `u-${randomUUID().slice(0, 8)}@gg.co`, displayName: over.displayName ?? null })
    .returning({ id: schema.users.id });
  if (over.sfUserId) {
    await db.insert(schema.salesforceConnections).values({ userId: user!.id, sfUserId: over.sfUserId, sfOrgId: '00D000000000001', instanceUrl: 'https://x.my.salesforce.com', accessTokenEnc: 'enc' });
  }
  return user!.id;
}

export async function seedAiCallCampaign(db: Db, status: 'dry_run' | 'active' | 'paused' = 'active'): Promise<{ orgId: string; campaignId: string }> {
  const orgId = await seedOrg(db);
  const campaign = await seedCampaign(db, orgId, { mode: 'ai_call', status });
  return { orgId, campaignId: campaign.id };
}

export interface PlanLeadOptions {
  consent?: 'yes' | 'no' | 'field_missing' | 'unknown' | null;
  callStage?: CallStage;
  status?: 'active' | 'needs_review' | 'exited';
  /** null: research only, no plan yet. */
  planStatus?: 'proposed' | 'approved' | null;
  dncFlagged?: boolean;
  ownerSfUserId?: string | null;
  phones?: Array<{ field: string; e164: string }>;
  recordOver?: Partial<typeof schema.crmRecords.$inferInsert>;
  enrolledAt?: Date;
  approvedBy?: string;
}

export interface PlanLead {
  orgId: string;
  campaignId: string;
  enrollmentId: string;
  crmRecordId: string;
  sfRecordId: string;
  researchId: string | null;
  planId: string | null;
}

/** An enrollment (active, `review` by default) with research v1 and plan v1 (proposed unless said otherwise). */
export async function seedPlanLead(db: Db, base: { orgId: string; campaignId: string }, o: PlanLeadOptions = {}): Promise<PlanLead> {
  counter += 1;
  const sfRecordId = leadId(900_000 + counter);
  const crmRecordId = await seedRecord(
    db,
    base.orgId,
    snapshot({ sfRecordId, ownerSfUserId: o.ownerSfUserId === undefined ? '005000000000001AAA' : o.ownerSfUserId, ...(o.phones ? { phones: o.phones } : {}) }),
    o.recordOver,
  );
  const enrollmentId = await seedEnrollment(db, base.orgId, base.campaignId, crmRecordId, {
    status: o.status ?? 'active',
    callStage: o.callStage ?? 'review',
    ...(o.enrolledAt ? { enrolledAt: o.enrolledAt } : {}),
  });
  const planStatus = o.planStatus === undefined ? 'proposed' : o.planStatus;
  const consent = o.consent === undefined ? 'yes' : o.consent;
  if (planStatus === null && o.callStage === 'research') return { ...base, enrollmentId, crmRecordId, sfRecordId, researchId: null, planId: null };
  const research = await saveResearch(db, {
    orgId: base.orgId,
    enrollmentId,
    crmRecordId,
    snapshot: assembleSnapshot({
      sfObject: 'Lead',
      sfRecordId,
      collectedAt: SEED_NOW,
      consent: consent ?? 'yes',
      records: [{ relation: 'self', sfObject: 'Lead', id: sfRecordId, role: null, fields: [{ name: 'Name', label: 'Name', value: 'Pat Seller' }] }],
      activity: [],
      sources: ResearchSource.options.map((source) => ({ source, status: 'ok' as const, count: 1, truncated: false, note: null })),
    }),
  });
  // consent: null is a snapshot with no consent value at all.
  if (consent === null) await db.execute(sql`update call_research set snapshot = snapshot - 'consent' where id = ${research.id}::uuid`);
  if (planStatus === null) return { ...base, enrollmentId, crmRecordId, sfRecordId, researchId: research.id, planId: null };
  const plan = await savePlan(db, {
    orgId: base.orgId,
    enrollmentId,
    researchId: research.id,
    source: 'model',
    model: 'claude-sonnet-5-5',
    plan: validPlan,
    dncFlagged: o.dncFlagged ?? false,
    inputTokens: 1,
    outputTokens: 1,
    createdBy: null,
  });
  if (planStatus === 'approved') {
    await db.execute(sqlApprove(plan.id, o.approvedBy ?? null));
  }
  return { ...base, enrollmentId, crmRecordId, sfRecordId, researchId: research.id, planId: plan.id };
}

const sqlApprove = (planId: string, by: string | null) =>
  sql`update call_plans set status = 'approved', decided_by = ${by}::uuid, decided_at = now() where id = ${planId}::uuid`;

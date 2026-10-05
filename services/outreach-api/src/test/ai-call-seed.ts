/** Row builders for the AI call pacer and results tests (real Postgres): a released lead with its planned touch, and ai_calls rows. */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { InternalAiCallResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { seedPlanLead, seedUser, type PlanLead, type PlanLeadOptions } from './call-plan-seed.js';

let seq = 0;
/** An 18-character Lead Id whose 15-character core is unique in the test run (seedPlanLead's ids share theirs). */
export function uniqueLeadId(): string {
  seq += 1;
  return `00Q${String(seq).padStart(12, '0')}AAA`;
}

export interface ReleasedLead extends PlanLead {
  touchId: string;
  approver: string;
}

/** Ticks the lead in the campaign's lead picker. */
export async function selectLead(db: Db, lead: { orgId: string; campaignId: string; sfRecordId: string }): Promise<void> {
  await db.execute(sql`
    insert into campaign_selections (org_id, campaign_id, sf_record_id)
    values (${lead.orgId}::uuid, ${lead.campaignId}::uuid, ${lead.sfRecordId}) on conflict do nothing`);
}

/** An approved, selected lead at `queued` with one planned ai_call touch (what "Call all approved" leaves), due at `dueAt`. */
export async function seedReleasedLead(
  db: Db,
  base: { orgId: string; campaignId: string },
  o: PlanLeadOptions & { approver?: string; dueAt?: Date; touch?: Partial<typeof schema.touches.$inferInsert> } = {},
): Promise<ReleasedLead> {
  const approver = o.approver ?? (await seedUser(db, base.orgId));
  const sfRecordId = uniqueLeadId();
  const planLead = await seedPlanLead(db, base, { callStage: 'queued', planStatus: 'approved', approvedBy: approver, ...o, recordOver: { sfRecordId, ...o.recordOver } });
  const lead = { ...planLead, sfRecordId };
  await selectLead(db, lead);
  const [touch] = await db
    .insert(schema.touches)
    .values({
      orgId: base.orgId,
      enrollmentId: lead.enrollmentId,
      seq: 1,
      channel: 'ai_call',
      status: 'planned',
      dueAt: o.dueAt ?? new Date('2026-10-01T00:00:00.000Z'),
      callPlanId: lead.planId,
      requestedBy: approver,
      ...o.touch,
    })
    .returning({ id: schema.touches.id });
  return { ...lead, touchId: touch!.id, approver };
}

/** An ai_calls row as cti-api would write it (outreach-api only reads this table; the test owns the database). */
export async function seedAiCall(
  db: Db,
  orgId: string,
  startedBy: string,
  over: Partial<typeof schema.aiCalls.$inferInsert> = {},
): Promise<string> {
  const [row] = await db
    .insert(schema.aiCalls)
    .values({ id: randomUUID(), orgId, startedBy, toE164: '+15125550100', status: 'queued', ...over })
    .returning({ id: schema.aiCalls.id });
  return row!.id;
}

/**
 * An ai_call_requests row as cti-api's request store writes it (request-store.ts): reserved before anything is dialed,
 * `response` null while the request is in flight, then the stored answer.
 */
export async function seedAiCallRequest(
  db: Db,
  a: { orgId: string; key: string; userId: string; response?: InternalAiCallResponse | null; createdAt?: Date; updatedAt?: Date; hash?: string },
): Promise<void> {
  const response = a.response ?? null;
  await db.insert(schema.aiCallRequests).values({
    orgId: a.orgId,
    idempotencyKey: a.key,
    requestHash: a.hash ?? 'a-different-body',
    userId: a.userId,
    aiCallId: response?.aiCallId ?? null,
    response,
    ...(a.createdAt ? { createdAt: a.createdAt } : {}),
    ...(a.updatedAt ?? a.createdAt ? { updatedAt: a.updatedAt ?? a.createdAt } : {}),
  });
}

export async function touchById(db: Db, id: string) {
  const [row] = await db.select().from(schema.touches).where(eq(schema.touches.id, id));
  return row!;
}

export async function enrollmentById(db: Db, id: string) {
  const [row] = await db.select().from(schema.campaignEnrollments).where(eq(schema.campaignEnrollments.id, id));
  return row!;
}

export async function planById(db: Db, id: string) {
  const [row] = await db.select().from(schema.callPlans).where(eq(schema.callPlans.id, id));
  return row!;
}

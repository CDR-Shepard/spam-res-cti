/**
 * Practice AI calls (plan 1D decision 6, Task 28): an admin picks a lead on the plan board and the voice agent rings the
 * admin's own test number as if it were that seller, with the real record (cti-api loads it) and the lead's current plan
 * (proposed or approved), rendered and checked exactly as for a real call (CF-9), and the appointment owner's real free times.
 *
 * What a practice call never does: it claims no touch, so `ai_call.results` never counts it and never enqueues a write-back;
 * the write-back tick also refuses any `is_test` call before a single Salesforce request; a booking only lands on
 * `ai_calls.appointment` ("would have booked"); it never approves the plan. The only Salesforce traffic is read-only: the
 * record load in cti-api and the owner's User and Event reads for the offer here. cti-api gates it on its test branch
 * (an admin, a number on AI_VOICE_TEST_NUMBERS); this module checks the number first so a typo is told in words.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  AiCallOutcome,
  AiCallStatus,
  BookedAppointment,
  EditableCallPlan,
  InternalAiCallResponse,
  type AppointmentSlot,
  type PracticeCall,
  type PracticeCallRequest,
  type PracticeCallsResponse,
} from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { toE164 } from '@cti/phone';
import { offerWithAiBookings } from '../appointments/booked.js';
import { readOfferCalendar } from '../appointments/offer.js';
import { describePlanTextIssues } from '../call-plans/plan-text-words.js';
import type { SalesforceClientFactory } from '../crm/client-factory.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { bookingSettings } from '../settings.js';
import type { RequestContext } from '../tenancy/scope.js';
import type { CtiClient } from './cti-client.js';
import { renderPlanForAgent } from './plan-text.js';
import { lockAndCheckPractice } from './practice-guard.js';

export type PracticeError = 'not_found' | 'not_ai_call_campaign' | 'no_plan' | 'plan_text_rejected' | 'not_a_test_number' | 'cti_unreachable' | 'practice_in_progress';
export type PracticeResult = { ok: true; response: InternalAiCallResponse } | { ok: false; error: PracticeError; words?: string[] };

export interface PracticeDeps {
  db: Db;
  clients: SalesforceClientFactory;
  cti: CtiClient;
  now: Date;
  log: RunnerLogger;
  /** AI_CALL_DEFAULT_SPECIALISTS: the appointment owner list of a tenant that has saved none (bookingSettings needs it). */
  defaultSpecialists: readonly string[];
}

/** The campaign's practice list is the latest this many. */
export const PRACTICE_LIST_LIMIT = 20;

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;

interface Lead {
  campaignId: string;
  mode: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
  settings: unknown;
}

async function loadLead(db: Db, orgId: string, enrollmentId: string): Promise<Lead | null> {
  const e = schema.campaignEnrollments;
  const c = schema.campaigns;
  const r = schema.crmRecords;
  const o = schema.organizations;
  const [row] = await db
    .select({ campaignId: c.id, mode: c.mode, sfObject: r.sfObject, sfRecordId: r.sfRecordId, settings: o.settings })
    .from(e)
    .innerJoin(c, and(eq(c.id, e.campaignId), eq(c.orgId, e.orgId)))
    .innerJoin(r, and(eq(r.id, e.crmRecordId), eq(r.orgId, e.orgId)))
    .innerJoin(o, eq(o.id, e.orgId))
    .where(and(eq(e.id, enrollmentId), eq(e.orgId, orgId)));
  return (row as Lead | undefined) ?? null;
}

/** The plan at `version`, only while it is the lead's current plan (proposed or approved) and still parses. */
async function loadPlan(db: Db, orgId: string, enrollmentId: string, version: number): Promise<{ id: string; plan: EditableCallPlan } | null> {
  const p = schema.callPlans;
  const [row] = await db
    .select({ id: p.id, plan: p.plan })
    .from(p)
    .where(and(eq(p.orgId, orgId), eq(p.enrollmentId, enrollmentId), eq(p.version, version), inArray(p.status, ['proposed', 'approved'])));
  const parsed = row ? EditableCallPlan.safeParse(row.plan) : null;
  return row && parsed?.success ? { id: row.id, plan: parsed.data } : null;
}

/**
 * The owner's free times, read now, less what other AI calls already booked with them (as the pacer offers them), so the
 * admin hears what a seller would be offered. Never throws: any failure offers nothing and the call still goes.
 */
async function practiceSlots(deps: PracticeDeps, orgId: string, settings: unknown): Promise<AppointmentSlot[]> {
  try {
    const booking = bookingSettings({ settings }, deps.defaultSpecialists);
    const cal = await readOfferCalendar(await deps.clients(orgId), { booking, now: deps.now, log: deps.log });
    const offer = await offerWithAiBookings(deps.db, cal, { orgId, booking, now: deps.now });
    if (offer.note && offer.note !== 'booking_off') deps.log.info({ orgId, slots: offer.note }, 'ai_call.practice: no appointment times offered');
    return offer.slots;
  } catch (err) {
    deps.log.warn({ orgId, errName: err instanceof Error ? err.name : typeof err }, 'ai_call.practice: no appointment times offered');
    return [];
  }
}

/** `to`, E.164-normalised, when it is one of cti-api's test numbers; null when it is not; 'unreachable' when cti-api did not answer. */
async function testNumber(cti: CtiClient, to: string): Promise<string | null | 'unreachable'> {
  const availability = await cti.availability();
  if (!availability) return 'unreachable';
  const wanted = toE164(to);
  if (!wanted) return null;
  return availability.testNumbers.some((n) => (toE164(n) ?? n) === wanted) ? wanted : null;
}

export async function startPractice(deps: PracticeDeps, ctx: RequestContext, enrollmentId: string, body: PracticeCallRequest): Promise<PracticeResult> {
  const { db } = deps;
  const lead = await loadLead(db, ctx.orgId, enrollmentId);
  if (!lead) return { ok: false, error: 'not_found' };
  if (lead.mode !== 'ai_call') return { ok: false, error: 'not_ai_call_campaign' };
  const plan = await loadPlan(db, ctx.orgId, enrollmentId, body.version);
  if (!plan) return { ok: false, error: 'no_plan' };
  const rendered = renderPlanForAgent(plan.plan, deps.now);
  if (!rendered.ok) return { ok: false, error: 'plan_text_rejected', words: describePlanTextIssues(plan.plan, rendered.issues) };
  const to = await testNumber(deps.cti, body.to);
  if (to === 'unreachable') return { ok: false, error: 'cti_unreachable' };
  if (to === null) return { ok: false, error: 'not_a_test_number' };

  const context = { returning: plan.plan.reengagement?.lastContact != null };
  const slots = await practiceSlots(deps, ctx.orgId, lead.settings);
  const idempotencyKey = `practice:${randomUUID()}`;
  const row = await db.transaction(async (tx) => {
    if (await lockAndCheckPractice(tx, ctx.orgId, ctx.session.userId, deps.now)) return null;
    const [inserted] = await tx
      .insert(schema.aiPracticeCalls)
      .values({
        orgId: ctx.orgId,
        campaignId: lead.campaignId,
        enrollmentId,
        callPlanId: plan.id,
        planVersion: body.version,
        requestedBy: ctx.session.userId,
        toE164: to,
        idempotencyKey,
        createdAt: deps.now,
      })
      .returning({ id: schema.aiPracticeCalls.id });
    return inserted ?? null;
  });
  if (row === null) return { ok: false, error: 'practice_in_progress' };
  const answer = await deps.cti.trigger({
    orgId: ctx.orgId,
    userId: ctx.session.userId,
    idempotencyKey,
    target: { kind: 'practice', objectType: lead.sfObject, recordId: lead.sfRecordId, to, planText: rendered.text, context, ...(slots.length ? { slots } : {}) },
  });
  // A practice key is never re-sent, so a 409 is as final as a transport failure: the row keeps a null result.
  if (answer.kind !== 'response') {
    deps.log.warn({ orgId: ctx.orgId, practiceId: row.id, transport: answer.kind === 'transport' ? answer.error : 'conflict' }, 'ai_call.practice: cti-api did not answer');
    return { ok: false, error: 'cti_unreachable' };
  }
  await db
    .update(schema.aiPracticeCalls)
    .set({ result: answer.response, aiCallId: answer.response.aiCallId ?? null })
    .where(eq(schema.aiPracticeCalls.id, row.id));
  deps.log.info({ orgId: ctx.orgId, practiceId: row.id, result: answer.response.result }, 'ai_call.practice: trigger answered');
  return { ok: true, response: answer.response };
}

interface PracticeRow {
  id: string;
  enrollment_id: string;
  name: string | null;
  sf_object: PracticeCall['sfObject'];
  sf_record_id: string;
  plan_version: number;
  ai_call_id: string | null;
  call_status: string | null;
  outcome: string | null;
  summary: string | null;
  appointment: unknown;
  result: unknown;
  created_at: Date | string;
}

/** D-6: each row's JSON is read on its own; one drifted row reads as null and never breaks the list. */
const parsedOrNull = <T>(schemaOf: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T | null => {
  const parsed = schemaOf.safeParse(v);
  return parsed.success ? parsed.data : null;
};

function toPracticeCall(r: PracticeRow): PracticeCall {
  return {
    id: r.id,
    enrollmentId: r.enrollment_id,
    name: r.name,
    sfObject: r.sf_object,
    sfRecordId: r.sf_record_id,
    planVersion: r.plan_version,
    aiCallId: r.ai_call_id,
    callStatus: parsedOrNull(AiCallStatus, r.call_status),
    outcome: parsedOrNull(AiCallOutcome, r.outcome),
    summary: r.summary,
    appointment: parsedOrNull(BookedAppointment, r.appointment),
    result: parsedOrNull(InternalAiCallResponse, r.result),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/**
 * The campaign's latest practice calls, newest first. The caller checked the campaign is this tenant's. A row whose
 * cti-api answer was lost (a timeout after it placed the call) finds its call and answer by its practice key in
 * ai_call_requests, where cti-api stores every answer (P6 M-10), so the list never says "No answer" for a phone that rang.
 */
export async function listPracticeCalls(db: Db, orgId: string, campaignId: string): Promise<PracticeCallsResponse> {
  const result = await db.execute(sql`
    select p.id, p.enrollment_id, r.name, r.sf_object, r.sf_record_id, p.plan_version, coalesce(p.ai_call_id, q.ai_call_id) as ai_call_id,
           a.status as call_status, a.outcome, a.summary, a.appointment, coalesce(p.result, q.response) as result, p.created_at
    from ai_practice_calls p
    join campaign_enrollments e on e.id = p.enrollment_id and e.org_id = p.org_id
    join crm_records r on r.id = e.crm_record_id and r.org_id = e.org_id
    left join ai_call_requests q on p.ai_call_id is null and q.org_id = p.org_id and q.idempotency_key = p.idempotency_key
    left join ai_calls a on a.id = coalesce(p.ai_call_id, q.ai_call_id) and a.org_id = p.org_id
    where p.org_id = ${orgId}::uuid and p.campaign_id = ${campaignId}::uuid
    order by p.created_at desc, p.id desc
    limit ${PRACTICE_LIST_LIMIT}`);
  return { items: rows<PracticeRow>(result).map(toPracticeCall) };
}

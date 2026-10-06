/**
 * What the `ai_call.place` tick reads for one tenant before it places anything: how many calls
 * it may start (concurrency and the rolling daily cap), the due touches, their plans, ONE fresh
 * Salesforce read per object (which also refreshes the integration token cti-api reads,
 * decision 3), and the CF-1 activity check. A tenant whose Salesforce is unusable is skipped
 * with nothing claimed. Plan 1D: the tick keeps the tenant's booking settings and Salesforce client, so a touch can be offered
 * the appointment owner's free times (tickOffer). Fix 1: the owner's calendar is read at most once per tenant per tick (M-1);
 * the times other AI calls booked that are not on it yet are read per touch (I-4).
 */
import { eq, inArray } from 'drizzle-orm';
import { EditableCallPlan, FieldMap, type AiCallBookingSettings } from '@cti/contracts';
import { schema } from '@cti/db';
import { QueryTooLargeError, SalesforceApiError, SalesforceAuthError, type SalesforceClient } from '@cti/salesforce';
import { offerWithAiBookings } from '../appointments/booked.js';
import type { OwnerUser } from '../appointments/calendar.js';
import { readOfferCalendar, type Offer, type OfferCalendar } from '../appointments/offer.js';
import { fetchRecords, type SfRecordSnapshot } from '../campaigns/records.js';
import { CrmNotConnectedError } from '../crm/client-factory.js';
import { loadConnection } from '../crm/connection-store.js';
import { liveCallBooking, outreachSettings } from '../settings.js';
import { writebackActivityIds } from '../writeback/store.js';
import { engineTaskIds, recordsWithNewActivity, type ActivityProbe } from './activity-check.js';
import type { PaceDeps } from './pace.js';
import { deferTouch, dueAiCallTouches, liveAiCallCount, placedInLastDay, PLACE_CANDIDATES_PER_ORG, type AiTouchCandidate } from './touches.js';

/** The activity check could not run: the tenant's due touches wait this long (nobody is called unchecked). */
export const ACTIVITY_CHECK_RETRY_MS = 30 * 60_000;

export interface PlanForCall {
  id: string;
  enrollmentId: string;
  status: string;
  /** null when the stored plan no longer parses: treated as not approved. */
  plan: EditableCallPlan | null;
  /** When the plan's research read Salesforce (the earlier of its snapshot's collectedAt and the row's created_at). */
  researchedAt: Date;
}

export interface OrgTick {
  /** New calls this tick may start: min(concurrency − live, daily cap − placed in 24 h). */
  slots: number;
  candidates: AiTouchCandidate[];
  plans: Map<string, PlanForCall>;
  fresh(sfRecordId: string): SfRecordSnapshot | undefined;
  /** Candidate record ids with a Task or Event newer than their plan's research (CF-1). */
  newActivity: Set<string>;
  /** Plan 1D: the tenant's integration connection, for the appointment offer's reads. */
  client: SalesforceClient;
  /** Plan 1D: the tenant's booking settings as this tick read them (the configured default list applied; off unless write-back is on, fix 2). */
  booking: AiCallBookingSettings;
  /** Fix 1 (M-1): the appointment owner and their calendar, read from Salesforce on first use and kept for the tick. */
  calendar(): Promise<OfferCalendar>;
}

const core = (id: string): string => id.slice(0, 15);
const errName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);

/** Salesforce is unusable for this tenant right now; anything else is a bug and propagates. */
const salesforceUnavailable = (err: unknown): boolean =>
  err instanceof CrmNotConnectedError || err instanceof SalesforceAuthError || err instanceof SalesforceApiError || err instanceof QueryTooLargeError;

async function slotsFor(deps: PaceDeps, orgId: string): Promise<{ slots: number; booking: AiCallBookingSettings }> {
  const [row] = await deps.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  const org = { settings: row?.settings ?? {} };
  const settings = outreachSettings(org);
  const live = await liveAiCallCount(deps.db, orgId, deps.now);
  const remaining = settings.aiCallDailyCap - (await placedInLastDay(deps.db, orgId, deps.now));
  if (remaining <= 0) deps.log.info({ orgId, cap: settings.aiCallDailyCap }, 'ai_call.place: daily AI call cap reached');
  return { slots: Math.min(settings.aiCallConcurrency - live, remaining), booking: liveCallBooking(org, deps.defaultSpecialists) };
}

async function loadPlans(deps: PaceDeps, orgId: string, candidates: AiTouchCandidate[]): Promise<Map<string, PlanForCall>> {
  const ids = [...new Set(candidates.map((c) => c.callPlanId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const p = schema.callPlans;
  const r = schema.callResearch;
  const found = await deps.db
    .select({ id: p.id, enrollmentId: p.enrollmentId, orgId: p.orgId, status: p.status, plan: p.plan, snapshot: r.snapshot, createdAt: r.createdAt })
    .from(p)
    .innerJoin(r, eq(r.id, p.researchId))
    .where(inArray(p.id, ids));
  return new Map(
    found
      .filter((row) => row.orgId === orgId)
      .map((row) => {
        const parsed = EditableCallPlan.safeParse(row.plan);
        const collected = new Date(String((row.snapshot as { collectedAt?: unknown } | null)?.collectedAt ?? ''));
        const researchedAt = Number.isNaN(collected.getTime()) || collected > row.createdAt ? row.createdAt : collected;
        return [row.id, { id: row.id, enrollmentId: row.enrollmentId, status: row.status, plan: parsed.success ? parsed.data : null, researchedAt }];
      }),
  );
}

async function freshRecords(client: SalesforceClient, fieldMap: FieldMap, candidates: AiTouchCandidate[]): Promise<Map<string, SfRecordSnapshot>> {
  const byCore = new Map<string, SfRecordSnapshot>();
  for (const sfObject of ['Lead', 'Opportunity'] as const) {
    const ids = [...new Set(candidates.filter((c) => c.sfObject === sfObject).map((c) => c.sfRecordId))];
    if (ids.length === 0) continue;
    for (const s of await fetchRecords(client, sfObject, ids, fieldMap[sfObject])) byCore.set(core(s.sfRecordId), s);
  }
  return byCore;
}

export async function loadOrgTick(deps: PaceDeps, orgId: string): Promise<OrgTick | null> {
  const { slots, booking } = await slotsFor(deps, orgId);
  if (slots <= 0) return null;
  const candidates = await dueAiCallTouches(deps.db, orgId, deps.now, PLACE_CANDIDATES_PER_ORG);
  if (candidates.length === 0) return null;
  const plans = await loadPlans(deps, orgId, candidates);
  let client: SalesforceClient;
  let fresh: Map<string, SfRecordSnapshot>;
  try {
    client = await deps.clients(orgId);
    const fieldMap = FieldMap.safeParse((await loadConnection(deps.db, orgId))?.fieldMap);
    if (!fieldMap.success) {
      deps.log.warn({ orgId }, 'ai_call.place: the Salesforce field map is missing or invalid; tenant skipped');
      return null;
    }
    fresh = await freshRecords(client, fieldMap.data, candidates);
  } catch (err) {
    if (!salesforceUnavailable(err)) throw err;
    deps.log.warn({ orgId, errName: errName(err) }, 'ai_call.place: Salesforce unavailable for tenant; skipped');
    return null;
  }
  const probes: ActivityProbe[] = candidates.flatMap((c) => {
    const plan = c.callPlanId ? plans.get(c.callPlanId) : undefined;
    return plan ? [{ sfRecordId: c.sfRecordId, since: plan.researchedAt }] : [];
  });
  let newActivity: Set<string>;
  try {
    // CF-1: the engine's own call Tasks and the Events and Tasks the write-back created (plan 1D) are not news.
    const ids = probes.map((p) => p.sfRecordId);
    const ours = new Set([...(await engineTaskIds(deps.db, orgId, ids)), ...(await writebackActivityIds(deps.db, orgId, ids))]);
    newActivity = await recordsWithNewActivity(client, probes, ours);
  } catch (err) {
    if (!salesforceUnavailable(err)) throw err;
    deps.log.warn({ orgId, errName: errName(err) }, 'ai_call.place: could not check Salesforce for new activity; the tenant waits');
    if (!(err instanceof SalesforceAuthError || err instanceof CrmNotConnectedError)) {
      const at = new Date(deps.now.getTime() + ACTIVITY_CHECK_RETRY_MS);
      for (const c of candidates) await deferTouch(deps.db, c.touchId, at, 'activity_check_failed');
    }
    return null;
  }
  let calendar: Promise<OfferCalendar> | null = null;
  const readCalendar = (): Promise<OfferCalendar> => (calendar ??= readOfferCalendar(client, { booking, now: deps.now, log: deps.log }));
  return { slots, candidates, plans, fresh: (id) => fresh.get(core(id)), newActivity, client, booking, calendar: readCalendar };
}

/** M-2: the owner zones already warned about (org, owner, zone), so a refused zone is logged once per process, not per tick. */
const warnedZones = new Set<string>();
const MAX_WARNED_ZONES = 1_000;

function warnRefusedZone(deps: PaceDeps, orgId: string, owner: OwnerUser): void {
  if (owner.zoneRefused === null) return;
  const key = `${orgId}:${owner.sfUserId}:${owner.zoneRefused}`;
  if (warnedZones.has(key) || warnedZones.size >= MAX_WARNED_ZONES) return;
  warnedZones.add(key);
  // A Salesforce time zone key (a picklist value), never record content.
  deps.log.warn({ orgId, ownerSfUserId: owner.sfUserId, zone: owner.zoneRefused, usedZone: owner.timeZone }, 'ai_call.place: the appointment owner\'s Salesforce time zone is not usable; business hours use the default zone');
}

/**
 * Plan 1D: the appointment times this touch's trigger offers, read now (calendars change after approval): the tick's one
 * calendar read, less the times other AI calls have booked with the owner that are not on the calendar yet (I-4). The
 * Salesforce part never throws; a missing offer never stops the call. Booking switched off is not worth a log line; any other
 * empty offer is logged by its note only, never record content.
 */
export async function tickOffer(deps: PaceDeps, tick: OrgTick, c: AiTouchCandidate): Promise<Offer> {
  const cal = await tick.calendar();
  if (cal.kind === 'read') warnRefusedZone(deps, c.orgId, cal.owner);
  const offer = await offerWithAiBookings(deps.db, cal, { orgId: c.orgId, booking: tick.booking, now: deps.now });
  if (offer.note && offer.note !== 'booking_off') deps.log.info({ orgId: c.orgId, touchId: c.touchId, slots: offer.note }, 'ai_call.place: no appointment times offered');
  return offer;
}

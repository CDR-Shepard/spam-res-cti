/**
 * Needs Review (spec §7.3): records the AI flagged do-not-contact wait here
 * for their owner. Nothing is suppressed until a person decides. Admins see and
 * decide every item; anyone else only the records they own in Salesforce.
 *
 *  - dismiss: the enrollment resumes and is planned on the next tick, and the record
 *    remembers which flag was dismissed (`crm_records.dnc_dismissed_triage_id`), so the
 *    planner does not hold it again for that flag; a newer flag holds it again. In an
 *    archived campaign there is nothing to resume: the enrollment exits instead.
 *  - confirm: every number on the record goes into the tenant's opt_outs, the
 *    enrollment exits, and `onConfirmed` runs in the same transaction (1B wires
 *    it to the Salesforce write-back outbox).
 */
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DoNotContactCategory, ReviewDecision, SfObject, type NeedsReviewItem, type NeedsReviewResponse } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { CAMPAIGN_ARCHIVED_EXIT_REASON, exitEnrollment } from '../campaigns/enroll.js';
import { sendError } from '../http/errors.js';
import { requireContext, type RequestContext } from '../tenancy/scope.js';

export interface ConfirmedDoNotContact {
  orgId: string;
  sfObject: 'Lead' | 'Opportunity';
  sfRecordId: string;
}

export interface ReviewRouteDeps {
  db: Db;
  /** Runs inside the confirm transaction; 1B enqueues the Salesforce DoNotCall/HasOptedOutOfEmail write here. */
  onConfirmed?: (args: ConfirmedDoNotContact, tx: Db) => Promise<void>;
  /** Where data-quality warnings go (ids only, never phone numbers); defaults to the request logger. */
  log?: ReviewLog;
}

export interface ReviewLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

export const REVIEW_LIST_LIMIT = 200;
/** `opt_outs.source` for a number suppressed by a confirmed do-not-contact flag. */
export const REVIEW_OPT_OUT_SOURCE = 'do_not_contact_review';
export const CONFIRMED_EXIT_REASON = 'do_not_contact_confirmed';

const PhoneEntry = z.object({ field: z.string(), e164: z.string().regex(/^\+[1-9]\d{6,14}$/) });
const EnrollmentParams = z.object({ enrollmentId: z.string().uuid() });

const e = schema.campaignEnrollments;
const r = schema.crmRecords;
const c = schema.campaigns;

/** For display only: an unknown object shows as a Lead. `confirm` never guesses (see `knownSfObject`). */
const asSfObject = (value: string): 'Lead' | 'Opportunity' => (value === 'Opportunity' ? 'Opportunity' : 'Lead');

function knownSfObject(value: string): 'Lead' | 'Opportunity' | null {
  const parsed = SfObject.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The record's valid E.164 numbers, parsed entry by entry so one bad entry does not hide the others. */
function validNumbers(raw: unknown): { numbers: string[]; dropped: number } {
  const entries: unknown[] = Array.isArray(raw) ? raw : [];
  const numbers = new Set<string>();
  let dropped = 0;
  for (const entry of entries) {
    const parsed = PhoneEntry.safeParse(entry);
    if (parsed.success) numbers.add(parsed.data.e164);
    else dropped += 1;
  }
  return { numbers: [...numbers], dropped };
}

/** Salesforce Ids compare on their case-sensitive 15-character core, so a 15- and an 18-character form match. */
function sameSfId(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length < SF_ID_CORE || b.length < SF_ID_CORE) return false;
  return a.slice(0, SF_ID_CORE) === b.slice(0, SF_ID_CORE);
}

interface ReviewRow {
  enrollmentId: string;
  campaignId: string;
  campaignName: string;
  sfObject: string;
  sfRecordId: string;
  name: string | null;
  ownerName: string | null;
  category: string | null;
  quote: string | null;
  flaggedAt: Date | null;
}

function toItem(row: ReviewRow): NeedsReviewItem {
  const category = DoNotContactCategory.safeParse(row.category);
  return {
    enrollmentId: row.enrollmentId,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    sfObject: asSfObject(row.sfObject),
    sfRecordId: row.sfRecordId,
    name: row.name,
    ownerName: row.ownerName,
    category: category.success ? category.data : 'other',
    quote: row.quote ?? '',
    flaggedAt: (row.flaggedAt ?? new Date(0)).toISOString(),
  };
}

/** Salesforce's case-sensitive Id core: the first 15 characters (an 18-character Id adds a checksum). */
const SF_ID_CORE = 15;

/** The Salesforce user the signed-in person connected as (the CTI's salesforce_connections), or null. */
async function ownSfUserId(db: Db, userId: string): Promise<string | null> {
  const [conn] = await db
    .select({ sfUserId: schema.salesforceConnections.sfUserId })
    .from(schema.salesforceConnections)
    .where(eq(schema.salesforceConnections.userId, userId))
    .limit(1);
  return conn?.sfUserId ?? null;
}

/** Admins see every item; anyone else only the records they own (the same rule as `mayDecide`). */
async function listReview(db: Db, ctx: RequestContext): Promise<NeedsReviewResponse> {
  let ownerFilter: SQL | undefined;
  if (!(ctx.session.isAdmin || ctx.session.isSuperAdmin)) {
    const mine = await ownSfUserId(db, ctx.session.userId);
    if (!mine || mine.length < SF_ID_CORE) return { items: [] };
    const core = sql.raw(String(SF_ID_CORE));
    ownerFilter = sql`left(${r.ownerSfUserId}, ${core}) = ${mine.slice(0, SF_ID_CORE)} and length(${r.ownerSfUserId}) >= ${core}`;
  }
  const rows = await db
    .select({
      enrollmentId: e.id,
      campaignId: c.id,
      campaignName: c.name,
      sfObject: r.sfObject,
      sfRecordId: r.sfRecordId,
      name: r.name,
      ownerName: r.ownerName,
      category: e.reviewCategory,
      quote: e.reviewQuote,
      flaggedAt: e.flaggedAt,
    })
    .from(e)
    .innerJoin(c, eq(c.id, e.campaignId))
    .innerJoin(r, eq(r.id, e.crmRecordId))
    .where(and(eq(e.orgId, ctx.orgId), eq(e.status, 'needs_review'), ownerFilter))
    .orderBy(desc(e.flaggedAt))
    .limit(REVIEW_LIST_LIMIT);
  return { items: rows.map(toItem) };
}

interface ReviewTarget {
  enrollmentId: string;
  status: string;
  ownerSfUserId: string | null;
  phones: unknown;
  sfObject: string;
  sfRecordId: string;
  category: string | null;
  quote: string | null;
}

async function loadTarget(db: Db, orgId: string, enrollmentId: string): Promise<ReviewTarget | null> {
  const [row] = await db
    .select({
      enrollmentId: e.id,
      status: e.status,
      ownerSfUserId: r.ownerSfUserId,
      phones: r.phones,
      sfObject: r.sfObject,
      sfRecordId: r.sfRecordId,
      category: e.reviewCategory,
      quote: e.reviewQuote,
    })
    .from(e)
    .innerJoin(r, eq(r.id, e.crmRecordId))
    .where(and(eq(e.id, enrollmentId), eq(e.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/** Admins decide anything; anyone else only records they own in Salesforce (via the CTI's salesforce_connections). */
async function mayDecide(db: Db, ctx: RequestContext, ownerSfUserId: string | null): Promise<boolean> {
  if (ctx.session.isAdmin || ctx.session.isSuperAdmin) return true;
  if (!ownerSfUserId) return false;
  return sameSfId(await ownSfUserId(db, ctx.session.userId), ownerSfUserId);
}

/**
 * The dismissal marker only moves forward, in the triage rows' created order (created_at,
 * then id, as pendingDncFlag orders them): dismissing an item that carries an older flag
 * must not un-dismiss a newer one. A marker pointing at a missing row is replaced.
 */
function markerMovesForward(triageId: string): SQL {
  return sql`(
    ${r.dncDismissedTriageId} is null
    or not exists (select 1 from record_triage cur where cur.id = ${r.dncDismissedTriageId})
    or (select (d.created_at, d.id) from record_triage d where d.id = ${triageId})
       > (select (cur.created_at, cur.id) from record_triage cur where cur.id = ${r.dncDismissedTriageId})
  )`;
}

async function dismiss(db: Db, orgId: string, enrollmentId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Compare-and-swap: of two concurrent decisions, only one gets the row.
    const [claimed] = await tx
      .update(e)
      .set({ updatedAt: now })
      .where(and(eq(e.id, enrollmentId), eq(e.orgId, orgId), eq(e.status, 'needs_review')))
      .returning({ id: e.id, campaignId: e.campaignId, crmRecordId: e.crmRecordId, reviewTriageId: e.reviewTriageId });
    if (!claimed) return false;
    if (claimed.reviewTriageId) {
      await tx
        .update(r)
        .set({ dncDismissedTriageId: claimed.reviewTriageId })
        .where(and(eq(r.id, claimed.crmRecordId), eq(r.orgId, orgId), markerMovesForward(claimed.reviewTriageId)));
    }
    const [campaign] = await tx.select({ status: c.status }).from(c).where(eq(c.id, claimed.campaignId)).limit(1);
    if (campaign?.status === 'archived') {
      await exitEnrollment(tx, claimed.id, { from: ['needs_review'], reason: CAMPAIGN_ARCHIVED_EXIT_REASON });
      return true;
    }
    await tx
      .update(e)
      .set({ status: 'active', reviewCategory: null, reviewQuote: null, reviewTriageId: null, flaggedAt: null, nextTouchAt: now, updatedAt: now })
      .where(eq(e.id, claimed.id));
    return true;
  });
}

async function confirm(deps: ReviewRouteDeps, log: ReviewLog, ctx: RequestContext, target: ReviewTarget, now: Date): Promise<boolean> {
  const { numbers, dropped } = validNumbers(target.phones);
  if (dropped > 0 || numbers.length === 0) {
    log.warn({ orgId: ctx.orgId, enrollmentId: target.enrollmentId, dropped, kept: numbers.length }, 'review: phone entries dropped or none valid when confirming do-not-contact');
  }
  const sfObject = knownSfObject(target.sfObject);
  if (!sfObject) {
    log.warn({ orgId: ctx.orgId, enrollmentId: target.enrollmentId, sfObject: target.sfObject }, 'review: unknown sf_object; the Salesforce write-back is skipped');
  }
  const note = `Do-not-contact confirmed by ${ctx.session.email}: ${target.category ?? 'other'} — "${target.quote ?? ''}"`.slice(0, 500);
  return deps.db.transaction(async (tx) => {
    // Compare-and-swap: of two concurrent confirms, only one gets the row.
    const claimed = await tx
      .update(e)
      .set({ updatedAt: now })
      .where(and(eq(e.id, target.enrollmentId), eq(e.orgId, ctx.orgId), eq(e.status, 'needs_review')))
      .returning({ id: e.id });
    if (claimed.length === 0) return false;
    if (numbers.length > 0) {
      await tx
        .insert(schema.optOuts)
        .values(numbers.map((e164) => ({ orgId: ctx.orgId, e164, source: REVIEW_OPT_OUT_SOURCE, note })))
        .onConflictDoNothing();
    }
    await exitEnrollment(tx, target.enrollmentId, { from: ['needs_review'], reason: CONFIRMED_EXIT_REASON });
    if (sfObject) await deps.onConfirmed?.({ orgId: ctx.orgId, sfObject, sfRecordId: target.sfRecordId }, tx);
    return true;
  });
}

export async function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): Promise<void> {
  const { db } = deps;

  app.get('/review', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    return listReview(db, ctx);
  });

  app.post('/review/:enrollmentId', async (req, reply) => {
    const ctx = await requireContext(db, req, reply);
    if (!ctx) return;
    const params = EnrollmentParams.safeParse(req.params);
    if (!params.success) return sendError(reply, 404, 'REVIEW_NOT_FOUND', 'No such review item');
    const body = ReviewDecision.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'VALIDATION', 'Invalid decision', body.error.flatten());
    const target = await loadTarget(db, ctx.orgId, params.data.enrollmentId);
    if (!target) return sendError(reply, 404, 'REVIEW_NOT_FOUND', 'No such review item');
    if (!(await mayDecide(db, ctx, target.ownerSfUserId))) {
      return sendError(reply, 403, 'NOT_OWNER', "Only the record's owner or an admin can decide this");
    }
    if (target.status !== 'needs_review') return sendError(reply, 409, 'NOT_IN_REVIEW', 'This record is no longer waiting for review');
    const now = new Date();
    const done = body.data.decision === 'dismiss' ? await dismiss(db, ctx.orgId, target.enrollmentId, now) : await confirm(deps, deps.log ?? req.log, ctx, target, now);
    // A concurrent decision got there first.
    if (!done) return sendError(reply, 409, 'NOT_IN_REVIEW', 'This record is no longer waiting for review');
    return reply.code(204).send();
  });
}

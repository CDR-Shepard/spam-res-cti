/**
 * Salesforce → CTI "Power Dial" handoff relay store.
 *
 * SF Apex POSTs the rep's selected record ids (`POST /dialer/handoffs`); we
 * write one 'pending' row for that rep's Salesforce user id, superseding any
 * earlier pending row (only the most recent list-view click should ever
 * fire). The rep's CTI softphone polls `GET /dialer/handoffs/pending`, which
 * atomically claims the latest pending row for their Salesforce user id via a
 * single `UPDATE ... RETURNING` — so two concurrent polls can never both
 * claim (and therefore start) the same run.
 */
import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { getDb } from '../db/index.js';
import { schema } from '../db/index.js';

export type Db = ReturnType<typeof getDb>;

/** Salesforce id: 15-char case-sensitive or 18-char case-insensitive alphanumeric. */
export function isValidSfId(s: string): boolean {
  return /^[a-zA-Z0-9]{15,18}$/.test(s);
}

export interface HandoffInput {
  salesforceUserId: string;
  objectType: 'Lead' | 'Opportunity';
  recordIds: string[];
}

const HandoffInputSchema = z.object({
  salesforceUserId: z.string().refine(isValidSfId, 'invalid salesforceUserId'),
  objectType: z.enum(['Lead', 'Opportunity']),
  recordIds: z
    .array(z.string().refine(isValidSfId, 'invalid record id'))
    .min(1, 'recordIds must not be empty')
    .max(500, 'recordIds must not exceed 500'),
});

/**
 * Validate + dedupe a raw `POST /dialer/handoffs` body. Returns `{ error }`
 * (never throws) so the route can turn a bad body into a 400 without a
 * try/catch.
 */
export function parseHandoffInput(body: unknown): HandoffInput | { error: string } {
  const parsed = HandoffInputSchema.safeParse(body);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid handoff input' };
  }
  return {
    ...parsed.data,
    recordIds: Array.from(new Set(parsed.data.recordIds)),
  };
}

/** Constant-time string comparison (equal-length guard first — `timingSafeEqual` throws on a length mismatch, and a length-driven early exit would itself leak length via timing). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export interface UpsertHandoffArgs {
  orgId: string | null;
  salesforceUserId: string;
  objectType: 'Lead' | 'Opportunity';
  recordIds: string[];
}

/**
 * Write a new 'pending' handoff for `args.salesforceUserId`, first deleting
 * any earlier pending row for that same rep — so a rep who double-clicks (or
 * whose prior run never got claimed) only ever has the latest selection live.
 */
export async function upsertPendingHandoff(db: Db, args: UpsertHandoffArgs): Promise<{ handoffId: string }> {
  await db
    .delete(schema.dialerHandoffs)
    .where(
      and(
        eq(schema.dialerHandoffs.salesforceUserId, args.salesforceUserId),
        eq(schema.dialerHandoffs.status, 'pending'),
      ),
    );
  const [row] = await db
    .insert(schema.dialerHandoffs)
    .values({
      orgId: args.orgId,
      salesforceUserId: args.salesforceUserId,
      objectType: args.objectType,
      recordIds: args.recordIds,
      status: 'pending',
    })
    .returning();
  return { handoffId: row!.id };
}

export interface ClaimedHandoff {
  objectType: 'Lead' | 'Opportunity';
  recordIds: string[];
}

/**
 * Atomically claim the latest pending handoff for `salesforceUserId`: a
 * single `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED) RETURNING`
 * so two concurrent polls can never both claim the same row (one gets the
 * row, the other 0 rows / null). Returns null when there's nothing pending.
 */
export async function claimPendingHandoff(db: Db, salesforceUserId: string): Promise<ClaimedHandoff | null> {
  const result = await db.execute(sql`
    update dialer_handoffs set status = 'claimed', claimed_at = now()
    where id = (
      select id from dialer_handoffs
      where salesforce_user_id = ${salesforceUserId} and status = 'pending'
      order by created_at desc
      limit 1
      for update skip locked
    )
    returning object_type, record_ids
  `);
  const rows = (result as unknown as { rows: Array<{ object_type: string; record_ids: unknown }> }).rows;
  const row = rows[0];
  if (!row) return null;
  return {
    objectType: row.object_type as 'Lead' | 'Opportunity',
    recordIds: row.record_ids as string[],
  };
}

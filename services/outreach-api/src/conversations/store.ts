/**
 * The per-seller conversation (migration 0062): one row per seller per tenant that carries the reply token,
 * who is handling the seller (Sam or a person), whether Sam may still reach out, and the timeline events the
 * team and Sam write. Calls are never copied in; the timeline read merges them from ai_calls.
 *
 * Every function takes the `db` it is given and works the same on a transaction (the multi-step ones open a
 * nested one, which Postgres runs as a savepoint), so a caller can make a stop, a status change and its own
 * writes one unit. Raw SQL in the style of ai-calls/touches.ts: each state change is one conditional UPDATE
 * (`where status = ...`), so a repeat or a race changes nothing and reports false.
 *
 * A PRACTICE conversation (practice_user_id set) is an admin's own copy of Sam's email for a real seller.
 * Nothing it does may reach the seller's thread, the suppression list, an enrollment or Salesforce, so the
 * store enforces that itself: appendEvent never logs a practice event to Salesforce, and stopSeller touches
 * only the practice row. Callers cannot forget it.
 *
 * Logs carry ids only; this module writes none, and no error message here carries an address or a subject.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AiCallOutcome, ConversationHandler, FlagReason, StopReason } from '@cti/contracts';
import { schema, type Db } from '@cti/db';
import { finishAiEnrollment } from '../ai-calls/touches.js';

export type SellerConversationRow = typeof schema.sellerConversations.$inferSelect;
type EventKind = (typeof schema.CONVERSATION_EVENT_KINDS)[number];
type EventDirection = (typeof schema.CONVERSATION_EVENT_DIRECTIONS)[number];
type EventActor = (typeof schema.CONVERSATION_ACTORS)[number];
type SuppressionReason = (typeof schema.EMAIL_SUPPRESSION_REASONS)[number];

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
/** A transaction handle is a Db for every purpose here (the codebase casts it the same way). */
const asDb = (tx: unknown) => tx as Db;
const sqlList = (values: readonly string[], cast: string) => sql.join(values.map((v) => sql`${v}${sql.raw(cast)}`), sql`, `);

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 random bytes (128 bits) as lowercase base32: 26 characters of [a-z2-7], safe in an email local part. */
export function newConversationToken(): string {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of randomBytes(16)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  // 128 bits leave 3 over: pad them to a last 5-bit digit.
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * The seller's conversation, created on first need. Idempotent: the insert does nothing when the row exists
 * (the partial unique index decides, so two callers racing both get the same row), then the row is read.
 * ON CONFLICT must repeat the partial index's columns and WHERE predicate, once for the real conversation
 * and once for an admin's practice one.
 */
export async function ensureConversation(
  db: Db,
  i: { orgId: string; crmRecordId: string; practiceUserId?: string | null },
): Promise<SellerConversationRow> {
  const practiceUserId = i.practiceUserId ?? null;
  const conflict =
    practiceUserId === null
      ? sql`on conflict (org_id, crm_record_id) where practice_user_id is null`
      : sql`on conflict (org_id, crm_record_id, practice_user_id) where practice_user_id is not null`;
  await db.execute(sql`
    insert into seller_conversations (org_id, crm_record_id, practice_user_id, token)
    values (${i.orgId}::uuid, ${i.crmRecordId}::uuid, ${practiceUserId}::uuid, ${newConversationToken()})
    ${conflict} do nothing`);
  const c = schema.sellerConversations;
  const [row] = await db
    .select()
    .from(c)
    .where(and(eq(c.orgId, i.orgId), eq(c.crmRecordId, i.crmRecordId), practiceUserId === null ? isNull(c.practiceUserId) : eq(c.practiceUserId, practiceUserId)))
    .limit(1);
  if (!row) throw new Error('seller conversation missing after insert');
  return row;
}

/** A reply's conversation by its token (tokens are stored lowercase; mail clients may upper-case the local part). */
export async function findConversationByToken(db: Db, token: string): Promise<SellerConversationRow | null> {
  const c = schema.sellerConversations;
  const [row] = await db.select().from(c).where(eq(c.token, token.trim().toLowerCase())).limit(1);
  return row ?? null;
}

export interface ConversationEventInput {
  orgId: string;
  conversationId: string;
  kind: EventKind;
  direction: EventDirection;
  actor: EventActor;
  userId?: string | null;
  occurredAt?: Date;
  subject?: string | null;
  body?: string | null;
  detail?: string | null;
  meta?: Record<string, unknown>;
  /** The tick owes a Salesforce Task for this event. Ignored (never logged) for a practice conversation. */
  sfLog: boolean;
}

/**
 * One timeline row; returns its id. The conversation is read in the same statement, so the practice rule
 * (a practice event is `skipped`, never `pending`) holds even when the caller says `sfLog: true`, and a
 * conversation of another tenant (or none) inserts nothing and throws.
 */
export async function appendEvent(db: Db, e: ConversationEventInput): Promise<string> {
  const logged = sql`(${e.sfLog}::boolean and c.practice_user_id is null)`;
  const result = await db.execute(sql`
    insert into conversation_events
      (org_id, conversation_id, kind, direction, actor, user_id, occurred_at, subject, body, detail, meta, sf_log_status, sf_log_next_at)
    select c.org_id, c.id, ${e.kind}::text, ${e.direction}::text, ${e.actor}::text, ${e.userId ?? null}::uuid,
           ${e.occurredAt ? iso(e.occurredAt) : sql`now()`}, ${e.subject ?? null}::text, ${e.body ?? null}::text, ${e.detail ?? null}::text,
           ${JSON.stringify(e.meta ?? {})}::jsonb,
           case when ${logged} then 'pending' else 'skipped' end,
           case when ${logged} then now() end
    from seller_conversations c
    where c.id = ${e.conversationId}::uuid and c.org_id = ${e.orgId}::uuid
    returning id`);
  const id = rows<{ id: string }>(result)[0]?.id;
  if (!id) throw new Error(`conversation ${e.conversationId} not found for event`);
  return id;
}

/**
 * Who handles the seller. Same handler → false and nothing written. A person taking over records who;
 * giving back to Sam clears the person and the flag (the person dealt with it). The hand-over is on the
 * timeline (`detail` taken_over | given_back) but not logged to Salesforce.
 */
export async function setHandler(
  db: Db,
  i: { conversationId: string; handler: ConversationHandler; userId: string | null; now: Date },
): Promise<boolean> {
  const toSam = i.handler === 'sam';
  return db.transaction(async (tx) => {
    const t = asDb(tx);
    const result = await t.execute(sql`
      update seller_conversations
      set handler = ${i.handler}, handler_user_id = ${toSam ? null : i.userId}::uuid, handler_changed_at = ${iso(i.now)}, updated_at = ${iso(i.now)},
          flag_reason = ${toSam ? sql`null` : sql`flag_reason`}, flagged_at = ${toSam ? sql`null` : sql`flagged_at`}
      where id = ${i.conversationId}::uuid and handler <> ${i.handler}
      returning org_id as "orgId"`);
    const changed = rows<{ orgId: string }>(result)[0];
    if (!changed) return false;
    await appendEvent(t, {
      orgId: changed.orgId,
      conversationId: i.conversationId,
      kind: 'handler',
      direction: 'none',
      actor: i.userId ? 'person' : 'system',
      userId: i.userId,
      occurredAt: i.now,
      detail: toSam ? 'given_back' : 'taken_over',
      sfLog: false,
    });
    return true;
  });
}

/** A person is needed on this seller. An existing flag is kept (false): the first reason stands until a person clears it. */
export async function flagConversation(db: Db, i: { conversationId: string; reason: FlagReason; now: Date }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = asDb(tx);
    const result = await t.execute(sql`
      update seller_conversations set flag_reason = ${i.reason}, flagged_at = ${iso(i.now)}, updated_at = ${iso(i.now)}
      where id = ${i.conversationId}::uuid and flag_reason is null
      returning org_id as "orgId"`);
    const flagged = rows<{ orgId: string }>(result)[0];
    if (!flagged) return false;
    await appendEvent(t, {
      orgId: flagged.orgId,
      conversationId: i.conversationId,
      kind: 'flag',
      direction: 'none',
      actor: 'system',
      occurredAt: i.now,
      detail: i.reason,
      sfLog: true,
    });
    return true;
  });
}

interface StoppedConversation {
  id: string;
  orgId: string;
  crmRecordId: string;
  practiceUserId: string | null;
}

/**
 * Everything a stop of a REAL conversation reaches beyond its own row: the record's address goes on the
 * suppression list, every other real conversation of the tenant whose record has the same address (any case)
 * stops too, and every active ai_call enrollment of all the stopped records is exited (keys freed, planned
 * touches skipped, call stage closed). A seller who opts out of one of their records is opting out of all.
 */
async function stopReachOfRealConversation(db: Db, stopped: StoppedConversation, reason: StopReason, now: Date): Promise<void> {
  const [record] = rows<{ email: string | null }>(
    await db.execute(sql`select lower(btrim(email)) as email from crm_records where id = ${stopped.crmRecordId}::uuid and org_id = ${stopped.orgId}::uuid`),
  );
  const email = record?.email || null;
  const recordIds = [stopped.crmRecordId];
  if (email) {
    await suppressAddress(db, { orgId: stopped.orgId, address: email, reason: reason === 'complained' ? 'complained' : 'opted_out', conversationId: stopped.id });
    const twins = await db.execute(sql`
      update seller_conversations c set status = 'stopped', stop_reason = ${reason}, updated_at = ${iso(now)}
      from crm_records r
      where r.id = c.crm_record_id and r.org_id = c.org_id
        and c.org_id = ${stopped.orgId}::uuid and c.practice_user_id is null and c.id <> ${stopped.id}::uuid
        and c.status in ('open', 'booked') and lower(btrim(r.email)) = ${email}
      returning c.crm_record_id as "crmRecordId"`);
    recordIds.push(...rows<{ crmRecordId: string }>(twins).map((r) => r.crmRecordId));
  }
  const enrollments = await db.execute(sql`
    select e.id from campaign_enrollments e
    join campaigns c on c.id = e.campaign_id and c.org_id = e.org_id
    where e.org_id = ${stopped.orgId}::uuid and e.crm_record_id in (${sqlList(recordIds, '::uuid')})
      and e.status = 'active' and c.mode = 'ai_call'
    order by e.id`);
  for (const { id } of rows<{ id: string }>(enrollments)) await finishAiEnrollment(db, id, reason, 'exited');
}

/**
 * Sam must not reach this seller again. ONE transaction: the conversation goes `stopped` (from open or
 * booked; already stopped → false and nothing is written), a real conversation also suppresses the address,
 * stops the seller's other records and exits their ai_call enrollments (see stopReachOfRealConversation),
 * and a `status` event records the reason, logged to Salesforce unless it is a practice conversation (which
 * touches nothing but its own row).
 */
export async function stopSeller(db: Db, i: { conversationId: string; reason: StopReason; now: Date }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = asDb(tx);
    const result = await t.execute(sql`
      update seller_conversations set status = 'stopped', stop_reason = ${i.reason}, updated_at = ${iso(i.now)}
      where id = ${i.conversationId}::uuid and status in ('open', 'booked')
      returning id, org_id as "orgId", crm_record_id as "crmRecordId", practice_user_id as "practiceUserId"`);
    const stopped = rows<StoppedConversation>(result)[0];
    if (!stopped) return false;
    const practice = stopped.practiceUserId !== null;
    if (!practice) await stopReachOfRealConversation(t, stopped, i.reason, i.now);
    await appendEvent(t, {
      orgId: stopped.orgId,
      conversationId: stopped.id,
      kind: 'status',
      direction: 'none',
      actor: 'system',
      occurredAt: i.now,
      detail: i.reason,
      sfLog: !practice,
    });
    return true;
  });
}

interface CallStatusChange {
  to: 'booked' | 'stopped';
  stopReason: StopReason | null;
  from: readonly ('open' | 'booked')[];
}

/** The call outcomes that move a conversation; every other outcome leaves it alone. */
const CALL_STATUS_CHANGES: Partial<Record<AiCallOutcome, CallStatusChange>> = {
  appointment_set: { to: 'booked', stopReason: null, from: ['open'] },
  do_not_call: { to: 'stopped', stopReason: 'asked_to_stop', from: ['open', 'booked'] },
  not_interested: { to: 'stopped', stopReason: 'not_interested', from: ['open', 'booked'] },
};

/**
 * What a finished AI call says about the seller's conversation: an appointment books it (only while open), a
 * do-not-call or not-interested stops it. The conversation is created when missing. The `status` event is
 * not logged to Salesforce (the call already has its Task), and enrollments are not exited here: the results
 * tick that calls this already does that.
 */
export async function setStatusFromCall(
  db: Db,
  i: { orgId: string; crmRecordId: string; outcome: AiCallOutcome | null; now: Date },
): Promise<void> {
  const change = i.outcome ? CALL_STATUS_CHANGES[i.outcome] : undefined;
  if (!change) return;
  await db.transaction(async (tx) => {
    const t = asDb(tx);
    const conversation = await ensureConversation(t, { orgId: i.orgId, crmRecordId: i.crmRecordId });
    const result = await t.execute(sql`
      update seller_conversations set status = ${change.to}, stop_reason = ${change.stopReason}::text, updated_at = ${iso(i.now)}
      where id = ${conversation.id}::uuid and status in (${sqlList(change.from, '')})
      returning id`);
    if (rows<{ id: string }>(result).length === 0) return;
    await appendEvent(t, {
      orgId: i.orgId,
      conversationId: conversation.id,
      kind: 'status',
      direction: 'none',
      actor: 'system',
      occurredAt: i.now,
      detail: change.stopReason ?? change.to,
      sfLog: false,
    });
  });
}

/**
 * Sam must never email this address again (this tenant). The address is stored trimmed and lowercased, so
 * a send-time check in any case finds it; the first reason on record is kept.
 */
export async function suppressAddress(
  db: Db,
  i: { orgId: string; address: string; reason: SuppressionReason; conversationId: string | null },
): Promise<void> {
  if (i.address.trim() === '') return;
  await db.execute(sql`
    insert into email_suppressions (org_id, address, reason, conversation_id)
    values (${i.orgId}::uuid, lower(btrim(${i.address}::text)), ${i.reason}, ${i.conversationId}::uuid)
    on conflict (org_id, address) do nothing`);
}

/** Why this address is suppressed in this tenant (any case), or null when Sam may email it. */
export async function suppressionFor(db: Db, orgId: string, address: string): Promise<string | null> {
  const result = await db.execute(sql`
    select reason from email_suppressions where org_id = ${orgId}::uuid and address = lower(btrim(${address}::text))`);
  return rows<{ reason: string }>(result)[0]?.reason ?? null;
}

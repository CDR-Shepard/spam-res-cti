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
import { SHARED_ADDRESS_LIMIT, STOP_SUPPRESSIONS, type OnSharedAddress } from './shared-address.js';

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
 * Who handles the seller. Same handler → false and nothing written, except "sam" on a seller Sam still handles
 * who has a flag: that clears the flag in one step (a flag pauses Sam's calls, ai-calls/touches.ts, and the person
 * dealt with it without taking over first), written as a give-back. A person taking over records who; giving back
 * to Sam clears the person and the flag (the person dealt with it). handler_changed_at moves only when the handler
 * does. The hand-over is on the timeline (`detail` taken_over | given_back) but not logged to Salesforce.
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
      set handler = ${i.handler}, handler_user_id = ${toSam ? null : i.userId}::uuid,
          handler_changed_at = case when handler <> ${i.handler} then ${iso(i.now)} else handler_changed_at end, updated_at = ${iso(i.now)},
          flag_reason = ${toSam ? sql`null` : sql`flag_reason`}, flagged_at = ${toSam ? sql`null` : sql`flagged_at`}
      where id = ${i.conversationId}::uuid and (handler <> ${i.handler} ${toSam ? sql`or flag_reason is not null` : sql``})
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

/** Stop reasons that put the seller's address on the suppression list; 'not_interested' alone does not. */
const SUPPRESSING_REASONS: ReadonlySet<StopReason> = new Set<StopReason>(['opted_out', 'complained', 'asked_to_stop']);
/** An explicit opt-out outranks the reason a conversation was already stopped for (a call's not_interested). */
const EXPLICIT_OPT_OUTS: ReadonlySet<StopReason> = new Set<StopReason>(['opted_out', 'complained']);

function suppressionReasonFor(reason: StopReason): SuppressionReason | null {
  if (reason === 'complained') return 'complained';
  return SUPPRESSING_REASONS.has(reason) ? 'opted_out' : null;
}

interface StoppedSeller {
  orgId: string;
  conversationId: string;
  crmRecordId: string;
  reason: StopReason;
  now: Date;
  /** The caller exits the record's own enrollments itself (the results tick does, in its own flow). */
  exitOwnEnrollments: boolean;
  onSharedAddress?: OnSharedAddress;
}

/** How many of the tenant's records carry each of these addresses (trimmed, any case). Reads only: no lock is taken. */
async function recordCountsByAddress(db: Db, orgId: string, addresses: readonly string[]): Promise<Map<string, number>> {
  if (addresses.length === 0) return new Map();
  const result = await db.execute(sql`
    select lower(btrim(email)) as address, count(*)::int as n from crm_records
    where org_id = ${orgId}::uuid and lower(btrim(email)) in (${sqlList(addresses, '')})
    group by 1`);
  return new Map(rows<{ address: string; n: number }>(result).map((r) => [r.address, r.n]));
}

/** The other records of the tenant that carry any of these addresses (trimmed, any case), oldest id first so locks are taken in one order. */
async function recordsWithAddresses(db: Db, orgId: string, exceptRecordId: string, addresses: readonly string[]): Promise<string[]> {
  if (addresses.length === 0) return [];
  const result = await db.execute(sql`
    select id from crm_records
    where org_id = ${orgId}::uuid and id <> ${exceptRecordId}::uuid and lower(btrim(email)) in (${sqlList(addresses, '')})
    order by id`);
  return rows<{ id: string }>(result).map((r) => r.id);
}

/** Every distinct address (trimmed, lowercased) Sam emailed in this conversation, whatever became of the email. */
async function emailedAddresses(db: Db, conversationId: string): Promise<string[]> {
  const result = await db.execute(sql`
    select distinct lower(btrim(to_address)) as address from email_messages
    where conversation_id = ${conversationId}::uuid and direction = 'out'
    order by address`);
  return rows<{ address: string }>(result).map((r) => r.address);
}

/** A sibling record's real conversation, created when missing, ends `stopped` with this reason (an already stopped one keeps its own); a `status` event for a newly stopped one. */
async function stopSiblingConversation(db: Db, s: StoppedSeller, siblingRecordId: string): Promise<void> {
  const conversation = await ensureConversation(db, { orgId: s.orgId, crmRecordId: siblingRecordId });
  const result = await db.execute(sql`
    update seller_conversations set status = 'stopped', stop_reason = ${s.reason}, updated_at = ${iso(s.now)}
    where id = ${conversation.id}::uuid and status in ('open', 'booked')
    returning id`);
  if (rows<{ id: string }>(result).length === 0) return;
  await appendEvent(db, {
    orgId: s.orgId,
    conversationId: conversation.id,
    kind: 'status',
    direction: 'none',
    actor: 'system',
    occurredAt: s.now,
    detail: s.reason,
    sfLog: true,
  });
}

/**
 * The other records a suppressing stop reaches: those that carry an address of the stop shared by at most
 * SHARED_ADDRESS_LIMIT of the tenant's records (stopped, ids in order). An address on more of them is not one seller's,
 * so its records are left alone and the caller is told once (ids and a count, never the address).
 */
async function stopSiblings(db: Db, s: StoppedSeller, addresses: readonly string[]): Promise<string[]> {
  const counts = await recordCountsByAddress(db, s.orgId, addresses);
  const crowded = addresses.filter((a) => (counts.get(a) ?? 0) > SHARED_ADDRESS_LIMIT);
  const spread = addresses.filter((a) => !crowded.includes(a));
  const siblings = await recordsWithAddresses(db, s.orgId, s.crmRecordId, spread);
  for (const siblingRecordId of siblings) await stopSiblingConversation(db, s, siblingRecordId);
  if (crowded.length > 0) {
    // A record has one email, so the crowded addresses' records never overlap and their counts add up.
    const sharedRecordCount = crowded.reduce((sum, a) => sum + (counts.get(a) ?? 0), 0);
    s.onSharedAddress?.({ orgId: s.orgId, conversationId: s.conversationId, sharedRecordCount });
  }
  return siblings;
}

/** A suppressing stop: the record's current address and every emailed one are suppressed, in one sorted order (the lock order), then the siblings. */
async function suppressAndStopSiblings(db: Db, s: StoppedSeller, reason: SuppressionReason): Promise<string[]> {
  const [record] = rows<{ email: string | null }>(
    await db.execute(sql`select lower(btrim(email)) as email from crm_records where id = ${s.crmRecordId}::uuid and org_id = ${s.orgId}::uuid`),
  );
  const email = record?.email || null;
  const suppressed = [...new Set([...(email ? [email] : []), ...(await emailedAddresses(db, s.conversationId))])].sort();
  for (const address of suppressed) await suppressAddress(db, { orgId: s.orgId, address, reason, conversationId: s.conversationId });
  return stopSiblings(db, s, suppressed);
}

/**
 * Everything a stop of a REAL conversation reaches beyond its own row, whether or not the row was already
 * stopped (every step is idempotent, so a later opt-out, complaint or new duplicate record still lands):
 *  - for a suppressing reason (opted_out, complained, asked_to_stop) the record's address, and every address Sam
 *    emailed in this conversation, go on the suppression list. The record's email can change in Salesforce after
 *    Sam wrote, and the person who opted out must stay suppressed at the address that actually received the email.
 *    They are inserted in sorted order: two concurrent sweeps over the same addresses then take their index locks
 *    in the same order and cannot deadlock (40P01);
 *  - for a suppressing reason, every other record of the tenant with one of those addresses (any case) gets a real
 *    conversation that is `stopped`, whether or not it had one, and every active ai_call enrollment of those
 *    records is exited (keys freed, planned touches skipped, call stage closed). A seller who opts out of one of
 *    their records is opting out of all of them; but an address on more than SHARED_ADDRESS_LIMIT records is not
 *    one seller's (an agent's inbox), so those records are left to a person (stopSiblings);
 *  - `not_interested` is about one property: it reaches no other record and suppresses nothing;
 *  - the record's own active ai_call enrollments are exited too, unless the caller does that itself.
 */
async function sweepSeller(db: Db, s: StoppedSeller): Promise<void> {
  const suppression = suppressionReasonFor(s.reason);
  const siblings = suppression ? await suppressAndStopSiblings(db, s, suppression) : [];
  const recordIds = [...(s.exitOwnEnrollments ? [s.crmRecordId] : []), ...siblings];
  if (recordIds.length === 0) return;
  const enrollments = await db.execute(sql`
    select e.id from campaign_enrollments e
    join campaigns c on c.id = e.campaign_id and c.org_id = e.org_id
    where e.org_id = ${s.orgId}::uuid and e.crm_record_id in (${sqlList(recordIds, '::uuid')})
      and e.status = 'active' and c.mode = 'ai_call'
    order by e.id`);
  for (const { id } of rows<{ id: string }>(enrollments)) await finishAiEnrollment(db, id, s.reason, 'exited');
}

interface StoppedConversation {
  id: string;
  orgId: string;
  crmRecordId: string;
  practiceUserId: string | null;
}

export interface StopInput {
  conversationId: string;
  reason: StopReason;
  now: Date;
  /**
   * Told, inside the stop's transaction, when the stop did not spread to other records because an address of it is
   * on more than SHARED_ADDRESS_LIMIT of them. The caller raises the seller_needs_person alert after its own
   * transaction commits (raiseSharedAddressAlert), so a stop that rolls back never pages anyone.
   */
  onSharedAddress?: OnSharedAddress;
}

/**
 * A stop that finds the REAL conversation already stopped (a call said not_interested, a duplicate record
 * was synced after the first stop): the sweep still runs, so the address is suppressed and every record of
 * the seller is stopped. When the new reason is an explicit opt-out that differs from the stored one, the
 * stop reason is upgraded and a `status` event (logged to Salesforce) records it. Returns whether the row
 * changed. A practice conversation, or none, is false and nothing is touched.
 */
async function stopAlreadyStopped(db: Db, i: StopInput): Promise<boolean> {
  const [current] = rows<StoppedConversation & { status: string }>(
    await db.execute(sql`
      select id, org_id as "orgId", crm_record_id as "crmRecordId", practice_user_id as "practiceUserId", status
      from seller_conversations where id = ${i.conversationId}::uuid`),
  );
  if (!current || current.status !== 'stopped' || current.practiceUserId !== null) return false;
  let upgraded = false;
  if (EXPLICIT_OPT_OUTS.has(i.reason)) {
    const result = await db.execute(sql`
      update seller_conversations set stop_reason = ${i.reason}, updated_at = ${iso(i.now)}
      where id = ${current.id}::uuid and status = 'stopped' and stop_reason is distinct from ${i.reason}::text
      returning id`);
    upgraded = rows<{ id: string }>(result).length > 0;
  }
  await sweepSeller(db, {
    orgId: current.orgId,
    conversationId: current.id,
    crmRecordId: current.crmRecordId,
    reason: i.reason,
    now: i.now,
    exitOwnEnrollments: true,
    onSharedAddress: i.onSharedAddress,
  });
  if (upgraded) {
    await appendEvent(db, { orgId: current.orgId, conversationId: current.id, kind: 'status', direction: 'none', actor: 'system', occurredAt: i.now, detail: i.reason, sfLog: true });
  }
  return upgraded;
}

/**
 * Sam must not reach this seller again. ONE transaction: the conversation goes `stopped` (from open or
 * booked) and a `status` event records the reason, logged to Salesforce unless it is a practice conversation
 * (which touches nothing but its own row). A real conversation also runs the sweep (suppression, the
 * seller's other records, enrollments). Already stopped: see stopAlreadyStopped. Returns whether this
 * conversation's row changed (status or stop reason).
 */
export async function stopSeller(db: Db, i: StopInput): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = asDb(tx);
    const result = await t.execute(sql`
      update seller_conversations set status = 'stopped', stop_reason = ${i.reason}, updated_at = ${iso(i.now)}
      where id = ${i.conversationId}::uuid and status in ('open', 'booked')
      returning id, org_id as "orgId", crm_record_id as "crmRecordId", practice_user_id as "practiceUserId"`);
    const stopped = rows<StoppedConversation>(result)[0];
    if (!stopped) return stopAlreadyStopped(t, i);
    const practice = stopped.practiceUserId !== null;
    if (!practice) {
      await sweepSeller(t, {
        orgId: stopped.orgId,
        conversationId: stopped.id,
        crmRecordId: stopped.crmRecordId,
        reason: i.reason,
        now: i.now,
        exitOwnEnrollments: true,
        onSharedAddress: i.onSharedAddress,
      });
    }
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
 * do-not-call or not-interested stops it. The conversation is created when missing. Its own `status` event
 * is not logged to Salesforce (the call already has its Task). A stop also runs the sweep, even when this
 * conversation was already stopped: a do-not-call suppresses the address and stops the seller's other records
 * (within SHARED_ADDRESS_LIMIT; `onSharedAddress` as in stopSeller); a not-interested stays on this record. The
 * call's OWN record's enrollments are left to the results tick that calls this: it exits them in its own flow.
 */
export async function setStatusFromCall(
  db: Db,
  i: { orgId: string; crmRecordId: string; outcome: AiCallOutcome | null; now: Date; onSharedAddress?: OnSharedAddress },
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
    if (rows<{ id: string }>(result).length > 0) {
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
    }
    if (change.stopReason) {
      await sweepSeller(t, {
        orgId: i.orgId,
        conversationId: conversation.id,
        crmRecordId: i.crmRecordId,
        reason: change.stopReason,
        now: i.now,
        exitOwnEnrollments: false,
        onSharedAddress: i.onSharedAddress,
      });
    }
  });
}

/**
 * Sam must never email this address again (this tenant). The address is stored trimmed and lowercased, so
 * a send-time check in any case finds it. The first reason on record is kept, except that a stop (opted_out,
 * complained) replaces a `bounced`: the seller's stop must hold their calls, and a bounce alone would not
 * (the conversation becomes the stop's, unless it names none). The conflict target is the primary key (not partial).
 */
export async function suppressAddress(
  db: Db,
  i: { orgId: string; address: string; reason: SuppressionReason; conversationId: string | null },
): Promise<void> {
  if (i.address.trim() === '') return;
  await db.execute(sql`
    insert into email_suppressions (org_id, address, reason, conversation_id)
    values (${i.orgId}::uuid, lower(btrim(${i.address}::text)), ${i.reason}, ${i.conversationId}::uuid)
    on conflict (org_id, address) do update
      set reason = excluded.reason, conversation_id = coalesce(excluded.conversation_id, email_suppressions.conversation_id)
      where email_suppressions.reason = 'bounced' and excluded.reason in (${sqlList(STOP_SUPPRESSIONS, '')})`);
}

/** Why this address is suppressed in this tenant (any case), or null when Sam may email it. */
export async function suppressionFor(db: Db, orgId: string, address: string): Promise<string | null> {
  const result = await db.execute(sql`
    select reason from email_suppressions where org_id = ${orgId}::uuid and address = lower(btrim(${address}::text))`);
  return rows<{ reason: string }>(result)[0]?.reason ?? null;
}

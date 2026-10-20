/**
 * The webhook event tick: works through the Resend (Svix) events the route stored in `resend_webhook_events`
 * (the route only verifies and stores, so Resend gets its 200 at once) and applies them.
 *
 * A stored event moves pending → done | ignored | failed:
 *  - CLAIM: one statement takes the oldest due `pending` rows (`for update skip locked`, so two ticks never get
 *    the same row) and pushes their `next_attempt_at` 10 minutes out. That is the lease: a tick that dies
 *    mid-way leaves the row pending, and it comes back after the lease, not at once.
 *  - SETTLE: `done`, `ignored` or back to `pending` (see below), conditional on the row still being `pending`.
 *  - A THROW or a `retry` answer counts an attempt and waits 2^attempts minutes (1, 2, 4 ...); the 8th failed
 *    attempt makes the row `failed` for good. `last_error` is the error NAME only: an error message can carry
 *    an address, and a log line or a column here must never.
 *
 * Events arrive in any order and more than once, so every delivery change is a conditional UPDATE on the
 * states it may leave and moves a row only forward: `delivered` only from sending/sent, `failed` only from
 * sending/sent, `bounced` and `complained` from any state that is not already that or worse. `email.sent`
 * records Resend's message id whenever the row has none, even after `delivered` came first.
 *
 * A complaint is the one event with consequences beyond the email: ONE transaction marks the email, stops
 * the seller (which suppresses the address and every record that carries it) and turns Sam's email off for
 * the whole tenant with a pause (Resend closes an account past a 0.08% complaint rate); only after it commits
 * is the alert sent, so a failed alert never undoes the stop and a thrown error never leaves half of it.
 *
 * An event can reach us before the send tick has committed the `resend_id` it names (Resend answers while
 * the send tick is still writing). Such an unmatched delivery event is RETRIED, with the usual backoff, while
 * it is under 5 minutes old, and ignored after that, so a status update is not lost to that race.
 *
 * `email.received` (a seller's reply) is handed to the reply handler (email/inbound.ts `handleReceived`), which
 * answers done, ignored or retry like the delivery events do. A reply that runs out of attempts after it was
 * stored is a seller's message nobody will answer: that dead letter is raised as critical.
 *
 * Logs, alerts and `last_error` carry ids and the seller-page link only: never an address, a subject or any
 * field of the payload.
 */
import { sql } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { dispatchAlert, sellerPageUrl, type AlertEvent } from '../alerts.js';
import type { AppConfig } from '../config.js';
import { appendEvent, stopSeller, suppressAddress } from '../conversations/store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { describeError } from './errors.js';
import { handleReceived } from './inbound.js';
import { pauseSamEmail, setSamEmailEnabled } from './pause.js';
import type { ResendClient } from './resend-client.js';
import type { EmailWriter } from './writer.js';

export const EVENT_BATCH = 50;
/** A claimed event is invisible to other ticks this long. */
export const EVENT_LEASE_MS = 10 * 60_000;
/** The attempt that fails an event for good. */
export const MAX_EVENT_ATTEMPTS = 8;
export const RECEIVED_EVENT_TYPE = 'email.received';
/** A delivery event whose email row is not there yet is retried until it is this old, then ignored. */
export const UNMATCHED_RETRY_WINDOW_MS = 5 * 60_000;

/** What a stored event is handed on as: its type and the payload's `data`. */
export interface StoredEvent {
  type: string;
  data: unknown;
}

/** A delivery event with the time the route stored it. Without `receivedAt` an unmatched event is never waited for. */
export interface DeliveryEvent extends StoredEvent {
  receivedAt?: Date;
}

/** `retry` is "not yet" (e.g. Resend has not made the inbound email readable): the same backoff as an error, but not one. */
export type ReceivedOutcome = 'done' | 'ignored' | 'retry';

export interface EventDeps {
  db: Db;
  /** For the reply handler (email/inbound.ts): reading an inbound email back. */
  resend: ResendClient;
  /** For the reply handler: null when Sam's writer is not configured (a reply that needs an answer goes to a person). */
  writer: EmailWriter | null;
  cfg: Pick<AppConfig, 'emailEnabled' | 'EMAIL_FROM' | 'EMAIL_REPLY_DOMAIN' | 'EMAIL_POSTAL_ADDRESS' | 'EMAIL_COMPANY_NAME' | 'API_PUBLIC_URL'>;
  /** Origin of the web app: alert links point at `${appPublicUrl}/sellers/<Salesforce record id>`. */
  appPublicUrl: string;
  now: Date;
  log: RunnerLogger;
  /** Where alerts go; the shared dispatcher (log + ALERT_WEBHOOK_URL) when absent. It must not throw. */
  alert?: (event: AlertEvent) => Promise<void>;
  batch?: number;
}

export interface EventCounts {
  done: number;
  ignored: number;
  /** Events whose handling THREW this tick (they retry after a backoff unless it was their 8th attempt). */
  failed: number;
}

/** What `handleDeliveryEvent` needs to raise the complaint alert (the tick passes its own; a test passes a stub). */
export interface DeliveryNotify {
  alert: (event: AlertEvent) => Promise<void>;
  appPublicUrl: string;
  log: Pick<RunnerLogger, 'error'>;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const asDb = (tx: unknown) => tx as Db;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ClaimedEvent {
  svixId: string;
  type: string;
  payload: unknown;
  attempts: number;
  /** When the route stored it, in epoch milliseconds (a raw timestamptz would come back as a string). */
  receivedAtMs: number | string;
}

/**
 * The oldest due `pending` events, leased for 10 minutes. The final SELECT orders them: the order of an
 * UPDATE's RETURNING is not guaranteed, and oldest first is what the caller works in.
 */
async function claimDue(db: Db, now: Date, limit: number): Promise<ClaimedEvent[]> {
  const result = await db.execute(sql`
    with due as (
      select svix_id from resend_webhook_events
      where status = 'pending' and next_attempt_at <= ${iso(now)}
      order by received_at, svix_id
      limit ${limit}
      -- The row lock is what stops two ticks claiming one row: with none, a second UPDATE that waits for the
      -- first re-checks only its own join condition (not this subquery's status and next_attempt_at), so both
      -- ticks claim it. SKIP LOCKED then keeps a tick from waiting on rows another tick holds: it takes the
      -- next ones instead (a slow tick must not stall every tick queued behind it).
      for update skip locked
    ), claimed as (
      update resend_webhook_events w
      set next_attempt_at = ${iso(new Date(now.getTime() + EVENT_LEASE_MS))}
      from due
      where w.svix_id = due.svix_id
      returning w.svix_id, w.type, w.payload, w.attempts, w.received_at
    )
    select svix_id as "svixId", type, payload, attempts, (extract(epoch from received_at) * 1000)::float8 as "receivedAtMs"
    from claimed order by received_at, svix_id`);
  return rows<ClaimedEvent>(result);
}

/** done | ignored, only while the row is still pending (the lease holder is the one settling it). */
async function settle(db: Db, svixId: string, status: 'done' | 'ignored', now: Date): Promise<void> {
  await db.execute(sql`
    update resend_webhook_events set status = ${status}, processed_at = ${iso(now)}, last_error = null
    where svix_id = ${svixId} and status = 'pending'`);
}

/**
 * One more attempt used: back to pending after 2^attempts minutes (counted from before this attempt), or
 * failed on the last one. True when this call made the event `failed` for good.
 */
async function reschedule(db: Db, svixId: string, reason: string, now: Date): Promise<boolean> {
  const result = await db.execute(sql`
    update resend_webhook_events
    set attempts = attempts + 1,
        last_error = ${reason},
        status = case when attempts + 1 >= ${MAX_EVENT_ATTEMPTS} then 'failed' else 'pending' end,
        processed_at = case when attempts + 1 >= ${MAX_EVENT_ATTEMPTS} then ${iso(now)} end,
        next_attempt_at = ${iso(now)} + (power(2, attempts) * interval '1 minute')
    where svix_id = ${svixId} and status = 'pending'
    returning status`);
  return rows<{ status: string }>(result)[0]?.status === 'failed';
}

/** The tenant of the inbound email (a seller's reply) we stored under this Resend id, if we stored it. */
async function inboundOrgId(db: Db, resendId: string): Promise<string | null> {
  const result = await db.execute(sql`select org_id as "orgId" from email_messages where direction = 'in' and resend_id = ${resendId}`);
  return rows<{ orgId: string }>(result)[0]?.orgId ?? null;
}

/**
 * An event is out of attempts: tell someone, because nothing else will. The worst are critical: a failed
 * complaint (the seller is still emailable and the tenant is not paused) and a failed reply (a seller's message
 * nobody will answer). The tenant comes from our email row the event names: the outbound email for a delivery
 * event, the stored inbound one for a reply. An event that names none (a reply Resend never gave back, a malformed
 * event) has no tenant to alert for, so it is logged by id. The alert carries the event id and type only. Never
 * throws: it runs inside the tick.
 */
async function alertDeadLetter(deps: EventDeps, alert: (event: AlertEvent) => Promise<void>, row: ClaimedEvent): Promise<void> {
  const { db, log } = deps;
  try {
    const resendId = isRecord(row.payload) ? resendEmailId(row.payload.data) : null;
    const received = row.type === RECEIVED_EVENT_TYPE;
    const orgId = resendId === null ? null : received ? await inboundOrgId(db, resendId) : (await findOutbound(db, resendId))?.orgId ?? null;
    if (orgId === null) {
      log.error({ svixId: row.svixId, type: row.type }, 'email event failed for good and names no email of ours: no alert');
      return;
    }
    await alert({
      kind: 'job_dead_lettered',
      severity: received || row.type === 'email.complained' ? 'critical' : 'warning',
      orgId,
      message: `Email event ${row.type} (${row.svixId}) failed ${MAX_EVENT_ATTEMPTS} times and will not be retried.`,
      context: { svixId: row.svixId, type: row.type },
    });
  } catch (err) {
    log.error({ svixId: row.svixId, type: row.type, ...describeError(err) }, 'dead-letter alert failed');
  }
}

async function dispatch(deps: EventDeps, row: ClaimedEvent, notify: DeliveryNotify): Promise<ReceivedOutcome> {
  const data = isRecord(row.payload) ? row.payload.data : undefined;
  if (row.type === RECEIVED_EVENT_TYPE) return handleReceived({ ...deps, alert: notify.alert }, { data }, deps.now);
  return handleDeliveryEvent(deps.db, { type: row.type, data, receivedAt: new Date(Number(row.receivedAtMs)) }, deps.now, notify);
}

export async function processEmailEvents(deps: EventDeps): Promise<EventCounts> {
  const { db, now, log } = deps;
  const alert = deps.alert ?? ((event: AlertEvent) => dispatchAlert(log, event));
  const notify: DeliveryNotify = { alert, appPublicUrl: deps.appPublicUrl, log };
  const claimed = await claimDue(db, now, Math.max(1, Math.trunc(deps.batch ?? EVENT_BATCH)));
  const counts: EventCounts = { done: 0, ignored: 0, failed: 0 };
  let retried = 0;
  for (const row of claimed) {
    let outcome: ReceivedOutcome;
    try {
      outcome = await dispatch(deps, row, notify);
    } catch (err) {
      const { errorName, errorCode } = describeError(err);
      log.error({ svixId: row.svixId, type: row.type, attempt: row.attempts + 1, errorName, ...(errorCode ? { errorCode } : {}) }, 'email event failed');
      if (await reschedule(db, row.svixId, errorName.slice(0, 100), now)) await alertDeadLetter(deps, alert, row);
      counts.failed += 1;
      continue;
    }
    if (outcome === 'retry') {
      log.info({ svixId: row.svixId, type: row.type, attempt: row.attempts + 1 }, 'email event will be retried');
      if (await reschedule(db, row.svixId, 'retry', now)) await alertDeadLetter(deps, alert, row);
      retried += 1;
    } else {
      await settle(db, row.svixId, outcome, now);
      counts[outcome] += 1;
    }
  }
  if (claimed.length > 0) log.info({ claimed: claimed.length, retried, ...counts }, 'email events tick');
  return counts;
}

/** Our outbound email a webhook names, with what the changes need to know about its conversation. */
interface OutboundEmail {
  id: string;
  orgId: string;
  conversationId: string;
  /** Where Sam sent it: the address a bounce suppresses. */
  toAddress: string;
  /** Set for an admin's practice conversation, which never reaches the suppression list. */
  practiceUserId: string | null;
  sfRecordId: string;
}

async function findOutbound(db: Db, resendId: string): Promise<OutboundEmail | null> {
  const result = await db.execute(sql`
    select m.id, m.org_id as "orgId", m.conversation_id as "conversationId", m.to_address as "toAddress",
           c.practice_user_id as "practiceUserId", r.sf_record_id as "sfRecordId"
    from email_messages m
    join seller_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    join crm_records r on r.id = c.crm_record_id and r.org_id = c.org_id
    where m.direction = 'out' and m.resend_id = ${resendId}`);
  return rows<OutboundEmail>(result)[0] ?? null;
}

/** Resend's id for the email an event is about (`data.email_id`), or null when the event does not carry one. */
function resendEmailId(data: unknown): string | null {
  const id = isRecord(data) ? data.email_id : undefined;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

/** The RFC 5322 Message-ID of the email (`data.message_id`), when the event carries a sane one. */
function messageIdOf(data: unknown): string | null {
  const id = isRecord(data) ? data.message_id : undefined;
  return typeof id === 'string' && id.trim() !== '' && id.length <= 998 ? id : null;
}

/** The event types `handleDeliveryEvent` acts on; every other type is ignored without a lookup. */
const DELIVERY_TYPES: ReadonlySet<string> = new Set(['email.sent', 'email.delivered', 'email.bounced', 'email.complained', 'email.failed', 'email.suppressed']);

/** Moves the email to `status` from the states `from` only; false when it was elsewhere (an event that came late or twice). */
async function moveStatus(db: Db, emailId: string, status: string, from: readonly string[], now: Date, lastError?: string): Promise<boolean> {
  const result = await db.execute(sql`
    update email_messages
    set status = ${status}, updated_at = ${iso(now)}${lastError === undefined ? sql`` : sql`, last_error = ${lastError}`}
    where id = ${emailId}::uuid and direction = 'out' and status in (${sql.join(from.map((s) => sql`${s}`), sql`, `)})
    returning id`);
  return rows<unknown>(result).length > 0;
}

async function recordMessageId(db: Db, email: OutboundEmail, data: unknown, now: Date): Promise<void> {
  const messageId = messageIdOf(data);
  if (messageId === null) return;
  await db.execute(sql`
    update email_messages set message_id = ${messageId}, updated_at = ${iso(now)}
    where id = ${email.id}::uuid and direction = 'out' and message_id is null`);
}

/** A bounce: the address will not take Sam's mail, so it is suppressed (never for a practice conversation) and the timeline says so. The conversation itself stays open. */
async function applyBounce(db: Db, email: OutboundEmail, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const t = asDb(tx);
    if (!(await moveStatus(t, email.id, 'bounced', ['sending', 'sent', 'delivered', 'failed'], now))) return;
    if (email.practiceUserId === null) {
      await suppressAddress(t, { orgId: email.orgId, address: email.toAddress, reason: 'bounced', conversationId: email.conversationId });
    }
    await appendEvent(t, {
      orgId: email.orgId,
      conversationId: email.conversationId,
      kind: 'note',
      direction: 'none',
      actor: 'system',
      occurredAt: now,
      detail: 'bounced',
      sfLog: false,
    });
  });
}

/**
 * A spam complaint, all or nothing: the email is marked, the seller is stopped (the store suppresses the
 * record's CURRENT address and stops their other records; for a practice conversation it touches only that
 * row), the address that actually complained is suppressed too (the record may have changed since Sam wrote),
 * and the tenant's email is paused AND switched off, so the admin's toggle reads off until they turn it back
 * on (which clears the pause). True when this event did it; a repeat finds the email already complained and
 * does nothing.
 */
async function applyComplaint(db: Db, email: OutboundEmail, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const t = asDb(tx);
    if (!(await moveStatus(t, email.id, 'complained', ['sending', 'sent', 'delivered', 'bounced', 'failed'], now))) return false;
    await stopSeller(t, { conversationId: email.conversationId, reason: 'complained', now });
    if (email.practiceUserId === null) {
      await suppressAddress(t, { orgId: email.orgId, address: email.toAddress, reason: 'complained', conversationId: email.conversationId });
    }
    await pauseSamEmail(t, { orgId: email.orgId, reason: 'complaint', now });
    await setSamEmailEnabled(t, { orgId: email.orgId, enabled: false });
    return true;
  });
}

/** Sent after the complaint's transaction has committed; a failing alert is logged by name and never fails the event. */
async function raiseComplaintAlert(notify: DeliveryNotify, email: OutboundEmail): Promise<void> {
  const url = sellerPageUrl(notify.appPublicUrl, email.sfRecordId);
  try {
    await notify.alert({
      kind: 'email_complaint',
      severity: 'critical',
      orgId: email.orgId,
      message: `A seller marked a Sam email as spam. Sam's email is paused for the whole tenant until an admin turns it back on. Seller: ${url}`,
      context: { emailId: email.id, conversationId: email.conversationId, sellerUrl: url },
    });
  } catch (err) {
    notify.log.error({ alert: 'email_complaint', emailId: email.id, ...describeError(err) }, 'complaint alert failed');
  }
}

/**
 * One delivery event applied to our outbound email (matched by `direction = 'out'` and Resend's id).
 *  - `done`: understood and handled, including one that changed nothing because the email had already moved
 *    past it.
 *  - `ignored`: an unhandled type, no email id, or no email of ours with that id once the event is 5 minutes
 *    old (or has no `receivedAt`).
 *  - `retry`: a delivery event naming an email we have not recorded yet and under 5 minutes old: Resend can
 *    answer before the send tick has committed the `resend_id`, so it is tried again, not dropped.
 * Throws on a database error, with nothing committed from this event (the tick retries it).
 */
export async function handleDeliveryEvent(db: Db, ev: DeliveryEvent, now: Date, notify: DeliveryNotify): Promise<ReceivedOutcome> {
  if (!DELIVERY_TYPES.has(ev.type)) return 'ignored';
  const resendId = resendEmailId(ev.data);
  if (resendId === null) return 'ignored';
  const email = await findOutbound(db, resendId);
  if (!email) return ev.receivedAt !== undefined && now.getTime() - ev.receivedAt.getTime() < UNMATCHED_RETRY_WINDOW_MS ? 'retry' : 'ignored';
  switch (ev.type) {
    case 'email.sent':
      await recordMessageId(db, email, ev.data, now);
      break;
    case 'email.delivered':
      await moveStatus(db, email.id, 'delivered', ['sending', 'sent'], now);
      break;
    case 'email.bounced':
      await applyBounce(db, email, now);
      break;
    case 'email.complained':
      if (await applyComplaint(db, email, now)) await raiseComplaintAlert(notify, email);
      break;
    case 'email.failed':
    case 'email.suppressed':
      // Resend will not deliver it. The reason is the event type: a short fixed code, never text from the email.
      await moveStatus(db, email.id, 'failed', ['sending', 'sent'], now, ev.type);
      break;
  }
  return 'done';
}

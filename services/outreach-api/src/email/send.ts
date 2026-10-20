/**
 * The send tick: drains the outbox (`email_messages` rows that are `queued` and due) through Resend.
 *
 * A row moves queued → sending → sent | queued (retry, or the seller's hours) | canceled | failed, and every
 * move is a conditional UPDATE on the state AND the claim it expects, so a second tick, a reaper or a late
 * answer can never move a row twice or send it twice:
 *  - CLAIM: one compare-and-swap per row, taken just before the row is worked on (never a whole batch up
 *    front, so a slow Resend cannot make the rows still waiting look abandoned). Every later change to the
 *    row also requires `claimed_at` to be this claim's, so an answer that arrives after the row was reaped
 *    and taken over by another worker changes nothing (it is logged as `lost`).
 *  - GATES: sendBlock runs after the claim and before Resend. The claim comes first on purpose: two emails of
 *    one conversation worked by two ticks each see the other as `sending`, so the daily cap can only
 *    over-count, never let a 4th through.
 *  - IDEMPOTENCY (Review Focus 5): every attempt carries Idempotency-Key `email:<id>`, and Resend answers a
 *    repeat from the first attempt, but only for 24 hours. `first_attempt_at` is written in the statement
 *    that commits to calling Resend (right before the request, never earlier), so it dates the key. A row
 *    whose first attempt is more than 23 hours old is NEVER handed to Resend again: a repeat would be a
 *    second copy to the seller, which is worse than a missing email. It is failed (`idempotency_window`) at
 *    every place that could hand it over: when the reaper sees it stranded, when it is claimed, and when the
 *    seller's hours would push its next try past the window (a retry on Friday at 16:59 meets a window that
 *    reopens Monday). A row with no first attempt never reached Resend, so it may wait any length of time.
 *    A tick that dies after Resend accepted an email leaves the row `sending`; after 5 minutes the reaper
 *    puts it back and the next claim re-sends it under the same key, so the seller gets one copy.
 *
 * A seller's ANSWER (a `reply` or a `holding` email) canceled because Sam's email is off or paused for the tenant, or
 * because of the daily cap, is not the seller's choice: the seller wrote and is waiting. The conversation is flagged
 * `unsure` in the cancel's own transaction, and once it has committed a seller_needs_person alert (ids only) asks a
 * person to answer, so a seller's reply is never dropped silently. A first email (nobody is waiting on it) and an
 * email on a practice conversation (it goes to the admin) are canceled as before; an already flagged conversation
 * keeps its reason and raises no second alert.
 *
 * Logs carry ids, block codes and counts only: never an address, a name, a subject or any text.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@cti/db';
import { dispatchAlert, type AlertEvent } from '../alerts.js';
import type { AppConfig } from '../config.js';
import { flagConversation } from '../conversations/store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { replyAddress } from './addresses.js';
import { describeError } from './errors.js';
import { emailSendAt, evaluateSend, type SendBlock, type SendEvaluation } from './outbox.js';
import { renderEmail } from './render.js';
import type { ResendClient, ResendSendResult } from './resend-client.js';

/** A `sending` row older than this lost its tick (a crash): it goes back to `queued`. */
export const STALE_CLAIM_MS = 5 * 60_000;
/** Resend remembers an idempotency key for 24 hours from the first attempt; past this (an hour of margin) a row is not handed over again. */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60_000;
export const MAX_SEND_ATTEMPTS = 5;
/** Minutes before attempt 2, 3, 4 and 5 when Resend asked for a retry, by the attempt that just failed. */
export const RETRY_DELAY_MINUTES = [1, 5, 15, 60] as const;
export const SEND_BATCH = 20;

export interface SendDeps {
  db: Db;
  resend: ResendClient;
  cfg: Pick<AppConfig, 'EMAIL_FROM' | 'EMAIL_REPLY_DOMAIN' | 'EMAIL_POSTAL_ADDRESS' | 'EMAIL_COMPANY_NAME' | 'API_PUBLIC_URL'>;
  now: Date;
  log: RunnerLogger;
  batch?: number;
  /** Where a seller_needs_person alert goes (an answer canceled for the switch or the cap); the shared dispatcher when absent. */
  alert?: (event: AlertEvent) => Promise<void>;
}

/** Blocks that are about the tenant or the cap, not the seller: a seller's answer canceled for one of them needs a person. */
const NEEDS_PERSON_BLOCKS: ReadonlySet<SendBlock> = new Set<SendBlock>(['paused', 'disabled', 'daily_cap']);
/** Emails that answer a seller who wrote: Sam's reply, or the thank-you of a flag. */
const ANSWER_PURPOSES: ReadonlySet<string> = new Set(['reply', 'holding']);

export interface SendCounts {
  sent: number;
  retried: number;
  canceled: number;
  failed: number;
}

type Outcome = keyof SendCounts | 'deferred' | 'lost';

interface Claim {
  id: string;
  orgId: string;
  eventId: string;
  toAddress: string;
  inReplyTo: string | null;
  references: string | null;
  attempts: number;
  /** This claim's `claimed_at`: the tick's `now`. Every later write to the row must still find it there. */
  claimedAt: Date;
  /** When the row was first handed to Resend (epoch ms), or null when it never was. */
  firstAttemptMs: number | null;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

/** Resend has forgotten the key by `at` (or is about to): the row's first attempt is over 23 hours before it. */
const keyExpiredAt = (firstAttemptMs: number | null, at: Date): boolean => firstAttemptMs !== null && at.getTime() - firstAttemptMs > IDEMPOTENCY_WINDOW_MS;

/**
 * Stale `sending` rows. Failed when Resend may have forgotten their key (`idempotency_window`) or when they
 * already used all their attempts and still die before settling (`stuck`: a row that always throws would
 * otherwise go round every 5 minutes); else back to `queued`. A row with no first attempt never reached Resend
 * and is requeued whatever its age.
 */
async function reapStaleClaims(db: Db, now: Date): Promise<{ requeued: number; failed: number }> {
  const keyExpired = sql`first_attempt_at < ${iso(ago(now, IDEMPOTENCY_WINDOW_MS))}`;
  const exhausted = sql`attempts >= ${MAX_SEND_ATTEMPTS}`;
  const result = await db.execute(sql`
    update email_messages
    set status = case when ${keyExpired} or ${exhausted} then 'failed' else 'queued' end,
        last_error = case when ${keyExpired} then 'idempotency_window' when ${exhausted} then 'stuck' else last_error end,
        claimed_at = case when ${keyExpired} or ${exhausted} then claimed_at end,
        updated_at = ${iso(now)}
    where direction = 'out' and status = 'sending' and claimed_at < ${iso(ago(now, STALE_CLAIM_MS))}
    returning status`);
  const statuses = rows<{ status: string }>(result).map((r) => r.status);
  const failed = statuses.filter((status) => status === 'failed').length;
  return { requeued: statuses.length - failed, failed };
}

async function dueEmailIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const result = await db.execute(sql`
    select id from email_messages
    where direction = 'out' and status = 'queued' and send_after <= ${iso(now)}
    order by send_after, id
    limit ${limit}`);
  return rows<{ id: string }>(result).map((r) => r.id);
}

type ClaimRow = Omit<Claim, 'claimedAt' | 'firstAttemptMs'> & { firstAttemptMs: number | string | null };

/** queued → sending for one row, only if it is still queued and due: the loser of a race gets null. */
async function claim(db: Db, emailId: string, now: Date): Promise<Claim | null> {
  const result = await db.execute(sql`
    update email_messages
    set status = 'sending', attempts = attempts + 1, claimed_at = ${iso(now)}, updated_at = ${iso(now)}
    where id = ${emailId}::uuid and direction = 'out' and status = 'queued' and send_after <= ${iso(now)}
    returning id, org_id as "orgId", event_id as "eventId", to_address as "toAddress", in_reply_to as "inReplyTo", "references", attempts,
              (extract(epoch from first_attempt_at) * 1000)::float8 as "firstAttemptMs"`);
  const row = rows<ClaimRow>(result)[0];
  return row ? { ...row, claimedAt: now, firstAttemptMs: row.firstAttemptMs === null ? null : Number(row.firstAttemptMs) } : null;
}

/** This claim still holds the row: it is `sending` and `claimed_at` is the one this tick took. */
const holds = (c: Claim) => sql`id = ${c.id}::uuid and status = 'sending' and claimed_at = ${iso(c.claimedAt)}`;

/** Applies `set` to a row this claim still holds; false when something else already moved it. */
async function settle(db: Db, c: Claim, now: Date, set: SQL): Promise<boolean> {
  const result = await db.execute(sql`
    update email_messages set ${set}, updated_at = ${iso(now)}
    where ${holds(c)}
    returning id`);
  return rows<unknown>(result).length > 0;
}

/** Back to `queued` for `at`, claim released. */
const requeue = (at: Date) => sql`status = 'queued', send_after = ${iso(at)}, claimed_at = null`;

/** Fails a row this claim holds; the reason is a short code (never text from the email). */
async function fail(deps: SendDeps, c: Claim, reason: string): Promise<Outcome> {
  deps.log.warn({ emailId: c.id, attempt: c.attempts, reason }, 'email failed');
  return (await settle(deps.db, c, deps.now, sql`status = 'failed', last_error = ${reason}`)) ? 'failed' : 'lost';
}

async function markSent(db: Db, c: Claim, resendId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const tdb = tx as unknown as Db;
    if (!(await settle(tdb, c, now, sql`status = 'sent', resend_id = ${resendId}, sent_at = ${iso(now)}, last_error = null`))) return false;
    // The event moves to the send time and, unless this is a practice conversation, now owes a Salesforce Task.
    await tdb.execute(sql`
      update conversation_events ev
      set occurred_at = ${iso(now)},
          sf_log_status = case when c.practice_user_id is null then 'pending' else ev.sf_log_status end,
          sf_log_next_at = case when c.practice_user_id is null then ${iso(now)} else ev.sf_log_next_at end
      from seller_conversations c
      where ev.id = ${c.eventId}::uuid and ev.org_id = ${c.orgId}::uuid and c.id = ev.conversation_id`);
    return true;
  });
}

async function applyAnswer(deps: SendDeps, c: Claim, answer: ResendSendResult): Promise<Outcome> {
  const { db, now, log } = deps;
  if (answer.kind === 'sent') return (await markSent(db, c, answer.id, now)) ? 'sent' : 'lost';
  if (answer.kind === 'retry' && c.attempts < MAX_SEND_ATTEMPTS) {
    const minutes = RETRY_DELAY_MINUTES[c.attempts - 1] ?? RETRY_DELAY_MINUTES[3];
    log.info({ emailId: c.id, attempt: c.attempts, reason: answer.reason }, 'email will be retried');
    const moved = await settle(db, c, now, sql`${requeue(new Date(now.getTime() + minutes * 60_000))}, last_error = ${answer.reason}`);
    return moved ? 'retried' : 'lost';
  }
  return fail(deps, c, answer.reason);
}

/**
 * The statement that commits to calling Resend: it dates the idempotency key (first attempt only, a later
 * attempt keeps it) while this claim still holds the row. False = the row is no longer ours: do not send.
 */
async function commitToSend(db: Db, c: Claim, now: Date): Promise<boolean> {
  const result = await db.execute(sql`
    update email_messages set first_attempt_at = coalesce(first_attempt_at, ${iso(now)})
    where ${holds(c)}
    returning id`);
  return rows<unknown>(result).length > 0;
}

const isBlank = (text: string | null): boolean => text === null || text.trim() === '';

async function deliver(deps: SendDeps, c: Claim): Promise<Outcome> {
  const { db, resend, cfg, now } = deps;
  const content = rows<{ subject: string | null; body: string | null; token: string }>(
    await db.execute(sql`
      select ev.subject, ev.body, sc.token
      from conversation_events ev
      join seller_conversations sc on sc.id = ev.conversation_id and sc.org_id = ev.org_id
      where ev.id = ${c.eventId}::uuid and ev.org_id = ${c.orgId}::uuid`),
  )[0];
  if (!content) throw new Error(`event missing for email ${c.id}`);
  // Never send a blank email to a seller.
  if (isBlank(content.subject) || isBlank(content.body)) return fail(deps, c, 'missing_content');
  if (keyExpiredAt(c.firstAttemptMs, now)) return fail(deps, c, 'idempotency_window');
  if (!(await commitToSend(db, c, now))) return 'lost';
  const rendered = renderEmail({
    body: content.body ?? '',
    token: content.token,
    apiPublicUrl: cfg.API_PUBLIC_URL,
    replyDomain: cfg.EMAIL_REPLY_DOMAIN,
    postalAddress: cfg.EMAIL_POSTAL_ADDRESS,
    companyName: cfg.EMAIL_COMPANY_NAME,
    inReplyTo: c.inReplyTo,
    references: c.references,
  });
  const answer = await resend.send(
    {
      from: cfg.EMAIL_FROM,
      to: c.toAddress,
      subject: content.subject ?? '',
      text: rendered.text,
      html: rendered.html,
      replyTo: replyAddress(content.token, cfg.EMAIL_REPLY_DOMAIN),
      headers: rendered.headers,
    },
    `email:${c.id}`,
  );
  return applyAnswer(deps, c, answer);
}

/**
 * Outside the seller's hours: wait for the next opening. Not an attempt, so the claim's attempt is given back
 * (and last_error kept). But an email Resend may already have taken must not wait past its key: if the opening is
 * more than 23 hours after the first attempt it is failed now, not deferred to be re-sent after Resend forgot it.
 */
async function wait(deps: SendDeps, c: Claim, opening: Date): Promise<Outcome> {
  if (keyExpiredAt(c.firstAttemptMs, opening)) return fail(deps, c, 'idempotency_window');
  const moved = await settle(deps.db, c, deps.now, sql`${requeue(opening)}, attempts = greatest(attempts - 1, 0)`);
  return moved ? 'deferred' : 'lost';
}

/** Sent after the cancel committed; a failing alert is logged by name and never fails the tick. */
async function raiseUnanswered(deps: SendDeps, c: Claim, e: SendEvaluation, block: SendBlock): Promise<void> {
  const alert = deps.alert ?? ((event: AlertEvent) => dispatchAlert(deps.log, event));
  try {
    await alert({
      kind: 'seller_needs_person',
      severity: 'warning',
      orgId: c.orgId,
      message: `Sam's answer to a seller was not sent (${block}); a person needs to answer them.`,
      context: { conversationId: e.conversationId, emailId: c.id, reason: 'unsure', block },
    });
  } catch (err) {
    deps.log.error({ alert: 'seller_needs_person', emailId: c.id, ...describeError(err) }, 'seller_needs_person alert failed');
  }
}

/**
 * Cancels a row this claim holds, with the block as `last_error`. A seller's answer canceled for the switch or the cap
 * also flags the conversation `unsure` in the same transaction, and alerts once that has committed (see the module comment).
 */
async function cancel(deps: SendDeps, c: Claim, e: SendEvaluation, block: SendBlock): Promise<Outcome> {
  const { db, now, log } = deps;
  log.info({ emailId: c.id, block }, 'email canceled');
  const canceled = sql`status = 'canceled', last_error = ${block}`;
  if (!(NEEDS_PERSON_BLOCKS.has(block) && ANSWER_PURPOSES.has(e.purpose) && !e.practice)) {
    return (await settle(db, c, now, canceled)) ? 'canceled' : 'lost';
  }
  const result = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    if (!(await settle(t, c, now, canceled))) return 'lost' as const;
    return (await flagConversation(t, { conversationId: e.conversationId, reason: 'unsure', now })) ? ('flagged' as const) : ('canceled' as const);
  });
  if (result === 'lost') return 'lost';
  if (result === 'flagged') await raiseUnanswered(deps, c, e, block);
  return 'canceled';
}

/** Gate one claimed row, then send it. */
async function work(deps: SendDeps, c: Claim): Promise<Outcome> {
  const evaluation = await evaluateSend(deps.db, c.id, deps.now);
  const { block } = evaluation;
  if (block === 'outside_window') return wait(deps, c, emailSendAt(evaluation.phones, deps.now));
  if (block !== null) return cancel(deps, c, evaluation, block);
  return deliver(deps, c);
}

export async function sendDueEmails(deps: SendDeps): Promise<SendCounts> {
  const { db, now, log } = deps;
  const reaped = await reapStaleClaims(db, now);
  const counts: SendCounts = { sent: 0, retried: 0, canceled: 0, failed: reaped.failed };
  let deferred = 0;
  const due = await dueEmailIds(db, now, Math.max(1, Math.trunc(deps.batch ?? SEND_BATCH)));
  for (const emailId of due) {
    try {
      const claimed = await claim(db, emailId, now);
      if (!claimed) continue;
      const outcome = await work(deps, claimed);
      if (outcome === 'deferred') deferred += 1;
      else if (outcome === 'lost') log.warn({ emailId, outcome }, 'email was moved by another worker; this answer was dropped');
      else counts[outcome] += 1;
    } catch (err) {
      // The row stays `sending`; the reaper puts it back, and the same idempotency key keeps a re-send safe.
      log.error({ emailId, ...describeError(err) }, 'email send tick: row failed');
    }
  }
  if (reaped.requeued > 0 || reaped.failed > 0 || due.length > 0) log.info({ requeued: reaped.requeued, due: due.length, deferred, ...counts }, 'email send tick');
  return counts;
}

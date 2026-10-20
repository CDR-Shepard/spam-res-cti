/**
 * The send tick: drains the outbox (`email_messages` rows that are `queued` and due) through Resend.
 *
 * A row moves queued → sending → sent | queued (retry, or the seller's hours) | canceled | failed, and every
 * move is a conditional UPDATE on the state it expects, so a second tick, a reaper or a late answer can
 * never move a row twice or send it twice:
 *  - CLAIM: one compare-and-swap per row, taken just before the row is worked on (never a whole batch up
 *    front, so a slow Resend cannot make the rows still waiting look abandoned).
 *  - GATES: sendBlock runs after the claim and before Resend. The claim comes first on purpose: two emails of
 *    one conversation worked by two ticks each see the other as `sending`, so the daily cap can only
 *    over-count, never let a 4th through.
 *  - IDEMPOTENCY (Review Focus 5): every attempt carries Idempotency-Key `email:<id>`; Resend answers a repeat
 *    from the first attempt for 24 hours. A tick that dies after Resend accepted an email leaves the row
 *    `sending`; after 5 minutes the reaper puts it back and the next claim re-sends it under the same key, so
 *    the seller gets one copy. Resend forgets a key after 24 hours, so a stranded row created over 23 hours ago
 *    is failed (`idempotency_window`) and never re-sent: a second copy is worse than a missing one.
 *
 * Logs carry ids, block codes and counts only: never an address, a name, a subject or any text.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '@cti/db';
import type { AppConfig } from '../config.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { replyAddress } from './addresses.js';
import { emailSendAt, evaluateSend } from './outbox.js';
import { renderEmail } from './render.js';
import type { ResendClient, ResendSendResult } from './resend-client.js';

/** A `sending` row older than this lost its tick (a crash): it goes back to `queued`. */
export const STALE_CLAIM_MS = 5 * 60_000;
/** Resend remembers an idempotency key for 24 hours; a row older than this is not re-sent (an hour of margin). */
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
}

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
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const ago = (now: Date, ms: number) => new Date(now.getTime() - ms);

/** Stale `sending` rows: failed when Resend may have forgotten their key, else back to `queued`. Returns how many. */
async function reapStaleClaims(db: Db, now: Date): Promise<number> {
  const tooOld = sql`created_at < ${iso(ago(now, IDEMPOTENCY_WINDOW_MS))}`;
  const result = await db.execute(sql`
    update email_messages
    set status = case when ${tooOld} then 'failed' else 'queued' end,
        last_error = case when ${tooOld} then 'idempotency_window' else last_error end,
        claimed_at = case when ${tooOld} then claimed_at end,
        updated_at = ${iso(now)}
    where direction = 'out' and status = 'sending' and claimed_at < ${iso(ago(now, STALE_CLAIM_MS))}
    returning id`);
  return rows<unknown>(result).length;
}

async function dueEmailIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const result = await db.execute(sql`
    select id from email_messages
    where direction = 'out' and status = 'queued' and send_after <= ${iso(now)}
    order by send_after, id
    limit ${limit}`);
  return rows<{ id: string }>(result).map((r) => r.id);
}

/** queued → sending for one row, only if it is still queued and due: the loser of a race gets null. */
async function claim(db: Db, emailId: string, now: Date): Promise<Claim | null> {
  const result = await db.execute(sql`
    update email_messages
    set status = 'sending', attempts = attempts + 1, claimed_at = ${iso(now)}, updated_at = ${iso(now)}
    where id = ${emailId}::uuid and direction = 'out' and status = 'queued' and send_after <= ${iso(now)}
    returning id, org_id as "orgId", event_id as "eventId", to_address as "toAddress", in_reply_to as "inReplyTo", "references", attempts`);
  return rows<Claim>(result)[0] ?? null;
}

/** Applies `set` to a row still `sending`; false when something else already moved it. */
async function settle(db: Db, emailId: string, now: Date, set: SQL): Promise<boolean> {
  const result = await db.execute(sql`
    update email_messages set ${set}, updated_at = ${iso(now)}
    where id = ${emailId}::uuid and status = 'sending'
    returning id`);
  return rows<unknown>(result).length > 0;
}

const requeue = (at: Date, error: string | null) => sql`status = 'queued', send_after = ${iso(at)}, claimed_at = null, last_error = ${error}`;

async function markSent(db: Db, c: Claim, resendId: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const tdb = tx as unknown as Db;
    if (!(await settle(tdb, c.id, now, sql`status = 'sent', resend_id = ${resendId}, sent_at = ${iso(now)}, last_error = null`))) return false;
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
    const moved = await settle(db, c.id, now, requeue(new Date(now.getTime() + minutes * 60_000), answer.reason));
    return moved ? 'retried' : 'lost';
  }
  log.warn({ emailId: c.id, attempt: c.attempts, reason: answer.reason }, 'email failed');
  return (await settle(db, c.id, now, sql`status = 'failed', last_error = ${answer.reason}`)) ? 'failed' : 'lost';
}

async function deliver(deps: SendDeps, c: Claim): Promise<Outcome> {
  const { db, resend, cfg } = deps;
  const content = rows<{ subject: string | null; body: string | null; token: string }>(
    await db.execute(sql`
      select ev.subject, ev.body, sc.token
      from conversation_events ev
      join seller_conversations sc on sc.id = ev.conversation_id and sc.org_id = ev.org_id
      where ev.id = ${c.eventId}::uuid and ev.org_id = ${c.orgId}::uuid`),
  )[0];
  if (!content) throw new Error(`event missing for email ${c.id}`);
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

/** Gate one claimed row, then send it. */
async function work(deps: SendDeps, c: Claim): Promise<Outcome> {
  const { db, now, log } = deps;
  const { block, phones } = await evaluateSend(db, c.id, now);
  if (block === 'outside_window') {
    // Not an attempt: the row waits for the seller's morning and the claim's attempt is given back.
    const moved = await settle(db, c.id, now, sql`${requeue(emailSendAt(phones, now), null)}, attempts = greatest(attempts - 1, 0)`);
    return moved ? 'deferred' : 'lost';
  }
  if (block !== null) {
    log.info({ emailId: c.id, block }, 'email canceled');
    return (await settle(db, c.id, now, sql`status = 'canceled', last_error = ${block}`)) ? 'canceled' : 'lost';
  }
  return deliver(deps, c);
}

function describeError(err: unknown): { errorName: string; errorCode?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return { errorName: err instanceof Error ? err.name : typeof err, ...(typeof code === 'string' ? { errorCode: code } : {}) };
}

export async function sendDueEmails(deps: SendDeps): Promise<SendCounts> {
  const { db, now, log } = deps;
  const counts: SendCounts = { sent: 0, retried: 0, canceled: 0, failed: 0 };
  let deferred = 0;
  const reaped = await reapStaleClaims(db, now);
  const due = await dueEmailIds(db, now, Math.max(1, Math.trunc(deps.batch ?? SEND_BATCH)));
  for (const emailId of due) {
    try {
      const claimed = await claim(db, emailId, now);
      if (!claimed) continue;
      const outcome = await work(deps, claimed);
      if (outcome === 'deferred') deferred += 1;
      else if (outcome !== 'lost') counts[outcome] += 1;
    } catch (err) {
      // The row stays `sending`; the reaper puts it back, and the same idempotency key keeps a re-send safe.
      log.error({ emailId, ...describeError(err) }, 'email send tick: row failed');
    }
  }
  if (reaped > 0 || due.length > 0) log.info({ reaped, due: due.length, deferred, ...counts }, 'email send tick');
  return counts;
}

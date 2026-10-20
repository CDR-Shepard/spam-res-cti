/**
 * A seller's reply: read it back from Resend (the webhook carries only its id), find its conversation, store it
 * once on the timeline, decide what it needs (inbound-decide.ts) and act on that: record it, stop the seller, hand
 * it to a person, or have Sam answer it in the same thread.
 *
 * Finding the conversation: the token in a recipient (`sam+<token>@` or `unsubscribe+<token>@` our reply domain,
 * in To, Cc or Resend's received-for list) first, because it needs nothing else to have happened (Resend can hand
 * us the reply before our own `email.sent` event stored the Message-ID, Review Focus 3); else an In-Reply-To or
 * References id that is the Message-ID of an email Sam sent. Neither: not a reply of ours, ignored.
 *
 * Exactly once, in two steps:
 *  - STORE: the inbound email row and its timeline event, in one transaction. The `(direction, resend_id)` unique
 *    index turns a redelivered event (or a second tick) into a read of the row already there.
 *  - HANDLE: one transaction locks the stored row (`for update skip locked`, while `handled_at` is null), decides,
 *    asks the writer, acts and sets `handled_at`. A handled row is `done`; a row another tick holds is `retry`
 *    (that tick finishes it, or rolls back and leaves it to the retry); a crash anywhere rolls the answer back
 *    with it. So a reply is never answered twice and never lost. The writer's spend is charged outside the
 *    transaction (on `deps.db`): a model call that was paid for stays counted.
 * Alerts go out only after the transaction commits, so a rolled-back flag never pages anyone.
 *
 * The opt-out check reads the WHOLE reply (optOutScanText: quoted lines, our footer, URLs and our mailboxes left
 * out) and the subject line, after dropping any fragment of our unsubscribe URL that a client broke onto a line
 * of its own: a quoted footer must never read as "unsubscribe" (Review Focus 1), and an opt-out written below the
 * quote must never be missed. What Sam reads and the timeline shows is `stripQuoted`: the seller's new words.
 *
 * Seller text is PII: logs and alerts carry ids, decision kinds, short codes, error names and the seller-page
 * link only. Never the address, the subject or the text.
 */
import { sql } from 'drizzle-orm';
import { EMAIL_SUBJECT_MAX, type ConversationHandler, type ConversationStatus, type FlagReason } from '@cti/contracts';
import type { Db } from '@cti/db';
import { sellerPageUrl, type AlertEvent } from '../alerts.js';
import type { AppConfig } from '../config.js';
import { appendEvent, findConversationByToken, flagConversation, stopSeller } from '../conversations/store.js';
import type { RunnerLogger } from '../jobs/boss.js';
import { samEmailSettings } from '../settings.js';
import { parseMailbox, tokenFromRecipients } from './addresses.js';
import { draftIssues } from './draft-guard.js';
import { describeError } from './errors.js';
import type { ReceivedOutcome } from './events.js';
import { decideInbound, type InboundDecision } from './inbound-decide.js';
import { htmlToText, isAutoReply, isOptOutText, optOutScanText, stripQuoted } from './inbound-text.js';
import { emailSendAt, emailsOutInLastDay, queueEmail } from './outbox.js';
import { ResendError, type ReceivedEmail, type ResendClient } from './resend-client.js';
import { loadWriterContext } from './writer-context.js';
import { writeEmail, type EmailWriter } from './writer.js';

/** The most of the seller's words Sam reads (the newest; a longer reply is cut). */
export const INBOUND_TEXT_MAX = 4_000;
/** The longest subject stored or shown to Sam (our own subjects stop at EMAIL_SUBJECT_MAX). */
export const INBOUND_SUBJECT_MAX = 300;
/** The longest body stored on the timeline. */
export const INBOUND_BODY_MAX = 10_000;
/**
 * Bounds one writer call, and with it the transaction and row lock around it. The events tick claims at most 3 replies
 * (events.ts RECEIVED_BATCH) under one 10-minute lease, so their writer calls (9 minutes at most) end inside it.
 */
export const REPLY_WRITER_TIMEOUT_MS = 3 * 60_000;
/**
 * Resend's stored copy of an inbound email can lag the webhook that announced it: a 404 or 410 this soon after the
 * event was stored means "not yet" and is retried. Later it means the email is gone. An ignored unsubscribe mail would
 * be an opt-out lost.
 */
export const UNREADABLE_RETRY_WINDOW_MS = 10 * 60_000;
/** A header line's limit (RFC 5322): a Message-ID longer than this is not one. */
const HEADER_MAX = 998;
/** How much of a long header (In-Reply-To, References, the recipient list) the inbound row keeps. */
const HEADER_STORE_MAX = 4_000;
/** How much of a threading header is parsed: its end, where References keeps the newest ids. */
const THREAD_HEADER_PARSE_MAX = 32_000;
const ANGLED_ID = /<([^<>\s]{1,998})>/g;
/** The thread ids looked up for a reply with no token, and the References ids an answer carries (the newest). */
const THREAD_IDS_MAX = 20;
/** Resend answers that mean the email will never be readable. Anything else (no answer, 401, 429, 5xx) may pass. */
const GONE_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);
/** Of those, the ones that only mean "not yet" while the event is young (UNREADABLE_RETRY_WINDOW_MS). */
const NOT_YET_STATUSES: ReadonlySet<number> = new Set([404, 410]);

export interface InboundDeps {
  db: Db;
  resend: ResendClient;
  /** Null when Sam's writer is not configured: a reply that needs an answer goes to a person. */
  writer: EmailWriter | null;
  cfg: Pick<AppConfig, 'emailEnabled' | 'EMAIL_FROM' | 'EMAIL_REPLY_DOMAIN' | 'EMAIL_COMPANY_NAME'>;
  /** Origin of the web app: alert links point at `${appPublicUrl}/sellers/<Salesforce record id>`. */
  appPublicUrl: string;
  log: RunnerLogger;
  alert: (event: AlertEvent) => Promise<void>;
}

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const asDb = (tx: unknown) => tx as Db;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Postgres text refuses NUL: a reply carrying one must not fail every retry. */
const clean = (s: string): string => s.replace(/\u0000/g, '');

/** The reply as it is stored and judged: cleaned, capped, and with the parts each reader needs. */
interface ReadReply {
  resendId: string;
  /** The From address, parsed and lowercased; null when the header holds no single address. */
  sender: string | null;
  fromStored: string;
  toStored: string;
  subject: string;
  /** The seller's new words (stripQuoted), capped for the timeline. */
  body: string;
  /** The whole reply as text, for the opt-out scan. */
  full: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  autoReply: boolean;
  /** Ids from In-Reply-To then References (newest first), without angle brackets: what a reply with no token is matched by. */
  threadIds: string[];
  /** Their References ids, oldest first, the newest kept: the thread our answer continues. */
  referenceIds: string[];
}

/** The message ids in a threading header, oldest first and without angle brackets (a bare id is read as one too). */
function idsIn(header: string | undefined): string[] {
  if (!header) return [];
  const tail = header.slice(-THREAD_HEADER_PARSE_MAX);
  const bracketed = [...tail.matchAll(ANGLED_ID)].map((m) => m[1]!);
  return bracketed.length > 0 ? bracketed : tail.split(/\s+/).filter((id) => id !== '' && id.length <= HEADER_MAX && !/[<>]/.test(id));
}

/** A header value fit to store: cleaned, capped, null when empty. */
function headerText(value: string | undefined, max: number): string | null {
  const v = clean(value ?? '').trim().slice(0, max);
  return v === '' ? null : v;
}

function readReply(email: ReceivedEmail, companyName: string): ReadReply {
  const full = clean(email.text !== null && email.text.trim() !== '' ? email.text : htmlToText(email.html ?? ''));
  const messageId = headerText(email.messageId ?? email.headers['message-id'], HEADER_MAX);
  const sender = parseMailbox(email.from);
  const inReplyTo = idsIn(email.headers['in-reply-to']);
  const references = idsIn(email.headers.references);
  return {
    resendId: email.id,
    sender,
    fromStored: sender ?? clean(email.from).trim().slice(0, HEADER_MAX),
    toStored: clean((email.to.length > 0 ? email.to : email.receivedFor).join(', ')).slice(0, HEADER_STORE_MAX),
    subject: clean(email.subject).trim().slice(0, INBOUND_SUBJECT_MAX),
    body: stripQuoted(full, { companyName }).slice(0, INBOUND_BODY_MAX),
    full,
    messageId: messageId !== null && !/[\r\n]/.test(messageId) ? messageId : null,
    inReplyTo: headerText(email.headers['in-reply-to'], HEADER_STORE_MAX),
    references: headerText(email.headers.references, HEADER_STORE_MAX),
    autoReply: isAutoReply({ headers: email.headers, from: email.from, subject: email.subject }),
    threadIds: [...new Set([...inReplyTo, ...[...references].reverse()])].slice(0, THREAD_IDS_MAX),
    referenceIds: references.slice(-(THREAD_IDS_MAX - 1)),
  };
}

/** Our unsubscribe path with a token, as a client may leave it on a line of its own after breaking the URL. */
const UNSUBSCRIBE_PATH = /unsubscribe\/[a-z2-7]{26}/i;
const REPLY_PREFIXES = /^(?:(?:re|fwd?)[ \t]*:[ \t]*)+/i;

/**
 * Does the reply ask to stop? The whole reply (optOutScanText) with any whitespace-delimited piece that carries our
 * unsubscribe path dropped first (a footer URL broken mid-path must not read as "unsubscribe"), or the subject line
 * without its Re:/Fwd: prefixes. Split on whitespace rather than matched with `\S*…\S*`, which is quadratic on a
 * long run of seller-written non-space text.
 */
function asksToStop(r: ReadReply, companyName: string): boolean {
  const withoutOurUrl = r.full
    .split(/(\s+)/)
    .map((piece) => (UNSUBSCRIBE_PATH.test(piece) ? ' ' : piece))
    .join('');
  return isOptOutText(optOutScanText(withoutOurUrl, { companyName })) || isOptOutText(r.subject.replace(REPLY_PREFIXES, ''));
}

/** Resend's id for the inbound email (`data.email_id`), or null when the event carries none. */
function emailIdOf(data: unknown): string | null {
  const id = isRecord(data) ? data.email_id : undefined;
  return typeof id === 'string' && id.trim() !== '' ? id : null;
}

type Fetched = { kind: 'ok'; email: ReceivedEmail } | { kind: 'ignored' } | { kind: 'retry' };

/**
 * The email from Resend. A 400/404/410/422 will never be readable (ignored), except a 404 or 410 under 10 minutes after
 * the event was stored (`receivedAt`; none = never waited for), which is retried. Anything else is tried again.
 */
async function fetchReceived(deps: InboundDeps, resendId: string, receivedAt: Date | undefined, now: Date): Promise<Fetched> {
  try {
    return { kind: 'ok', email: await deps.resend.getReceived(resendId) };
  } catch (err) {
    if (err instanceof ResendError && GONE_STATUSES.has(err.status)) {
      const young = receivedAt !== undefined && now.getTime() - receivedAt.getTime() < UNREADABLE_RETRY_WINDOW_MS;
      if (young && NOT_YET_STATUSES.has(err.status)) {
        deps.log.info({ resendId, status: err.status }, 'email.received: Resend cannot return this email yet; will retry');
        return { kind: 'retry' };
      }
      deps.log.warn({ resendId, status: err.status }, 'email.received: Resend has no readable email with this id; ignored');
      return { kind: 'ignored' };
    }
    const status = err instanceof ResendError ? { status: err.status } : {};
    deps.log.warn({ resendId, ...status, ...describeError(err) }, 'email.received: the email could not be read from Resend; will retry');
    return { kind: 'retry' };
  }
}

interface Thread {
  orgId: string;
  conversationId: string;
  /** Addressed to the conversation's unsubscribe mailbox. */
  unsubscribe: boolean;
}

/**
 * The token the reply is addressed to (the first recipient that carries one), and whether ANY recipient is the
 * unsubscribe mailbox of that same token: a client may send to both sam+<token> and unsubscribe+<token>, and
 * tokenFromRecipients alone stops at the first.
 */
function addressedToken(recipients: readonly string[], domain: string): { token: string; unsubscribe: boolean } | null {
  const first = tokenFromRecipients(recipients, domain);
  if (!first) return null;
  const unsubscribe = recipients.some((raw) => {
    const one = tokenFromRecipients([raw], domain);
    return one !== null && one.unsubscribe && one.token === first.token;
  });
  return { token: first.token, unsubscribe };
}

/** The conversation by recipient token, else by a thread id that is the Message-ID of one of Sam's emails (either bracket form). */
async function findThread(db: Db, email: ReceivedEmail, r: ReadReply, domain: string): Promise<Thread | null> {
  const addressed = addressedToken([...email.to, ...email.cc, ...email.receivedFor], domain);
  if (addressed) {
    const conversation = await findConversationByToken(db, addressed.token);
    if (conversation) return { orgId: conversation.orgId, conversationId: conversation.id, unsubscribe: addressed.unsubscribe };
  }
  if (r.threadIds.length === 0) return null;
  const candidates = r.threadIds.flatMap((id) => [`<${id}>`, id]);
  const result = await db.execute(sql`
    select message_id as "messageId", org_id as "orgId", conversation_id as "conversationId" from email_messages
    where direction = 'out' and message_id in (${sql.join(candidates.map((c) => sql`${c}`), sql`, `)})`);
  const found = rows<{ messageId: string; orgId: string; conversationId: string }>(result);
  for (const id of r.threadIds) {
    const hit = found.find((row) => row.messageId.replace(/^<|>$/g, '') === id);
    if (hit) return { orgId: hit.orgId, conversationId: hit.conversationId, unsubscribe: false };
  }
  return null;
}

interface StoredReply {
  id: string;
  orgId: string;
  conversationId: string;
}

async function storedReply(db: Db, resendId: string): Promise<StoredReply | null> {
  const result = await db.execute(sql`
    select id, org_id as "orgId", conversation_id as "conversationId" from email_messages
    where direction = 'in' and resend_id = ${resendId}`);
  return rows<StoredReply>(result)[0] ?? null;
}

/** Thrown inside the store transaction when another tick stored the same email first: rolls back our event. */
class AlreadyStored extends Error {
  override name = 'AlreadyStored';
}

/**
 * The inbound row and its timeline event (the seller's email, logged to Salesforce unless the conversation is a
 * practice one), together. A row already stored for this Resend id is returned as it is, whichever tick wrote it.
 * The ON CONFLICT repeats the partial unique index's predicate: without it Postgres refuses every insert (42P10).
 */
async function storeReply(db: Db, thread: Thread, r: ReadReply, now: Date): Promise<StoredReply> {
  const existing = await storedReply(db, r.resendId);
  if (existing) return existing;
  try {
    return await db.transaction(async (tx) => {
      const t = asDb(tx);
      const eventId = await appendEvent(t, {
        orgId: thread.orgId,
        conversationId: thread.conversationId,
        kind: 'email',
        direction: 'in',
        actor: 'seller',
        occurredAt: now,
        subject: r.subject,
        body: r.body,
        meta: { autoReply: r.autoReply },
        sfLog: true,
      });
      const inserted = await t.execute(sql`
        insert into email_messages
          (org_id, conversation_id, event_id, direction, status, purpose, to_address, from_address, in_reply_to, "references", message_id, resend_id)
        values
          (${thread.orgId}::uuid, ${thread.conversationId}::uuid, ${eventId}::uuid, 'in', 'received', 'inbound', ${r.toStored}, ${r.fromStored},
           ${r.inReplyTo}, ${r.references}, ${r.messageId}, ${r.resendId})
        on conflict (direction, resend_id) where resend_id is not null do nothing
        returning id`);
      const id = rows<{ id: string }>(inserted)[0]?.id;
      if (!id) throw new AlreadyStored();
      return { id, orgId: thread.orgId, conversationId: thread.conversationId };
    });
  } catch (err) {
    if (!(err instanceof AlreadyStored)) throw err;
  }
  const raced = await storedReply(db, r.resendId);
  if (!raced) throw new Error('inbound email missing after a conflicting insert');
  return raced;
}

/** What the decision and the answer need about the reply's conversation, seller and tenant. */
interface ReplyContext {
  emailId: string;
  orgId: string;
  conversationId: string;
  crmRecordId: string;
  sfRecordId: string;
  practiceUserId: string | null;
  practiceEmail: string | null;
  recordEmail: string | null;
  recordClosed: boolean;
  status: ConversationStatus;
  handler: ConversationHandler;
  flagReason: string | null;
  phones: unknown;
  settings: unknown;
}

/**
 * The stored reply's row, locked for this transaction, with its context; null when it is handled already or another
 * tick holds it (SKIP LOCKED: a tick never waits behind a slow writer call).
 */
async function lockUnhandled(t: Db, emailId: string): Promise<ReplyContext | null> {
  const result = await t.execute(sql`
    select m.id as "emailId", m.org_id as "orgId", m.conversation_id as "conversationId", c.crm_record_id as "crmRecordId",
           r.sf_record_id as "sfRecordId", c.practice_user_id as "practiceUserId", u.email as "practiceEmail",
           r.email as "recordEmail", r.is_closed as "recordClosed", c.status, c.handler, c.flag_reason as "flagReason",
           r.phones, o.settings
    from email_messages m
    join seller_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    join crm_records r on r.id = c.crm_record_id and r.org_id = c.org_id
    join organizations o on o.id = m.org_id
    left join users u on u.id = c.practice_user_id and u.org_id = c.org_id
    where m.id = ${emailId}::uuid and m.direction = 'in' and m.handled_at is null
    for update of m skip locked`);
  return rows<ReplyContext>(result)[0] ?? null;
}

const normalAddress = (a: string | null): string | null => (a === null ? null : a.trim().toLowerCase() || null);

/** Where Sam's answer goes: the seller's address, or the admin's own for a practice conversation. */
function sellerAddress(ctx: ReplyContext): string | null {
  return normalAddress(ctx.practiceUserId !== null ? ctx.practiceEmail : ctx.recordEmail);
}

function phonesOf(ctx: ReplyContext): Array<{ e164: string }> {
  return Array.isArray(ctx.phones) ? ctx.phones.filter((p): p is { e164: string } => typeof (p as { e164?: unknown } | null)?.e164 === 'string') : [];
}

async function decide(t: Db, deps: InboundDeps, ctx: ReplyContext, r: ReadReply, unsubscribe: boolean, now: Date): Promise<InboundDecision> {
  const email = samEmailSettings({ settings: ctx.settings });
  return decideInbound({
    unsubscribeAddress: unsubscribe,
    autoReply: r.autoReply,
    optOutText: asksToStop(r, deps.cfg.EMAIL_COMPANY_NAME),
    senderMatches: r.sender !== null && r.sender === sellerAddress(ctx),
    practice: ctx.practiceUserId !== null,
    status: ctx.status,
    recordClosed: ctx.recordClosed,
    handler: ctx.handler,
    flagged: ctx.flagReason !== null,
    samSentLast24h: await emailsOutInLastDay(t, { orgId: ctx.orgId, conversationId: ctx.conversationId }, now),
    emailOn: deps.cfg.emailEnabled && email.enabled && email.pausedAt === null,
    writerAvailable: deps.writer !== null,
  });
}

/** What handling did, for the log line and the alert sent after commit. */
interface Handled {
  decision: InboundDecision['kind'];
  /** Set when this reply flagged the conversation (an alert is owed); null when it did not, or it already was. */
  flagged: FlagReason | null;
  /** What Sam's writer answered (`ok:<action>`, `over_budget`, `failed:<code>`), when she was asked. */
  writer?: string;
  /** Her answer (a reply, or a flag's thank-you) was queued, or refused by the draft check. */
  queued?: boolean;
}

async function flag(t: Db, ctx: ReplyContext, reason: FlagReason, now: Date): Promise<FlagReason | null> {
  return (await flagConversation(t, { conversationId: ctx.conversationId, reason, now })) ? reason : null;
}

/** `Re: <their subject>` unless it already starts with re:, on one line and cut to our subject limit. */
function replySubject(theirs: string): string {
  const line = theirs.replace(/\s+/g, ' ').trim();
  return (/^re:/i.test(line) ? line : `Re: ${line}`).slice(0, EMAIL_SUBJECT_MAX).trim();
}

const angled = (id: string): string => (id.startsWith('<') ? id : `<${id}>`);

/** Their References (the newest ids) then their Message-ID: the thread our answer continues. */
function answerReferences(r: ReadReply): string | null {
  const ids = [...r.referenceIds.map(angled), ...(r.messageId === null ? [] : [angled(r.messageId)])];
  return ids.length === 0 ? null : [...new Set(ids)].join(' ');
}

/**
 * Queues Sam's email in the seller's thread (`reply`, or the `holding` thank-you of a flag) unless the draft check
 * finds a problem with it; false when it was not queued. A practice answer goes at once, a real one in the seller's hours.
 */
async function queueAnswer(t: Db, deps: InboundDeps, ctx: ReplyContext, r: ReadReply, body: string, purpose: 'reply' | 'holding', now: Date): Promise<boolean> {
  const to = sellerAddress(ctx);
  const subject = replySubject(r.subject);
  if (to === null || draftIssues({ subject, body }).length > 0) return false;
  await queueEmail(t, {
    orgId: ctx.orgId,
    conversationId: ctx.conversationId,
    to,
    from: deps.cfg.EMAIL_FROM,
    subject,
    body,
    purpose,
    requestedBy: null,
    inReplyTo: r.messageId === null ? null : angled(r.messageId),
    references: answerReferences(r),
    sendAfter: ctx.practiceUserId !== null ? now : emailSendAt(phonesOf(ctx), now),
  });
  return true;
}

/**
 * Sam reads the reply and decides. Whatever she cannot do (no budget, no usable answer, a draft that fails the check)
 * goes to a person. The spend is charged on `deps.db`, outside the handling transaction.
 */
async function askSam(t: Db, deps: InboundDeps, writer: EmailWriter, ctx: ReplyContext, r: ReadReply, now: Date): Promise<Handled> {
  const context = await loadWriterContext(t, { orgId: ctx.orgId, crmRecordId: ctx.crmRecordId, conversationId: ctx.conversationId, now, companyName: deps.cfg.EMAIL_COMPANY_NAME });
  const result = await writeEmail(
    { db: deps.db, writer, orgId: ctx.orgId, settings: ctx.settings, now, signal: AbortSignal.timeout(REPLY_WRITER_TIMEOUT_MS), log: deps.log },
    { ...context, mode: 'reply', inbound: { subject: r.subject, text: r.body.slice(0, INBOUND_TEXT_MAX) } },
  );
  const base = { decision: 'ask_sam' as const };
  if (result.kind !== 'ok') return { ...base, writer: result.kind === 'failed' ? `failed:${result.reason}` : result.kind, flagged: await flag(t, ctx, 'unsure', now) };
  const d = result.decision;
  const said = { ...base, writer: `ok:${d.action}` };
  switch (d.action) {
    case 'send': {
      const queued = await queueAnswer(t, deps, ctx, r, d.body, 'reply', now);
      return { ...said, queued, flagged: queued ? null : await flag(t, ctx, 'draft_rejected', now) };
    }
    case 'flag': {
      // The thank-you goes only if it passes the check; the flag names Sam's reason either way (it says why a person is needed).
      const queued = d.body.trim() !== '' && (await queueAnswer(t, deps, ctx, r, d.body, 'holding', now));
      return { ...said, queued, flagged: await flag(t, ctx, d.flagReason ?? 'unsure', now) };
    }
    case 'opt_out':
    case 'not_interested':
      await stopSeller(t, { conversationId: ctx.conversationId, reason: d.action === 'opt_out' ? 'opted_out' : 'not_interested', now });
      return { ...said, flagged: null };
    case 'no_reply':
      return { ...said, flagged: null };
  }
}

async function act(t: Db, deps: InboundDeps, ctx: ReplyContext, r: ReadReply, decision: InboundDecision, now: Date): Promise<Handled> {
  switch (decision.kind) {
    case 'record_only':
      return { decision: decision.kind, flagged: null };
    case 'opt_out':
      await stopSeller(t, { conversationId: ctx.conversationId, reason: 'opted_out', now });
      return { decision: decision.kind, flagged: null };
    case 'flag':
      return { decision: decision.kind, flagged: await flag(t, ctx, decision.reason, now) };
    case 'ask_sam':
      // The decision already sent a reply with no writer to a person; this only keeps the types honest.
      if (deps.writer === null) return { decision: decision.kind, flagged: await flag(t, ctx, 'unsure', now) };
      return askSam(t, deps, deps.writer, ctx, r, now);
  }
}

/** Sent after the handling transaction committed; a failing alert is logged by name and never fails the event. */
async function raiseNeedsPerson(deps: InboundDeps, ctx: ReplyContext, reason: FlagReason): Promise<void> {
  const url = sellerPageUrl(deps.appPublicUrl, ctx.sfRecordId);
  try {
    await deps.alert({
      kind: 'seller_needs_person',
      severity: 'warning',
      orgId: ctx.orgId,
      message: `A seller's reply needs a person (${reason}). Seller: ${url}`,
      context: { conversationId: ctx.conversationId, emailId: ctx.emailId, reason, sellerUrl: url, ...(ctx.practiceUserId !== null ? { practice: true } : {}) },
    });
  } catch (err) {
    deps.log.error({ alert: 'seller_needs_person', emailId: ctx.emailId, ...describeError(err) }, 'seller_needs_person alert failed');
  }
}

/** Whether a stored reply that could not be locked is handled already (`done`) or held by another tick (`retry`). */
async function notLockedOutcome(db: Db, emailId: string): Promise<ReceivedOutcome> {
  const result = await db.execute(sql`select handled_at is not null as handled from email_messages where id = ${emailId}::uuid`);
  const row = rows<{ handled: boolean }>(result)[0];
  if (!row) return 'ignored'; // its conversation was deleted in between: nothing left to answer
  return row.handled ? 'done' : 'retry';
}

/**
 * One `email.received` event; `receivedAt` is when the route stored it (absent: a 404 is never waited for). `done`:
 * stored and handled (now or before). `ignored`: no email id, Resend will never return it, or it is not a reply to any
 * conversation of ours. `retry`: Resend could not answer now (or not yet), or another tick is handling this reply.
 * Throws on a database error, with nothing of the handling committed (the tick retries).
 */
export async function handleReceived(deps: InboundDeps, ev: { data: unknown; receivedAt?: Date }, now: Date): Promise<ReceivedOutcome> {
  const resendId = emailIdOf(ev.data);
  if (resendId === null) return 'ignored';
  const fetched = await fetchReceived(deps, resendId, ev.receivedAt, now);
  if (fetched.kind !== 'ok') return fetched.kind;
  const reply = readReply(fetched.email, deps.cfg.EMAIL_COMPANY_NAME);
  const thread = await findThread(deps.db, fetched.email, reply, deps.cfg.EMAIL_REPLY_DOMAIN);
  if (!thread) {
    deps.log.info({ resendId }, 'email.received: not a reply to any conversation; ignored');
    return 'ignored';
  }
  const stored = await storeReply(deps.db, thread, reply, now);
  const handled = await deps.db.transaction(async (tx) => {
    const t = asDb(tx);
    const ctx = await lockUnhandled(t, stored.id);
    if (!ctx) return null;
    const outcome = await act(t, deps, ctx, reply, await decide(t, deps, ctx, reply, thread.unsubscribe, now), now);
    await t.execute(sql`update email_messages set handled_at = ${iso(now)}, updated_at = ${iso(now)} where id = ${ctx.emailId}::uuid`);
    return { ctx, outcome };
  });
  if (!handled) return notLockedOutcome(deps.db, stored.id);
  const { ctx, outcome } = handled;
  deps.log.info(
    {
      resendId,
      emailId: ctx.emailId,
      conversationId: ctx.conversationId,
      decision: outcome.decision,
      ...(outcome.writer === undefined ? {} : { writer: outcome.writer }),
      ...(outcome.queued === undefined ? {} : { queued: outcome.queued }),
      ...(outcome.flagged === null ? {} : { flagged: outcome.flagged }),
    },
    'email.received: reply handled',
  );
  if (outcome.flagged) await raiseNeedsPerson(deps, ctx, outcome.flagged);
  return 'done';
}

/**
 * Sam's email outbox: what may be queued, and the rules the send tick applies the moment a queued email
 * is due. An email is one `email_messages` row (the outbox) tied to one timeline event (what the seller's
 * page shows); `queueEmail` writes both in one transaction and nothing else ever adds a second row for an
 * event.
 *
 * `sendBlock` is the last word before Resend. The gates are checked when the email is SENT, not when it
 * was queued, because an email can wait days (the seller's hours, a retry) and the seller may have opted
 * out, been taken over by a person or been emailed three times since. The order is the order the seller
 * page explains a block in; the first rule that applies wins. A PRACTICE email (an admin's own copy,
 * to their own address) skips the rules that protect the seller (2 to 9) and the seller's hours (the
 * admin is the recipient), but still obeys the tenant's switch and the daily cap. "Practice" has ONE
 * meaning everywhere: the conversation is a practice conversation (practice_user_id set), whatever the
 * email's purpose: Sam answers an admin's replies on a practice thread (`reply`, `holding`) exactly as on
 * a real one, and those emails are exempt and never logged to Salesforce too. `queueEmail` keeps the
 * purposes honest (see there). Warm leads only: a `first` email needs a call plan a person approved and
 * an open record when it is sent, not only when it was queued.
 *
 * Logs: none here. The tick logs ids and counts; no address, subject or text reaches a log line.
 */
import { sql } from 'drizzle-orm';
import { EMAIL_WINDOW, nextWindowOpening } from '@cti/firewall';
import type { EmailBlock } from '@cti/contracts';
import type { Db } from '@cti/db';
import { appendEvent, suppressionFor } from '../conversations/store.js';
import { nextLocalOpening, recipientTimezone } from '../planner/local-time.js';
import { samEmailSettings } from '../settings.js';

/** Sam sends one seller at most this many emails in any 24 hours (the loop guard catches whatever slips past it). */
export const EMAIL_DAILY_CAP = 3;
const DAY_MS = 24 * 60 * 60_000;

export type QueuePurpose = 'first' | 'reply' | 'holding' | 'practice';
/** `sendBlock`'s answer: why not, or `outside_window` (not a refusal: the email waits for the seller's morning). */
export type SendBlock = EmailBlock | 'outside_window';

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const iso = (d: Date) => sql`${d.toISOString()}::timestamptz`;

export interface QueueEmailInput {
  orgId: string;
  conversationId: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  purpose: QueuePurpose;
  /** The person who pressed Send; null when Sam sends on her own. */
  requestedBy: string | null;
  /** Message-ID of the message being answered; null on a first email. */
  inReplyTo: string | null;
  references: string | null;
  sendAfter: Date;
  /** The touch that queued it (the automatic follow-up rhythm); null for a person's Send or a reply. */
  touchId?: string | null;
}

/**
 * The email and its timeline event, together. The event is Sam's, outbound, and not yet logged to
 * Salesforce (the send turns that on once Resend has accepted it, so a canceled or failed email never
 * leaves a Task). A conversation of another tenant (or none) throws and writes nothing, and so does a
 * purpose that does not fit the conversation: `practice` (an admin's test of Sam's first email) never goes
 * on a real conversation, and `first` never on a practice one. `reply` and `holding` go on either.
 */
export async function queueEmail(db: Db, i: QueueEmailInput): Promise<{ emailId: string; eventId: string }> {
  return db.transaction(async (tx) => {
    const conversation = rows<{ practiceUserId: string | null }>(
      await tx.execute(sql`
        select practice_user_id as "practiceUserId" from seller_conversations
        where id = ${i.conversationId}::uuid and org_id = ${i.orgId}::uuid`),
    )[0];
    if (!conversation) throw new Error(`conversation ${i.conversationId} not found`);
    if (conversation.practiceUserId !== null ? i.purpose === 'first' : i.purpose === 'practice') {
      throw new Error(`purpose ${i.purpose} does not fit conversation ${i.conversationId}`);
    }
    const eventId = await appendEvent(tx as unknown as Db, {
      orgId: i.orgId,
      conversationId: i.conversationId,
      kind: 'email',
      direction: 'out',
      actor: 'sam',
      subject: i.subject,
      body: i.body,
      sfLog: false,
    });
    const result = await tx.execute(sql`
      insert into email_messages
        (org_id, conversation_id, event_id, direction, status, purpose, to_address, from_address, in_reply_to, "references", send_after, touch_id, requested_by)
      values
        (${i.orgId}::uuid, ${i.conversationId}::uuid, ${eventId}::uuid, 'out', 'queued', ${i.purpose}, ${i.to}, ${i.from}, ${i.inReplyTo}, ${i.references},
         ${iso(i.sendAfter)}, ${i.touchId ?? null}::uuid, ${i.requestedBy}::uuid)
      returning id`);
    const emailId = rows<{ id: string }>(result)[0]?.id;
    if (!emailId) throw new Error('email row missing after insert');
    return { emailId, eventId };
  });
}

/**
 * `queueEmail`, unless the conversation already has an outbound email `queued` or `sending` (`already_queued`). The
 * conversation row is locked first (FOR UPDATE, in this transaction), so two requests at once are taken one after
 * the other and the second sees the first's email: a double click on Send never queues two. Once the email is out
 * (sent or later), another may be queued.
 */
export async function queueEmailOnce(db: Db, i: QueueEmailInput): Promise<{ emailId: string; eventId: string } | 'already_queued'> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const locked = await t.execute(sql`
      select id from seller_conversations where id = ${i.conversationId}::uuid and org_id = ${i.orgId}::uuid for update`);
    if (rows<{ id: string }>(locked).length === 0) throw new Error(`conversation ${i.conversationId} not found`);
    const pending = await t.execute(sql`
      select id from email_messages
      where conversation_id = ${i.conversationId}::uuid and org_id = ${i.orgId}::uuid and direction = 'out' and status in ('queued', 'sending')
      limit 1`);
    if (rows<{ id: string }>(pending).length > 0) return 'already_queued';
    return queueEmail(t, i);
  });
}

/**
 * When a seller may first be emailed: now when it is already 08:00 to 18:00 where they are (their first
 * phone's zone and state rules), else the next opening. With no phone at all, Central time, the dialer's
 * own fallback. Also the tick's answer when a due email turns out to be outside the hours.
 */
export function emailSendAt(phones: ReadonlyArray<{ e164: string }>, now: Date): Date {
  const first = phones[0];
  return first ? nextWindowOpening(first.e164, now, EMAIL_WINDOW) : nextLocalOpening(now, recipientTimezone(null), EMAIL_WINDOW);
}

/** The `{ e164 }` entries of a stored `phones` value (crm_records.phones jsonb); anything else is dropped. */
export function phonesOf(value: unknown): Array<{ e164: string }> {
  return Array.isArray(value) ? value.filter((p): p is { e164: string } => typeof (p as { e164?: unknown } | null)?.e164 === 'string') : [];
}

/**
 * A person approved a call plan for this record on any of its AI call enrollments (call_plans.status `approved` is
 * only ever set by a person's decision, call-plans/decisions.ts). Any enrollment counts, not only the newest: an
 * approval is the warm-lead proof, whichever campaign it was made on.
 */
export async function hasApprovedPlan(db: Db, orgId: string, crmRecordId: string): Promise<boolean> {
  const result = await db.execute(sql`
    select exists (
      select 1 from campaign_enrollments e
      join campaigns c on c.id = e.campaign_id and c.org_id = e.org_id and c.mode = 'ai_call'
      join call_plans p on p.enrollment_id = e.id and p.org_id = e.org_id and p.status = 'approved'
      where e.org_id = ${orgId}::uuid and e.crm_record_id = ${crmRecordId}::uuid
    ) as approved`);
  return rows<{ approved: boolean }>(result)[0]?.approved === true;
}

interface SendFacts {
  orgId: string;
  conversationId: string;
  crmRecordId: string;
  purpose: string;
  toAddress: string;
  conversationStatus: string;
  handler: string;
  flagReason: string | null;
  practiceUserId: string | null;
  settings: unknown;
  sfEmailOptOut: boolean;
  isClosed: boolean;
  phones: Array<{ e164: string }>;
}

/** The email, its conversation, the tenant's settings and the seller's record, in one read scoped to the email's own tenant. */
async function loadFacts(db: Db, emailId: string): Promise<SendFacts> {
  const result = await db.execute(sql`
    select m.org_id as "orgId", m.conversation_id as "conversationId", c.crm_record_id as "crmRecordId", m.purpose, m.to_address as "toAddress",
           c.status as "conversationStatus", c.handler, c.flag_reason as "flagReason", c.practice_user_id as "practiceUserId",
           o.settings, coalesce(r.sf_email_opt_out, false) as "sfEmailOptOut", coalesce(r.is_closed, false) as "isClosed",
           coalesce(r.phones, '[]'::jsonb) as phones
    from email_messages m
    join seller_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    join organizations o on o.id = m.org_id
    left join crm_records r on r.id = c.crm_record_id and r.org_id = c.org_id
    where m.id = ${emailId}::uuid and m.direction = 'out'`);
  const facts = rows<Omit<SendFacts, 'phones'> & { phones: unknown }>(result)[0];
  if (!facts) throw new Error(`email message not found: ${emailId}`);
  return { ...facts, phones: phonesOf(facts.phones) };
}

/** Rule 1, pure: the tenant's switch (`organizations.settings` as stored). */
export function switchBlock(settings: unknown): 'disabled' | 'paused' | null {
  const s = samEmailSettings({ settings });
  if (!s.enabled) return 'disabled';
  return s.pausedAt !== null ? 'paused' : null;
}

/** What rules 2 to 9 read: the warm-lead facts, the conversation (open / Sam / no flag when there is none yet), the address and the record. */
export interface SellerFacts {
  purpose: string;
  /** A person approved a call plan for the seller (`hasApprovedPlan`); read for a `first` email only. */
  approved: boolean;
  /** crm_records.is_closed; read for a `first` email only. */
  closed: boolean;
  conversationStatus: string;
  handler: string;
  flagReason: string | null;
  /** The address is on the tenant's suppression list (`suppressionFor`). */
  suppressed: boolean;
  sfEmailOptOut: boolean;
}

/**
 * Rules 2 to 9, pure: what protects the seller. The send tick applies it to a due email; the seller page applies
 * it, as purpose `first`, to an email nobody has written yet, so the page's reason and the tick's never disagree.
 * Warm leads only: a first email needs an approved plan and an open record, checked again when it is due (a plan
 * rejected or a record closed while it waited cancels it). A reply or holding email answers the seller and needs
 * neither.
 */
export function sellerBlock(f: SellerFacts): EmailBlock | null {
  if (f.purpose === 'first' && !f.approved) return 'not_approved';
  if (f.purpose === 'first' && f.closed) return 'closed';
  if (f.conversationStatus === 'stopped') return 'stopped';
  if (f.conversationStatus === 'booked' && f.purpose !== 'holding') return 'booked';
  if (f.handler === 'person') return 'taken_over';
  if (f.flagReason !== null && (f.purpose === 'first' || f.purpose === 'reply')) return 'flagged';
  if (f.suppressed) return 'suppressed';
  if (f.sfEmailOptOut) return 'sf_opt_out';
  return null;
}

/**
 * The conversation's outbound emails that are out or on their way (sending, sent, delivered) in the 24 hours before
 * `now`. `exceptEmailId` leaves one row out: the send tick's own row, `sending` by the time it is checked, never counts
 * against itself. The daily cap here and the reply loop guard (email/inbound.ts) count the same way.
 */
export async function emailsOutInLastDay(db: Db, i: { orgId: string; conversationId: string; exceptEmailId?: string }, now: Date): Promise<number> {
  const result = await db.execute(sql`
    select count(*)::int as n from email_messages
    where conversation_id = ${i.conversationId}::uuid and org_id = ${i.orgId}::uuid and direction = 'out'
      ${i.exceptEmailId === undefined ? sql`` : sql`and id <> ${i.exceptEmailId}::uuid`}
      and status in ('sending', 'sent', 'delivered')
      and coalesce(sent_at, claimed_at, created_at) > ${iso(new Date(now.getTime() - DAY_MS))}`);
  return rows<{ n: number }>(result)[0]?.n ?? 0;
}

async function firstBlock(db: Db, f: SendFacts, emailId: string, now: Date): Promise<SendBlock | null> {
  const off = switchBlock(f.settings);
  if (off) return off;
  const practice = f.practiceUserId !== null;
  if (!practice) {
    const held = sellerBlock({
      ...f,
      // Only a first email needs the approval, so no other purpose pays for the read.
      approved: f.purpose !== 'first' || (await hasApprovedPlan(db, f.orgId, f.crmRecordId)),
      closed: f.isClosed,
      suppressed: (await suppressionFor(db, f.orgId, f.toAddress)) !== null,
    });
    if (held) return held;
  }
  if ((await emailsOutInLastDay(db, { orgId: f.orgId, conversationId: f.conversationId, exceptEmailId: emailId }, now)) >= EMAIL_DAILY_CAP) return 'daily_cap';
  // A practice email goes to the admin, not the seller: the seller's hours do not apply to it.
  if (practice) return null;
  return emailSendAt(f.phones, now).getTime() > now.getTime() ? 'outside_window' : null;
}

/** The block and the seller's phones it was judged on (the tick needs them again to place an `outside_window` email). */
export async function evaluateSend(db: Db, emailId: string, now: Date): Promise<{ block: SendBlock | null; phones: Array<{ e164: string }> }> {
  const facts = await loadFacts(db, emailId);
  return { block: await firstBlock(db, facts, emailId, now), phones: facts.phones };
}

/**
 * Why this queued or claimed email must not go out right now, or null when it may. In order:
 *  1. the tenant's Sam email is off (`disabled`) or paused (`paused`);
 *  2. a `first` email whose seller has no call plan a person approved (`not_approved`);
 *  3. a `first` email to a closed record (`closed`);
 *  4. the conversation is `stopped`;  5. it is `booked` and this is not a `holding` email;
 *  6. a person has taken over;  7. a person is needed (a flag) and this is a `first` or `reply`;
 *  8. the address is suppressed;  9. Salesforce says Email Opt Out;
 * 10. the conversation already had 3 other emails out in the last 24 hours (`daily_cap`);
 * 11. it is outside the seller's 08:00 to 18:00 (`outside_window`: wait, do not cancel).
 * Rules 2 to 9 and 11 do not apply to an email on a practice conversation (whatever its purpose): it goes to the
 * admin. Throws for an email that does not exist.
 */
export async function sendBlock(db: Db, emailId: string, now: Date): Promise<SendBlock | null> {
  return (await evaluateSend(db, emailId, now)).block;
}

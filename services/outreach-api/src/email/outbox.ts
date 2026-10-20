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
 * to their own address) skips the rules that protect the seller (2 to 7) but still obeys the tenant's
 * switch, the daily cap and the hours. "Practice" has ONE meaning everywhere: the conversation is a
 * practice conversation (practice_user_id set), whatever the email's purpose: Sam answers an admin's
 * replies on a practice thread (`reply`, `holding`) exactly as on a real one, and those emails are exempt
 * and never logged to Salesforce too. `queueEmail` keeps the purposes honest (see there).
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
 * When a seller may first be emailed: now when it is already 08:00 to 18:00 where they are (their first
 * phone's zone and state rules), else the next opening. With no phone at all, Central time, the dialer's
 * own fallback. Also the tick's answer when a due email turns out to be outside the hours.
 */
export function emailSendAt(phones: ReadonlyArray<{ e164: string }>, now: Date): Date {
  const first = phones[0];
  return first ? nextWindowOpening(first.e164, now, EMAIL_WINDOW) : nextLocalOpening(now, recipientTimezone(null), EMAIL_WINDOW);
}

interface SendFacts {
  orgId: string;
  conversationId: string;
  purpose: string;
  toAddress: string;
  conversationStatus: string;
  handler: string;
  flagReason: string | null;
  practiceUserId: string | null;
  settings: unknown;
  sfEmailOptOut: boolean;
  phones: Array<{ e164: string }>;
}

/** The email, its conversation, the tenant's settings and the seller's record, in one read scoped to the email's own tenant. */
async function loadFacts(db: Db, emailId: string): Promise<SendFacts> {
  const result = await db.execute(sql`
    select m.org_id as "orgId", m.conversation_id as "conversationId", m.purpose, m.to_address as "toAddress",
           c.status as "conversationStatus", c.handler, c.flag_reason as "flagReason", c.practice_user_id as "practiceUserId",
           o.settings, coalesce(r.sf_email_opt_out, false) as "sfEmailOptOut", coalesce(r.phones, '[]'::jsonb) as phones
    from email_messages m
    join seller_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    join organizations o on o.id = m.org_id
    left join crm_records r on r.id = c.crm_record_id and r.org_id = c.org_id
    where m.id = ${emailId}::uuid and m.direction = 'out'`);
  const facts = rows<Omit<SendFacts, 'phones'> & { phones: unknown }>(result)[0];
  if (!facts) throw new Error(`email message not found: ${emailId}`);
  const phones = Array.isArray(facts.phones) ? facts.phones.filter((p): p is { e164: string } => typeof (p as { e164?: unknown } | null)?.e164 === 'string') : [];
  return { ...facts, phones };
}

/** Rules 2 to 5: what the conversation itself says. */
function conversationBlock(f: SendFacts): EmailBlock | null {
  if (f.conversationStatus === 'stopped') return 'stopped';
  if (f.conversationStatus === 'booked' && f.purpose !== 'holding') return 'booked';
  if (f.handler === 'person') return 'taken_over';
  if (f.flagReason !== null && (f.purpose === 'first' || f.purpose === 'reply')) return 'flagged';
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
  const switchSettings = samEmailSettings({ settings: f.settings });
  if (!switchSettings.enabled) return 'disabled';
  if (switchSettings.pausedAt !== null) return 'paused';
  if (f.practiceUserId === null) {
    const held = conversationBlock(f);
    if (held) return held;
    if ((await suppressionFor(db, f.orgId, f.toAddress)) !== null) return 'suppressed';
    if (f.sfEmailOptOut) return 'sf_opt_out';
  }
  if ((await emailsOutInLastDay(db, { orgId: f.orgId, conversationId: f.conversationId, exceptEmailId: emailId }, now)) >= EMAIL_DAILY_CAP) return 'daily_cap';
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
 *  2. the conversation is `stopped`;  3. it is `booked` and this is not a `holding` email;
 *  4. a person has taken over;  5. a person is needed (a flag) and this is a `first` or `reply`;
 *  6. the address is suppressed;  7. Salesforce says Email Opt Out;
 *  8. the conversation already had 3 other emails out in the last 24 hours (`daily_cap`);
 *  9. it is outside the seller's 08:00 to 18:00 (`outside_window`: wait, do not cancel).
 * Rules 2 to 7 do not apply to an email on a practice conversation (whatever its purpose). Throws for an email that does not exist.
 */
export async function sendBlock(db: Db, emailId: string, now: Date): Promise<SendBlock | null> {
  return (await evaluateSend(db, emailId, now)).block;
}

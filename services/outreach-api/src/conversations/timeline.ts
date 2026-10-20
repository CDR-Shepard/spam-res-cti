/**
 * One seller's timeline: what the seller's page lists and what Sam's history digest is made from. It merges
 * two sources into one list, oldest first:
 *  - the conversation's own events (emails, hand-overs, status changes, flags), joined to email_messages for an
 *    email's status, whether it is an auto-reply and, for a canceled one, why it did not go. An email from an address
 *    other than the seller's (meta.otherSender) also says so (`otherSender: true`, a HistoryItem): the history digest
 *    leaves it out, and the seller page drops the key (forPage) and shows the email as it is;
 *  - every real AI call (not `is_test`) placed from one of the record's enrollments, reached through
 *    touches.ai_call_id. Calls are never copied into the conversation, so they cannot go stale or be written
 *    twice; a call shows from the moment its row exists, with outcome / summary / duration null until it has them.
 *
 * A PRACTICE conversation (an admin's own copy of Sam's email) lists only its own events: the seller's calls
 * belong to the real thread, and a practice page must not look like them.
 *
 * Event kinds with no timeline shape yet (texts, human touches, free notes) are not listed. Read-only, scoped by
 * tenant and record in every statement, and no log line here carries seller text (it writes none).
 */
import { sql } from 'drizzle-orm';
import { EmailBlock, EmailStatus, AiCallOutcome, type TimelineItem } from '@cti/contracts';
import type { Db } from '@cti/db';
import type { HistoryItem } from './digest.js';

/** How many of the newest items a timeline read returns unless the caller asks for another number. */
export const DEFAULT_TIMELINE_LIMIT = 200;

const rows = <T>(r: unknown): T[] => (r as { rows: T[] }).rows;
const isoOf = (at: Date | string): string => new Date(at).toISOString();

interface EventRow {
  id: string;
  kind: 'email' | 'handler' | 'status' | 'flag';
  direction: string;
  actor: string;
  at: Date | string;
  subject: string | null;
  body: string | null;
  detail: string | null;
  autoReply: boolean;
  otherSender: boolean;
  emailStatus: string | null;
  lastError: string | null;
  byName: string | null;
}

interface CallRow {
  id: string;
  at: Date | string;
  outcome: string | null;
  summary: string | null;
  durationSeconds: number | null;
  transcriptAvailable: boolean;
}

/** A conversation event's rows, newest first (so the limit keeps the newest), scoped to this tenant and record. */
async function eventRows(db: Db, i: { orgId: string; crmRecordId: string; conversationId: string; limit: number }): Promise<EventRow[]> {
  const result = await db.execute(sql`
    select ce.id, ce.kind, ce.direction, ce.actor, ce.occurred_at as "at", ce.subject, ce.body, ce.detail,
           coalesce(ce.meta -> 'autoReply' = 'true'::jsonb, false) as "autoReply",
           coalesce(ce.meta -> 'otherSender' = 'true'::jsonb, false) as "otherSender",
           em.status as "emailStatus", em.last_error as "lastError",
           coalesce(nullif(btrim(u.display_name), ''), nullif(split_part(u.email, '@', 1), '')) as "byName"
    from conversation_events ce
    join seller_conversations sc on sc.id = ce.conversation_id and sc.org_id = ${i.orgId}::uuid and sc.crm_record_id = ${i.crmRecordId}::uuid
    left join email_messages em on em.event_id = ce.id and em.org_id = ce.org_id
    left join users u on u.id = ce.user_id and u.org_id = ce.org_id
    where ce.conversation_id = ${i.conversationId}::uuid and ce.org_id = ${i.orgId}::uuid
      and ((ce.kind = 'email' and em.id is not null) or ce.kind in ('handler', 'status', 'flag'))
    order by ce.occurred_at desc, ce.created_at desc, ce.id desc
    limit ${i.limit}`);
  return rows<EventRow>(result);
}

/**
 * The record's real calls, newest first. `conversationId` is the conversation being read (null = none yet): a
 * practice one (practice_user_id set) gets no calls.
 */
async function callRows(
  db: Db,
  i: { orgId: string; crmRecordId: string; conversationId: string | null; limit: number },
): Promise<CallRow[]> {
  const notPractice =
    i.conversationId === null
      ? sql``
      : sql`and not exists (
          select 1 from seller_conversations pc
          where pc.id = ${i.conversationId}::uuid and pc.org_id = a.org_id and pc.practice_user_id is not null)`;
  const result = await db.execute(sql`
    select a.id, coalesce(a.started_at, a.created_at) as "at", a.outcome, a.summary, a.duration_seconds as "durationSeconds",
           case when jsonb_typeof(a.transcript) = 'array' then jsonb_array_length(a.transcript) > 0 else false end as "transcriptAvailable"
    from ai_calls a
    where a.org_id = ${i.orgId}::uuid and a.is_test = false
      and exists (
        select 1 from touches t
        join campaign_enrollments e on e.id = t.enrollment_id and e.org_id = t.org_id
        where t.ai_call_id = a.id and t.org_id = a.org_id and e.crm_record_id = ${i.crmRecordId}::uuid)
      ${notPractice}
    order by coalesce(a.started_at, a.created_at) desc, a.id desc
    limit ${i.limit}`);
  return rows<CallRow>(result);
}

function callItem(row: CallRow): TimelineItem {
  const outcome = AiCallOutcome.safeParse(row.outcome);
  return {
    type: 'call',
    id: row.id,
    at: isoOf(row.at),
    outcome: outcome.success ? outcome.data : null,
    summary: row.summary,
    durationSeconds: row.durationSeconds,
    transcriptAvailable: row.transcriptAvailable,
  };
}

/** Why a canceled email did not go: last_error, when it names one of the reasons the contract knows; null otherwise. */
function notSentReason(status: string, lastError: string | null): EmailBlock | null {
  if (status !== 'canceled') return null;
  const reason = EmailBlock.safeParse(lastError);
  return reason.success ? reason.data : null;
}

function eventItem(row: EventRow): HistoryItem {
  if (row.kind !== 'email') {
    return { type: 'note', id: row.id, at: isoOf(row.at), kind: row.kind, detail: row.detail ?? '', byName: row.byName };
  }
  // The query keeps only emails that have an email_messages row, so the status is there.
  const status = EmailStatus.parse(row.emailStatus);
  return {
    type: 'email',
    id: row.id,
    at: isoOf(row.at),
    direction: row.direction === 'in' ? 'in' : 'out',
    // An email is Sam's, the seller's or a person's; the system's own mail is Sam's.
    actor: row.actor === 'seller' || row.actor === 'person' ? row.actor : 'sam',
    subject: row.subject ?? '',
    body: row.body ?? '',
    status,
    autoReply: row.autoReply,
    notSentReason: notSentReason(status, row.lastError),
    ...(row.otherSender ? { otherSender: true as const } : {}),
  };
}

/** Items as the seller page's contract has them: the server-only `otherSender` key dropped (the page shows the email as it is). */
export function forPage(items: readonly HistoryItem[]): TimelineItem[] {
  return items.map((item) => {
    if (item.type !== 'email' || item.otherSender === undefined) return item;
    const { otherSender: _otherSender, ...email } = item;
    return email;
  });
}

/**
 * The newest `limit` items of the seller's timeline, oldest first. `conversationId` null = the seller has no
 * conversation yet (the calls alone). A conversation of another tenant or record reads no events. At the same
 * instant an event comes before a call, and events keep the order they were written in.
 */
export async function readTimeline(
  db: Db,
  i: { orgId: string; crmRecordId: string; conversationId: string | null; limit?: number },
): Promise<HistoryItem[]> {
  const limit = Math.max(1, Math.trunc(i.limit ?? DEFAULT_TIMELINE_LIMIT));
  const events = i.conversationId === null ? [] : await eventRows(db, { orgId: i.orgId, crmRecordId: i.crmRecordId, conversationId: i.conversationId, limit });
  const calls = await callRows(db, { orgId: i.orgId, crmRecordId: i.crmRecordId, conversationId: i.conversationId, limit });
  // Each source is newest first; reversed and concatenated, a stable sort by time keeps events before calls on a tie.
  const items = [...events.reverse().map(eventItem), ...calls.reverse().map(callItem)];
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-limit);
}

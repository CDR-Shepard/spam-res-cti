/**
 * Plan 1D: the last real two-way contact with a lead, from the research snapshot, and how long ago it was in words
 * the voice agent may say ("back in February"). The words never carry a digit (CF-14).
 *
 * Real contact is a call Task with evidence that a person was reached, a past meeting Event, or an inbound email.
 * Notes, Chatter and outbound email are one-way and do not count.
 *
 * Fix 1 (I-1): most call Tasks are dials nobody answered ("Outbound Call | No answer | …", "VoiceMail Drop | <rep>",
 * "CallRail Recording" of a missed call). A call Task counts only with positive evidence:
 *  - its CallDisposition, or the disposition part of a CTI subject, is one of CONNECTED_DISPOSITIONS; or
 *  - it lasted at least MIN_TALK_SECONDS (CallDurationInSeconds), which is how an inbound call with no disposition
 *    and a CallRail recording count;
 * and never when the disposition, the subject's head or its disposition part says nobody was reached (NEVER_CONTACT),
 * or the caller was anonymous. An "AI call: …" Task (cti-api ai-voice/sf-logging) counts only when its outcome was a
 * conversation (AI_CONVERSATION) and its CallDisposition says a person was reached: the open callback to-do Tasks it
 * also writes carry no disposition, and "Hung up" is a pick-up that ended within seconds.
 */
import type { ResearchSnapshot } from './snapshot.js';

export interface LastContact {
  at: Date;
  kind: 'call' | 'meeting' | 'email';
}

/** The wrap-up dispositions that mean a person was reached (cti-web WrapupForm DISPOSITIONS), lower-cased. */
export const CONNECTED_DISPOSITIONS: ReadonlySet<string> = new Set(['connected', 'call back', 'do not call']);
/** A call Task with no positive disposition counts only when it lasted this long. */
export const MIN_TALK_SECONDS = 60;
/** Nobody was reached: never contact, whatever the duration. */
export const NEVER_CONTACT =
  /no answer|voice ?mail|left (?:a )?(?:message|vm)|\bl?vm\b|busy|wrong number|bad number|disconnected|not in service|no contact|did not connect|unreachable|not dispositioned|\bfailed\b|blocked|missed|abandoned|hung up/i;
/** An "AI call: <outcome words>" subject whose outcome was a conversation (cti-api ai-voice/outcomes.ts OUTCOME_WORDS). */
const AI_CONVERSATION = /^ai call:\s*(?:transferred to rep|callback requested|not interested|do not call|transfer missed|appointment set)\b/i;
const AI_CALL = /^ai call\b/i;
/** Subjects only a call Task has, for a Task read without TaskSubtype or CallType. */
const CALL_SUBJECT = /^(?:(?:inbound|outbound) call|callrail recording|voice ?mail drop|missed call|outgoing)\b/i;
/** cti-api's buildCallSubject: "<Inbound|Outbound> Call | <disposition> | <who>"; an inbound call may have no disposition part. */
const CTI_SUBJECT = /^(?:inbound|outbound) call \| /i;
const MEETING = /consult|appointment|walk|meeting|visit/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

type Item = ResearchSnapshot['activity'][number];

const dateOf = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * M-8: a Task's ActivityDate is the day the call happened; CreatedDate is when it was logged, which may be later. The
 * date-only value is read at noon UTC, which is that same calendar day in every US zone. A due date after the Task was
 * created is a to-do date, not the call's, so the earlier of the two wins.
 */
function taskDate(i: Item): Date | null {
  const created = dateOf(i.at);
  const due = i.meta.due && DATE_ONLY.test(i.meta.due) ? dateOf(`${i.meta.due}T12:00:00.000Z`) : null;
  if (due && (!created || due < created)) return due;
  return created;
}

const isCallTask = (i: Item, title: string): boolean =>
  i.meta.kind === 'Call' || Boolean(i.meta.callType) || CALL_SUBJECT.test(title) || AI_CALL.test(title);

const lower = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();

/** Did this call Task reach a person? */
function reachedSomeone(i: Item, title: string): boolean {
  const disposition = i.meta.disposition ?? null;
  if (AI_CALL.test(title)) return AI_CONVERSATION.test(title) && CONNECTED_DISPOSITIONS.has(lower(disposition));
  const parts = title.split('|').map((p) => p.trim());
  const segment = CTI_SUBJECT.test(title) && parts.length >= 3 ? (parts[1] ?? null) : null;
  // Only the head and the disposition part of a subject are read: the rest is a phone number and a record name.
  const said = [disposition, parts[0] ?? '', segment].filter((s): s is string => Boolean(s));
  if (said.some((s) => NEVER_CONTACT.test(s)) || parts.some((p) => lower(p) === 'anonymous')) return false;
  if (CONNECTED_DISPOSITIONS.has(lower(disposition)) || CONNECTED_DISPOSITIONS.has(lower(segment))) return true;
  const seconds = Number(i.meta.seconds);
  return i.meta.seconds !== undefined && Number.isFinite(seconds) && seconds >= MIN_TALK_SECONDS;
}

function contactOf(i: Item, now: Date): LastContact | null {
  switch (i.source) {
    case 'task': {
      const title = (i.title ?? '').trim();
      if (!isCallTask(i, title) || !reachedSomeone(i, title)) return null;
      const at = taskDate(i);
      return at && at <= now ? { at, kind: 'call' } : null;
    }
    case 'event': {
      const starts = dateOf(i.meta.starts);
      return starts && starts < now && MEETING.test(i.title ?? '') ? { at: starts, kind: 'meeting' } : null;
    }
    case 'email': {
      const at = dateOf(i.at);
      return at && i.meta.direction === 'inbound' ? { at, kind: 'email' } : null;
    }
    default:
      return null;
  }
}

/** The newest real two-way contact in the snapshot's activity, or null. */
export function lastRealContact(s: ResearchSnapshot, now: Date): LastContact | null {
  let newest: LastContact | null = null;
  for (const item of s.activity) {
    const c = contactOf(item, now);
    if (c && (!newest || c.at > newest.at)) newest = c;
  }
  return newest;
}

/** The calendar day of `d` in `timeZone`, as a UTC midnight timestamp, so two days subtract to whole days. */
function dayNumber(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(part('year'), part('month') - 1, part('day')) / DAY_MS;
}

/** Words with no digits: "earlier this week", "last week", "back in February", "about a year ago", "about two years ago", "a few years ago". */
export function contactWords(at: Date, now: Date, timeZone = 'America/Los_Angeles'): string {
  const days = dayNumber(now, timeZone) - dayNumber(at, timeZone);
  if (days < 7) return 'earlier this week';
  if (days < 14) return 'last week';
  if (days < 330) return `back in ${new Intl.DateTimeFormat('en-US', { timeZone, month: 'long' }).format(at)}`;
  if (days < 548) return 'about a year ago';
  if (days < 913) return 'about two years ago';
  return 'a few years ago';
}

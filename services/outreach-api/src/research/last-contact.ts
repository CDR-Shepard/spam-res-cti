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
 *  - it lasted at least MIN_TALK_SECONDS (CallDurationInSeconds) and either says "Call back" or has no disposition and
 *    was not inbound (final review: "Call back" alone, and a long inbound recording, are often no conversation — the
 *    latter the seller's own voicemail);
 * and never when the disposition, the subject's head or its disposition part says nobody was reached (NEVER_CONTACT),
 * or the caller was anonymous. An "AI call: …" Task (cti-api ai-voice/sf-logging) counts only when its outcome was a
 * conversation (AI_CONVERSATION) and its CallDisposition says a person was reached: the open callback to-do Tasks it
 * also writes carry no disposition, and "Hung up" is a pick-up that ended within seconds.
 */
import { AI_CALL_SUBJECT as AI_CALL, AI_CONVERSATION_SUBJECT as AI_CONVERSATION, ctiSubjectDisposition } from '@cti/contracts';
import type { ResearchSnapshot } from './snapshot.js';

export interface LastContact {
  at: Date;
  kind: 'call' | 'meeting' | 'email';
}

/** The wrap-up dispositions that mean a person was reached (cti-web WrapupForm DISPOSITIONS), lower-cased. */
export const CONNECTED_DISPOSITIONS: ReadonlySet<string> = new Set(['connected', 'do not call']);
/**
 * Final review (OUT minor 3): reps also pick "Call back" when someone else answered or asked them to try later, so on
 * its own it is no evidence; with a real conversation's length (MIN_TALK_SECONDS) it counts.
 */
const CALL_BACK = 'call back';
/** A call Task with no positive disposition counts only when it lasted this long (and, with no disposition, was not inbound). */
export const MIN_TALK_SECONDS = 60;
/** Nobody was reached: never contact, whatever the duration. */
export const NEVER_CONTACT =
  /no answer|voice ?mail|left (?:a )?(?:message|vm)|\bl?vm\b|busy|wrong number|bad number|disconnected|not in service|no contact|did not connect|unreachable|not dispositioned|\bfailed\b|blocked|missed|abandoned|hung up/i;
/** Subjects only a call Task has, for a Task read without TaskSubtype or CallType. */
const CALL_SUBJECT = /^(?:(?:inbound|outbound) call|callrail recording|voice ?mail drop|missed call|outgoing)\b/i;
const MEETING = /consult|appointment|walk|meeting|visit/i;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

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
  // The subject readers live in @cti/contracts, where cti-api's tests run them over what it writes (sweep D-13).
  const segment = ctiSubjectDisposition(title);
  // Only the head and the disposition part of a subject are read: the rest is a phone number and a record name.
  const said = [disposition, parts[0] ?? '', segment].filter((s): s is string => Boolean(s));
  if (said.some((s) => NEVER_CONTACT.test(s)) || parts.some((p) => lower(p) === 'anonymous')) return false;
  if (CONNECTED_DISPOSITIONS.has(lower(disposition)) || CONNECTED_DISPOSITIONS.has(lower(segment))) return true;
  const seconds = Number(i.meta.seconds);
  if (i.meta.seconds === undefined || !Number.isFinite(seconds) || seconds < MIN_TALK_SECONDS) return false;
  if (lower(disposition) === CALL_BACK || lower(segment) === CALL_BACK) return true;
  // No disposition: a long inbound recording is often the seller's own voicemail (final review OUT minor 3).
  return !mayBeInbound(i, title);
}

/** An inbound call, or a CallRail recording whose direction is not known to be outbound. */
function mayBeInbound(i: Item, title: string): boolean {
  const type = lower(i.meta.callType);
  return type === 'inbound' || /^inbound call\b/i.test(title) || (/^callrail recording\b/i.test(title) && type !== 'outbound');
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

/**
 * The newest real two-way contact in the snapshot's activity and its targeted contact read (final review OUT I-1: a
 * connect behind many newer dials, or archived after a year), or null.
 */
export function lastRealContact(s: ResearchSnapshot, now: Date): LastContact | null {
  let newest: LastContact | null = null;
  for (const item of [...s.activity, ...(s.contacts ?? [])]) {
    const c = contactOf(item, now);
    if (c && (!newest || c.at > newest.at)) newest = c;
  }
  return newest;
}

/** Fix 1 (M-4): the words live in @cti/contracts, so the web's card and the agent's plan text say them the same way. */
export { contactWords } from '@cti/contracts';

/**
 * Plan 1D: the last real two-way contact with a lead, from the research snapshot, and how long ago it was in words
 * the voice agent may say ("back in February"). The words never carry a digit (CF-14).
 *
 * Real contact is a connected call Task (never our own "AI call" Tasks), a past meeting Event, or an inbound email.
 * Notes, Chatter and outbound email are one-way and do not count.
 */
import type { ResearchSnapshot } from './snapshot.js';

export interface LastContact {
  at: Date;
  kind: 'call' | 'meeting' | 'email';
}

export const NO_CONTACT = /no answer|voicemail|left (?:a )?(?:message|vm)|\bvm\b|busy|wrong number|disconnected|not in service|no contact|did not connect|unreachable/i;
const MEETING = /consult|appointment|walk|meeting|visit/i;
const AI_CALL = /^ai call/i;
const DAY_MS = 86_400_000;

type Item = ResearchSnapshot['activity'][number];

const dateOf = (s: string | null | undefined): Date | null => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

function contactOf(i: Item, now: Date): LastContact | null {
  switch (i.source) {
    case 'task': {
      const title = i.title ?? '';
      if (AI_CALL.test(title.trim()) || i.meta.kind !== 'Call') return null;
      if (NO_CONTACT.test(title) || NO_CONTACT.test(i.meta.disposition ?? '')) return null;
      const at = dateOf(i.at);
      return at ? { at, kind: 'call' } : null;
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

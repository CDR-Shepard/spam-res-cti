/**
 * Plan 1D: how long ago the last real contact with a seller was, in words the voice agent may say ("back in
 * February"). The words never carry a digit (CF-14), so they always pass `agentPlanTextIssues`.
 *
 * Fix 1 (M-4): a plan stores the contact's date and kind; the words are worked out when the plan is read (the agent's
 * plan text at trigger time, the board's card), relative to that moment, so a plan approved weeks ago does not say
 * "earlier this week". Shared by outreach-api and outreach-web.
 */
import { z } from 'zod';

export const ContactKind = z.enum(['call', 'meeting', 'email']);
export type ContactKind = z.infer<typeof ContactKind>;

export const DEFAULT_CONTACT_ZONE = 'America/Los_Angeles';
/** M-8: no contact was found, but research read only the most recent activity. */
export const NO_CONTACT_IN_RECENT_ACTIVITY = 'none found in recent activity';

/** The research sources a last contact is read from. */
const CONTACT_SOURCES: ReadonlySet<string> = new Set(['tasks', 'events', 'emails']);

/**
 * Research kept only the most recent Tasks, Events or emails, so finding no contact proves little (1D Fix 1, M-8). One
 * rule for outreach-api's plan facts and the web card (sweep D-13): only those three sources count.
 */
export function contactSearchLimited(sources: ReadonlyArray<{ source: string; truncated: boolean }>): boolean {
  return sources.some((s) => CONTACT_SOURCES.has(s.source) && s.truncated);
}

const DAY_MS = 86_400_000;

function dayParts(d: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(d);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** The calendar day of `d` in `timeZone`, as whole days since the epoch, so two days subtract to whole days. */
function dayNumber(d: Date, timeZone: string): number {
  const { year, month, day } = dayParts(d, timeZone);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/**
 * Words with no digits: "earlier this week", "last week", "earlier this month", "back in February", "about a year
 * ago", "about two years ago", "a few years ago". Days are calendar days in `timeZone`. M-6: two weeks or more ago but
 * still in the current month reads "earlier this month", never "back in October" said in October.
 */
export function contactWords(at: Date, now: Date, timeZone: string = DEFAULT_CONTACT_ZONE): string {
  const days = dayNumber(now, timeZone) - dayNumber(at, timeZone);
  if (days < 7) return 'earlier this week';
  if (days < 14) return 'last week';
  const a = dayParts(at, timeZone);
  const n = dayParts(now, timeZone);
  if (a.year === n.year && a.month === n.month) return 'earlier this month';
  if (days < 330) return `back in ${new Intl.DateTimeFormat('en-US', { timeZone, month: 'long' }).format(at)}`;
  if (days < 548) return 'about a year ago';
  if (days < 913) return 'about two years ago';
  return 'a few years ago';
}

/** M-5: the line's label by kind of contact. A plan stored without a kind was a call or a meeting. */
export function contactLabel(kind: ContactKind | null | undefined): string {
  return kind === 'email' ? 'Last email from them' : 'Last time we spoke';
}

/**
 * The words for a stored re-engagement at `now`: from its date when it has a readable one (M-4), else the words stored
 * with it (a plan from before Fix 1). Null when there was no contact.
 */
export function lastContactWordsAt(
  r: { lastContact: string | null; lastContactAt?: string | null } | null | undefined,
  now: Date,
  timeZone: string = DEFAULT_CONTACT_ZONE,
): string | null {
  if (!r || r.lastContact === null) return null;
  const at = r.lastContactAt ? new Date(r.lastContactAt) : null;
  return at && !Number.isNaN(at.getTime()) ? contactWords(at, now, timeZone) : r.lastContact;
}

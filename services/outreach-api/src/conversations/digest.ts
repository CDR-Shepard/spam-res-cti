/**
 * The history digest: a seller's timeline as one short block of plain lines, for Sam's prompt (what was said
 * and done so far, so a reply or a first email does not repeat or contradict it). Pure.
 *
 * One line per item, oldest first, each starting with its `YYYY-MM-DD` date. A line is never cut: when the cap is
 * reached the OLDEST lines are dropped, so the digest always ends with what happened last. Auto-replies and
 * emails that were canceled (never sent) say nothing about the conversation and are left out. Every free-text
 * part (a summary, a subject, a body, a detail) is flattened to one line, so a seller's newlines cannot break
 * the line format; bodies and summaries are cut at SNIPPET_CHARS.
 */
import type { TimelineItem } from '@cti/contracts';
import { OUTCOME_WORDS } from '../writeback/context.js';

/** How much of an email body or a call summary a line carries. */
const SNIPPET_CHARS = 300;

/** All whitespace runs (newlines included) become one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const snippet = (text: string): string => oneLine(text).slice(0, SNIPPET_CHARS);

/** `YYYY-MM-DD` of an ISO timestamp. */
const dateOf = (at: string): string => at.slice(0, 10);

/** The outcome in words; a call with no outcome yet is just "call". */
const outcomeWords = (outcome: string | null): string => (outcome ? (OUTCOME_WORDS[outcome] ?? outcome) : 'call');

/** The line's text after the date, or null when the item is not part of the digest. */
function lineText(item: TimelineItem): string | null {
  switch (item.type) {
    case 'call': {
      const summary = item.summary === null ? '' : snippet(item.summary);
      return `Call — ${outcomeWords(item.outcome)}.${summary === '' ? '' : ` ${summary}`}`;
    }
    case 'email': {
      if (item.autoReply || item.status === 'canceled') return null;
      const who = item.direction === 'in' ? 'the seller' : 'Sam';
      return `Email from ${who} — "${oneLine(item.subject)}": ${snippet(item.body)}`;
    }
    case 'note':
      return `Note — ${oneLine(item.detail)}`;
  }
}

/**
 * `items` (oldest first, as readTimeline returns them) as one line each, newest lines kept whole within
 * `maxChars` (the newlines between lines count). '' when there is nothing to say or not even the newest line fits.
 */
export function historyDigest(items: TimelineItem[], maxChars: number): string {
  const lines: string[] = [];
  for (const item of items) {
    const text = lineText(item);
    if (text !== null) lines.push(`${dateOf(item.at)} ${text}`);
  }
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  return kept.reverse().join('\n');
}

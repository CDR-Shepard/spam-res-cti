/**
 * The last check on an email before it goes to a seller: plain-words problems, or none.
 *
 * Sam drafts, an admin edits, and replies go out on their own, so this is the last line. It catches
 * what none of them should let through: a link (the footer holds the only one), a leftover
 * placeholder, a price or offer (a person quotes those, not an assistant), a claim to be a human (Sam
 * never says she is a person, and says she is an AI assistant when asked), and anything that reads as an opt-out
 * ("stop", "unsubscribe", "take me off"). That last rule matters twice: the footer owns unsubscribing,
 * and a seller who quotes Sam's words back must never be read as asking to stop. Reply parsing scans
 * the whole reply for opt-outs (inbound-text.ts optOutScanText), so the guarantee that Sam's own
 * words never match is made here, with the same `isOptOutText` that does the reading.
 *
 * The subject and body limits mirror the contract's so the admin sees a readable message before the
 * API's validation does. Content rules look at no more than one over-limit's worth of text: an
 * over-long draft is refused anyway, and the scan stays bounded.
 *
 * Pure: no I/O, no clock, no logging.
 */
import { EMAIL_BODY_MAX, EMAIL_SUBJECT_MAX, type EmailDraft } from '@cti/contracts';
import { isOptOutText } from './inbound-text.js';

interface ContentRule {
  /** What is wrong, ending the sentence "The <part> …". */
  problem: string;
  flags: (text: string) => boolean;
}

const LINK = /https?:\/\/|www\./i;
/** A bare domain ("gghomes.com", "rethink.team/x") or an email address. */
const DOMAIN = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|org|net|io|co|us|team|homes|info|biz)\b/i;
const EMAIL_ADDRESS = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PLACEHOLDER = /\{\{|\[[^\]\r\n]+\]/;
const DOLLAR_AMOUNT = /\$[ \t]*\d/;
/** A price with no dollar sign: "450k", "450,000 dollars", "1.5 million", "500 USD". */
const WORDED_PRICE = /\d(?:[.,]?\d)*[ \t]*(?:k|thousand|million|dollars?|usd)\b/i;
const HUMAN_CLAIM =
  /\b(i'?m|i am)\s+(just\s+)?(a\s+|an\s+)?((real|actual|living)\s+)?(human|person)\b|\bnot\s+(a|an)\s+(ai|bot|robot)\b/i;

const CONTENT_RULES: readonly ContentRule[] = [
  {
    problem: 'has a link or web address; Sam sends none except the unsubscribe link in the footer.',
    flags: (t) => LINK.test(t) || DOMAIN.test(t) || EMAIL_ADDRESS.test(t),
  },
  { problem: 'still has a placeholder such as [Name] or {{name}}.', flags: (t) => PLACEHOLDER.test(t) },
  {
    problem: 'has a price or dollar amount; Sam does not quote prices or offers.',
    flags: (t) => DOLLAR_AMOUNT.test(t) || WORDED_PRICE.test(t),
  },
  {
    problem: 'claims to be a human; Sam is an AI assistant and must not say otherwise.',
    flags: (t) => HUMAN_CLAIM.test(t),
  },
  { problem: 'mentions stopping or unsubscribing; the footer handles that.', flags: (t) => isOptOutText(t) },
];

function contentIssues(part: 'subject' | 'body', text: string, max: number): string[] {
  // A typographic apostrophe must not hide "I’m a person" from the apostrophe-aware patterns.
  const scanned = text.slice(0, max + 1).replace(/[‘’]/g, "'");
  return CONTENT_RULES.filter((rule) => rule.flags(scanned)).map((rule) => `The ${part} ${rule.problem}`);
}

function subjectIssues(subject: string): string[] {
  if (/[\r\n]/.test(subject)) return ['The subject must be one line.'];
  if (subject.trim().length === 0) return ['The subject is empty.'];
  if (subject.length > EMAIL_SUBJECT_MAX) return [`The subject is longer than ${EMAIL_SUBJECT_MAX} characters.`];
  return [];
}

function bodyIssues(body: string): string[] {
  if (body.trim().length === 0) return ['The body is empty.'];
  if (body.length > EMAIL_BODY_MAX) return [`The body is longer than ${EMAIL_BODY_MAX} characters.`];
  return [];
}

/** Problems with this draft in plain words; an empty list means it is fine to send. */
export function draftIssues(d: EmailDraft): string[] {
  return [
    ...subjectIssues(d.subject),
    ...bodyIssues(d.body),
    ...contentIssues('subject', d.subject, EMAIL_SUBJECT_MAX),
    ...contentIssues('body', d.body, EMAIL_BODY_MAX),
  ];
}

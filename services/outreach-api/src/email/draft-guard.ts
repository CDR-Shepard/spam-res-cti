/**
 * The last check on an email before it goes to a seller: plain-words problems, or none.
 *
 * Sam drafts; an admin edits and sends. This catches what neither should let through: a link (the
 * footer holds the only one), a leftover placeholder, a price or offer (a person quotes those, not
 * an assistant), a claim to be a human (Sam says she is an AI assistant, in the footer and in
 * person), and the word "unsubscribe" (the footer owns it, and our reply parsing treats it as an
 * opt-out). The subject and body rules mirror the contract's limits so the message is readable by
 * the admin, who sees it before the API's own validation does.
 *
 * Pure: no I/O, no clock, no logging.
 */
import { EMAIL_BODY_MAX, EMAIL_SUBJECT_MAX, type EmailDraft } from '@cti/contracts';

interface ContentRule {
  /** What is wrong, ending the sentence "The <part> …". */
  problem: string;
  test: RegExp;
}

const CONTENT_RULES: readonly ContentRule[] = [
  { problem: 'has a link; Sam sends no links except the unsubscribe link in the footer.', test: /https?:\/\/|www\./i },
  { problem: 'still has a placeholder such as [Name] or {{name}}.', test: /\{\{|\[[^\]\r\n]+\]/ },
  { problem: 'has a dollar amount; Sam does not quote prices or offers.', test: /\$[ \t]*\d/ },
  {
    problem: 'claims to be a human; Sam is an AI assistant and must not say otherwise.',
    test: /\b(i'?m|i am)\s+(a\s+)?(real\s+)?(human|person)\b|\bnot\s+(a|an)\s+(ai|bot|robot)\b/i,
  },
  { problem: 'uses the word "unsubscribe"; the footer already has the unsubscribe link.', test: /unsubscribe/i },
];

function contentIssues(part: 'subject' | 'body', text: string): string[] {
  // A typographic apostrophe must not hide "I’m a person" from the apostrophe-aware pattern.
  const straightened = text.replace(/[‘’]/g, "'");
  return CONTENT_RULES.filter((rule) => rule.test.test(straightened)).map((rule) => `The ${part} ${rule.problem}`);
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
    ...contentIssues('subject', d.subject),
    ...contentIssues('body', d.body),
  ];
}

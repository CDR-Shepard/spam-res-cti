/**
 * The outgoing email: a plain-text part and an HTML part that say the same thing, plus the headers
 * that make an unsubscribe one click.
 *
 * Every message ends with the same footer (Sam's name, who she works for, a postal address, and a
 * working unsubscribe link; owner, 2026-10-20: no "AI assistant" line). It is what keeps the channel honest and what CAN-SPAM and the mailbox
 * providers expect, so it is built here, once, and never by the draft. The footer's fixed lines are
 * exported so reply parsing (inbound-text.ts) strips exactly what this file writes: a quoted copy of
 * our own "unsubscribe here" line must never read as the seller asking to stop. The HTML has no
 * images, no tracking pixel and one link, so there is nothing to block or to scrub.
 *
 * Pure: no I/O, no clock, no logging.
 */
import { unsubscribeMailto, unsubscribeUrl } from './addresses.js';

export const FOOTER_RULE = '—';
export const FOOTER_SIGNATURE = 'Sam';
/** The words of the unsubscribe sentence that are a link in the HTML part. */
const FOOTER_UNSUBSCRIBE_LINK_TEXT = 'unsubscribe here';
const FOOTER_UNSUBSCRIBE_LEAD = 'To stop hearing from Sam,';
/**
 * The unsubscribe sentence as both parts spell it: the text footer continues ": <url>", the HTML
 * footer makes "unsubscribe here" a link (so flattened to text it has no colon and no URL). A quoted
 * copy of either is recognised by this sentence, which is why reply parsing matches on it and not on
 * the text part's longer line. It is the whole sentence, not just its lead, so a seller who writes
 * "To stop hearing from Sam, please remove me from your list" is still read.
 */
export const FOOTER_UNSUBSCRIBE_SENTENCE = `${FOOTER_UNSUBSCRIBE_LEAD} ${FOOTER_UNSUBSCRIBE_LINK_TEXT}`;

/** "GG Homes'" for a name ending in s or S, "Acme's" otherwise. */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** The footer line earlier emails carried under "Sam"; kept so reply parsing still strips it from a quoted older email. */
export function assistantFooterLine(company: string): string {
  return `${possessive(company)} AI assistant`;
}

export const COMPANY_LINE_SEPARATOR = ' · ';

export function companyFooterLine(company: string, postal: string): string {
  return `${company}${COMPANY_LINE_SEPARATOR}${postal}`;
}

export function unsubscribeFooterLine(url: string): string {
  return `${FOOTER_UNSUBSCRIBE_SENTENCE}: ${url}`;
}

export interface RenderEmailInput {
  body: string;
  token: string;
  apiPublicUrl: string;
  replyDomain: string;
  postalAddress: string;
  companyName: string;
  /** Message-ID of the message being answered, for threading; null on a first email. */
  inReplyTo: string | null;
  references: string | null;
}

export interface RenderedEmail {
  text: string;
  html: string;
  headers: Record<string, string>;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!);
}

/** Blank-line separated paragraphs; a single newline inside one becomes <br>. All of it escaped. */
function bodyToHtml(body: string): string {
  return body
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/** A header value is one line: a stored Message-ID that carried a line break must not start a new header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function renderEmail(i: RenderEmailInput): RenderedEmail {
  const url = unsubscribeUrl(i.apiPublicUrl, i.token);
  const body = i.body.replace(/\r\n?/g, '\n').trimEnd();

  const text = [
    body,
    '',
    FOOTER_RULE,
    FOOTER_SIGNATURE,
    '',
    companyFooterLine(i.companyName, i.postalAddress),
    unsubscribeFooterLine(url),
  ].join('\n');

  const html = [
    bodyToHtml(body),
    `<p>${FOOTER_RULE}<br>${FOOTER_SIGNATURE}</p>`,
    `<p>${escapeHtml(companyFooterLine(i.companyName, i.postalAddress))}<br>` +
      `${FOOTER_UNSUBSCRIBE_LEAD} <a href="${escapeHtml(url)}">${FOOTER_UNSUBSCRIBE_LINK_TEXT}</a></p>`,
  ].join('\n');

  const headers: Record<string, string> = {
    'List-Unsubscribe': `<${url}>, <mailto:${unsubscribeMailto(i.token, i.replyDomain)}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
  if (i.inReplyTo) headers['In-Reply-To'] = oneLine(i.inReplyTo);
  if (i.references) headers['References'] = oneLine(i.references);

  return { text, html, headers };
}

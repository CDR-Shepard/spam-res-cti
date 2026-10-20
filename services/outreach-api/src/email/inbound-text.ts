/**
 * Reading what a seller sent back: the new text without the quoted thread or our footer, HTML
 * flattened to text, auto-replies recognised, and opt-out wording recognised.
 *
 * The one rule that matters most: our own footer says "unsubscribe here", so a seller's reply that
 * quotes it (or a client that flattens the quote and drops the ">" marks) must never read as the
 * seller asking to stop. `stripQuoted` cuts the quoted thread AND removes our footer lines, and it
 * builds those lines from render.ts so the two files cannot drift apart. The footer lines are
 * matched by shape (and, when the caller passes the company name, exactly) because this module does
 * not otherwise know the company; the unsubscribe line by its lead, which the HTML footer shares. A lone "Sam" or "—" the seller wrote is kept: the signature lines
 * only go when they sit directly on top of our assistant line.
 *
 * Opt-out and auto-reply detection err toward catching: a missed opt-out is a compliance problem, a
 * false one just pauses a conversation a person then reads.
 *
 * Pure: no I/O, no clock, no logging. Input is seller-controlled; nothing here throws on odd text.
 */
import {
  COMPANY_LINE_SEPARATOR,
  FOOTER_RULE,
  FOOTER_SIGNATURE,
  FOOTER_UNSUBSCRIBE_LEAD,
  assistantFooterLine,
} from './render.js';

// ---------------------------------------------------------------------------------------------
// stripQuoted
// ---------------------------------------------------------------------------------------------

const ATTRIBUTION_LINE = /^On\s.{1,300}?\swrote:$/i;
const ORIGINAL_MESSAGE = /^-{2,}\s*Original Message\s*-{2,}$/i;
const UNDERSCORE_RULE = /^_{16,}$/;
const FROM_LINE = /^From:/i;
const SENT_OR_DATE_LINE = /^(Sent|Date):/i;
const QUOTE_MARK = /^>/;
/** Our assistant line without knowing the company: "<anything>'s AI assistant". */
const ASSISTANT_SHAPE = /^.+'s AI assistant$/;

export interface StripQuotedOptions {
  /** When given, our company lines are matched exactly instead of by shape. */
  companyName?: string;
}

/** Is `lines[i]` (already trimmed) the start of the quoted thread? */
function startsQuote(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  const next = lines[i + 1];
  if (ATTRIBUTION_LINE.test(line)) return true;
  // Gmail wraps a long attribution so that "wrote:" is on a line of its own.
  if (/^On\s/i.test(line) && next !== undefined && ATTRIBUTION_LINE.test(`${line} ${next}`)) return true;
  if (ORIGINAL_MESSAGE.test(line) || UNDERSCORE_RULE.test(line)) return true;
  if (FROM_LINE.test(line) && next !== undefined && SENT_OR_DATE_LINE.test(next)) return true;
  return QUOTE_MARK.test(line);
}

function isCompanyLine(line: string | undefined): boolean {
  if (line === undefined) return false;
  const at = line.indexOf(COMPANY_LINE_SEPARATOR);
  return at > 0 && line.length > at + COMPANY_LINE_SEPARATOR.length;
}

/** Indexes of the lines that are our footer. `lines` are trimmed. */
function footerLineIndexes(lines: readonly string[], companyName: string | undefined): Set<number> {
  const drop = new Set<number>();
  const assistantExact = companyName ? assistantFooterLine(companyName) : null;
  const companyPrefix = companyName ? `${companyName}${COMPANY_LINE_SEPARATOR}` : null;
  lines.forEach((line, i) => {
    if (line.startsWith(FOOTER_UNSUBSCRIBE_LEAD)) {
      drop.add(i);
      if (isCompanyLine(lines[i - 1])) drop.add(i - 1);
    }
    if (companyPrefix !== null && line.startsWith(companyPrefix)) drop.add(i);
    const isAssistantLine =
      assistantExact !== null ? line === assistantExact : ASSISTANT_SHAPE.test(line) && lines[i - 1] === FOOTER_SIGNATURE;
    if (isAssistantLine) {
      drop.add(i);
      if (lines[i - 1] === FOOTER_SIGNATURE) {
        drop.add(i - 1);
        if (lines[i - 2] === FOOTER_RULE) drop.add(i - 2);
      }
    }
  });
  return drop;
}

/** The seller's own words: the text above the quoted thread, minus any copy of our footer. */
export function stripQuoted(text: string, opts: StripQuotedOptions = {}): string {
  const raw = text.replace(/\r\n?/g, '\n').split('\n');
  const trimmed = raw.map((line) => line.trim());
  const cutAt = trimmed.findIndex((_, i) => startsQuote(trimmed, i));
  const footer = footerLineIndexes(trimmed, opts.companyName);
  const end = cutAt === -1 ? raw.length : cutAt;
  return raw
    .slice(0, end)
    .filter((_, i) => !footer.has(i))
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'tr', 'table', 'thead', 'tbody', 'blockquote', 'pre', 'hr',
  'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);
/** Elements whose contents are not text a reader sees. */
const INERT_TAGS = new Set(['script', 'style', 'title']);
const TAG_NAME = /^(\/?)([a-z][a-z0-9]*)/i;

/**
 * The index of the `>` that ends the tag whose inside starts at `from`, or -1. A quoted attribute
 * value (`title="a > b"`) may hold a `>`; a quote only opens one straight after `=`, as in a browser.
 * One left-to-right pass, so adversarial markup cannot make it quadratic.
 */
function tagEnd(html: string, from: number): number {
  let afterEquals = false;
  for (let j = from; j < html.length; j += 1) {
    const ch = html[j]!;
    if (ch === '>') return j;
    if ((ch === '"' || ch === "'") && afterEquals) {
      const close = html.indexOf(ch, j + 1);
      if (close === -1) return -1;
      j = close;
      afterEquals = false;
    } else if (ch === '=') {
      afterEquals = true;
    } else if (!/\s/.test(ch)) {
      afterEquals = false;
    }
  }
  return -1;
}

/**
 * Tags to line breaks, everything else in a tag gone, entities left alone. A scanner rather than
 * regexes: the input is seller-controlled and a pattern like `<a "` repeated would make a
 * backtracking regex quadratic. A tag left open at the very end is dropped (a browser does too).
 */
function flowText(html: string): string {
  let out = '';
  let i = 0;
  // Names whose closing tag is known to be missing from here to the end: do not search again.
  const unclosed = new Set<string>();
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return out + html.slice(i);
    out += html.slice(i, lt);
    const lead = html[lt + 1] ?? '';
    if (!/[a-zA-Z/!?]/.test(lead)) {
      out += '<'; // a bare "<" in text
      i = lt + 1;
      continue;
    }
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      if (close === -1) return out;
      i = close + 3;
      continue;
    }
    const end = tagEnd(html, lt + 1);
    if (end === -1) return out;
    i = end + 1;
    const named = TAG_NAME.exec(html.slice(lt + 1, Math.min(end, lt + 40)));
    if (!named) continue; // <!doctype>, <?xml?>, </ >
    const name = named[2]!.toLowerCase();
    if (name === 'br' || BLOCK_TAGS.has(name)) {
      out += '\n';
    } else if (named[1] === '' && INERT_TAGS.has(name) && !unclosed.has(name)) {
      const closing = new RegExp(`</${name}\\b`, 'ig');
      closing.lastIndex = i;
      const found = closing.exec(html);
      if (found) i = html.indexOf('>', found.index) + 1 || html.length;
      else unclosed.add(name); // keep the text after it rather than lose the whole message
    }
  }
  return out;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

/** One pass, so `&amp;lt;` becomes `&lt;` and not `<`. Unknown or invalid entities stay as written. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1]!.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const isScalar = Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return isScalar ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * A small converter for the HTML-only replies some clients send: block tags and <br> become line
 * breaks, other tags vanish, the common entities are decoded. Source line breaks are whitespace, as
 * in a browser. Dependency-free on purpose: the output only feeds stripQuoted and the timeline.
 */
export function htmlToText(html: string): string {
  return decodeEntities(flowText(html.replace(/\r\n?|\n/g, ' ')))
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------------------------
// isAutoReply
// ---------------------------------------------------------------------------------------------

const AUTO_PRECEDENCE = new Set(['bulk', 'junk', 'list', 'auto_reply']);
const ROBOT_SENDERS = new Set(['mailer-daemon', 'postmaster', 'no-reply', 'noreply']);
const AUTO_SUBJECT_PREFIXES = [
  'automatic reply',
  'auto:',
  'out of office',
  'undeliverable',
  'delivery status notification',
  'returned mail',
];

/** The local part (lowercased, plus-tag dropped) of the last address in a From header, or ''. */
function senderLocalPart(from: string): string {
  const at = from.lastIndexOf('@');
  if (at <= 0) return '';
  let start = at;
  while (start > 0 && !/[\s<>"]/.test(from[start - 1]!)) start -= 1;
  return from.slice(start, at).toLowerCase().split('+')[0]!;
}

/** True for machine-sent mail (out-of-office, bounce, list/bulk): never worth a human answer or a reply from Sam. */
export function isAutoReply(i: { headers: Record<string, string>; from: string; subject: string }): boolean {
  const headers = new Map(Object.entries(i.headers).map(([name, value]) => [name.toLowerCase(), value.trim().toLowerCase()]));
  const autoSubmitted = headers.get('auto-submitted');
  if (autoSubmitted !== undefined && autoSubmitted !== 'no') return true;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return true;
  const precedence = headers.get('precedence');
  if (precedence !== undefined && AUTO_PRECEDENCE.has(precedence)) return true;
  if (ROBOT_SENDERS.has(senderLocalPart(i.from))) return true;
  const subject = i.subject.trim().toLowerCase();
  return AUTO_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix));
}

// ---------------------------------------------------------------------------------------------
// isOptOutText
// ---------------------------------------------------------------------------------------------

const OPT_OUT_EXACT = new Set(['stop', 'unsubscribe', 'remove', 'remove me', 'opt out', 'optout', 'cancel']);
const OPT_OUT_PHRASES = [
  'unsubscribe',
  'remove me from',
  'take me off',
  'stop emailing',
  'stop contacting',
  'stop calling',
  'stop texting',
  'do not contact',
  "don't contact",
  'do not email',
  "don't email",
  'leave me alone',
];

/** Does this (already quote-stripped) reply ask us to stop? */
export function isOptOutText(text: string): boolean {
  const lowered = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const bare = lowered.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (OPT_OUT_EXACT.has(bare)) return true;
  return OPT_OUT_PHRASES.some((phrase) => lowered.includes(phrase));
}

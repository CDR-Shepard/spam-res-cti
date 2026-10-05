/**
 * CF-9: the deterministic check every piece of call-plan text passes before it can reach the
 * AI voice agent. outreach-api runs it on each field it renders (single-line fields may not
 * break lines); cti-api runs it again on the rendered text it receives, and refuses the call
 * (`plan_rejected`) instead of sending a failing plan to the agent.
 *
 * It is deliberately strict: a false positive costs a re-edit of the plan, a false negative
 * could put a price, a URL or a "say you're human" line in front of a model that speaks to
 * the public. Nothing here is a substitute for the agent's own non-overridable rules, which
 * stay in its instructions after the fenced plan.
 */

export const AGENT_PLAN_ISSUES = [
  'money',
  'offer',
  'human_claim',
  'disclosure_skip',
  'url',
  'angle_bracket',
  'control_char',
  'disallowed_char',
  'line_break',
] as const;
export type AgentPlanIssue = (typeof AGENT_PLAN_ISSUES)[number];

/**
 * Amounts in digits and in words. Deliberately blunt: any run of three digits fails (a price like "around 250", a year,
 * a house number, a ZIP), as do "low 300s", "low 90s", "1.2m", "250k" and the words hundred/thousand/million/grand.
 * A plan needs none of them. Amounts spelled out without those words ("two fifty", "ninety") are NOT caught here; the
 * non-overridable price rule after the fence in the agent's instructions is what covers them.
 */
const MONEY: readonly RegExp[] = [
  /[$\u20AC\u00A3\u00A5]/,
  /\d+(?:[.,]\d+)?\s*[km]\b/i,
  /\b\d{2}s\b/i,
  /\b(?:dollars?|bucks|usd|cents?)\b/i,
  /\b(?:hundred|thousand|million|billion|grand|mil)s?\b/i,
  /\d{3,}/,
  /\d{1,3}(?:,\d{3})+/,
];

/**
 * Offer phrasing only. The bare word is allowed ("other offers"), and so is "worth": asking what the owner thinks the
 * house is worth is a legitimate question. Amounts are caught by MONEY.
 */
const OFFER: readonly RegExp[] = [
  /\b(?:our|my|the|an?)\s+(?:\w+\s+)?offers?\b/i,
  /\bcash\s+offers?\b/i,
  /\b(?:we|i)(?:'ll|\s+(?:can|could|will|would|may|might|are going to))\s+offer\b/i,
  /\boffer(?:s|ed|ing)?\s+(?:you|them|him|her|us)\b/i,
  /\b(?:make|making|made|give|giving|submit|submitting|present|presenting)\s+(?:you\s+|them\s+|him\s+|her\s+)?(?:\w+\s+)?offers?\b/i,
  /\b(?:pay|paying|paid)\s+(?:you|them|him|her)\b/i,
];

const REAL = String.raw`(?:(?:real|actual|live|living|genuine|flesh and blood)\s+)*`;

const HUMAN_CLAIM: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:i am|i'm|im|we are|we're|you are|you're|youre)\s+(?:a\s+|an\s+)?${REAL}(?:human|person|human being)\b`, 'i'),
  /\bnot\s+(?:an?\s+)?(?:ai|a\.i\.?|robot|bot|machine|computer|automated|artificial|recording)\b/i,
  /\b(?:pretend|pretending|claim|claiming|act like|acting like|pose as|posing as|say|saying|tell them|tell him|tell her|insist|insisting)\b[^.\n]{0,40}\b(?:human|real person|a person|live person)\b/i,
  new RegExp(String.raw`\b(?:speaking|talking|chatting)\s+(?:with|to)\s+(?:a|an)\s+(?:${REAL}human|human being|real person|live person|living person|actual person)\b`, 'i'),
];

const AI_WORDS = String.raw`(?:ai|a\.i\.?|artificial|robot|bot|automated|machine|computer|recorded|recording|assistant)`;

const DISCLOSURE_SKIP: readonly RegExp[] = [
  /\bdisclos/i,
  new RegExp(
    String.raw`\b(?:skip|skipping|omit|omitting|drop|hide|hiding|conceal|leave out|don't mention|do not mention|don't say|do not say|never mention|never say|without mentioning|without saying|no need to mention|no need to say|avoid saying|avoid mentioning)\b[^.\n]{0,40}\b${AI_WORDS}\b`,
    'i',
  ),
  new RegExp(String.raw`\b(?:don't|do not|never|not to|shouldn't|should not)\s+(?:tell|admit|reveal|let on|confess|acknowledge|confirm|volunteer)\b[^.\n]{0,50}\b${AI_WORDS}\b`, 'i'),
];

/**
 * Web addresses, e-mail addresses and IPs. Any "word.letters" (two or more letters after the dot) reads as a domain, so
 * no closed TLD list can be walked around ("evil.xyz", "deals.shop/pay"). Ordinary prose stays clear: "e.g." and "i.e."
 * have one letter after each dot, and "St." / "Mr." are followed by a space. A sentence run together without a space
 * ("sold.Then") is a false positive and costs a re-edit.
 */
const URL_LIKE: readonly RegExp[] = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.[a-z]{2,}\b/i,
  /\S+@\S+/,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
];

const ANGLE = /[<>]/;
/** C0/C1 controls except tab and LF, format characters (zero-width etc.) and the Unicode line/paragraph separators. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/u;
const CONTROL_EVERYWHERE = new RegExp(CONTROL.source, 'gu');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LINE_BREAK = /[\n\r]/;

/**
 * The allowlist (S-2), applied after NFKC and after accents are removed: ASCII letters and digits, the space, tab and
 * line feed, and basic punctuation: . , ; : ! ? ' " ( ) - / & % # @ + _ plus curly quotes, en and em dashes and the
 * ellipsis. Anything else (look-alike brackets and letters from other scripts, emoji, symbols, backticks, braces, and
 * Latin letters that have no plain-ASCII base such as "ø", "ı" or "ł") rejects the plan. `$ € £ ¥ < >` are left to the
 * checks that name them.
 */
const OUTSIDE_ASCII_ALLOWLIST = /[^A-Za-z0-9 \t\n.,;:!?'"()\-/&%#@+_\u2018\u2019\u201C\u201D\u2013\u2014\u2026$\u20AC\u00A3\u00A5<>]/u;
/** Dot look-alikes NFKC leaves alone (ideographic and halfwidth full stops), so "www。evil。com" still reads as a URL. */
const DOT_LOOKALIKES = /[\u3002\uFF61\u2024\uFE52\u00B7\u2027]/g;
/** Spacing-letter apostrophes and the curly ones, all read as the straight apostrophe. */
const APOSTROPHES = /[\u2018\u2019\u02BC]/g;

/**
 * Accents come off letters (NFD, then every combining mark goes), so "hùman" reads as "human" in every word check and a
 * name like "María" or "café" still passes. Letters that carry no mark to strip but look like a base letter are mapped
 * for the word checks (ø is o, ı is i, ł is l, ...); the allowlist, which runs on the unmapped text, still rejects them
 * as disallowed_char, so a plan cannot use them at all.
 */
const STROKE_FOLD: Readonly<Record<string, string>> = {
  '\u00F8': 'o', '\u00D8': 'O', '\u0131': 'i', '\u0142': 'l', '\u0141': 'L', '\u0111': 'd', '\u0110': 'D',
  '\u00DF': 'ss', '\u00E6': 'ae', '\u00C6': 'AE', '\u0153': 'oe', '\u0152': 'OE', '\u00FE': 'th', '\u00DE': 'Th',
  '\u00F0': 'd', '\u00D0': 'D', '\u0140': 'l', '\u013F': 'L', '\u0127': 'h', '\u0126': 'H', '\u0167': 't', '\u0166': 'T',
};
const STROKE_LETTERS = new RegExp(`[${Object.keys(STROKE_FOLD).join('')}]`, 'g');
const STRAY_MARK = /\p{M}/u;
const stripAccents = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '');
const foldStrokes = (text: string): string => text.replace(STROKE_LETTERS, (c) => STROKE_FOLD[c] ?? c);

const any = (patterns: readonly RegExp[], text: string): boolean => patterns.some((p) => p.test(text));

/**
 * Every reason `text` may not reach the voice agent, each once, in AGENT_PLAN_ISSUES order;
 * `[]` means it passes. `singleLine` also refuses a line break (a one-line field).
 *
 * The text is NFKC-normalised first (fullwidth and presentation forms read as plain ASCII: "\uFF1C" is "<", a fullwidth
 * "\uFF2F\uFF26\uFF26\uFF25\uFF32" is "OFFER"), then its accents are folded away (see stripAccents), so no look-alike
 * or accented spelling gets past the word checks, and then it must stay inside the ASCII allowlist.
 */
export function agentPlanTextIssues(text: string, opts: { singleLine: boolean }): AgentPlanIssue[] {
  const control = CONTROL.test(text) || LONE_SURROGATE.test(text);
  // Curly apostrophes read as straight ones, so "don’t mention" is caught like "don't mention".
  const plain = text.normalize('NFKC').replace(APOSTROPHES, "'");
  const unmarked = stripAccents(plain.replace(DOT_LOOKALIKES, '.'));
  const checked = foldStrokes(unmarked);
  const found = new Set<AgentPlanIssue>();
  if (any(MONEY, checked)) found.add('money');
  if (any(OFFER, checked)) found.add('offer');
  if (any(HUMAN_CLAIM, checked)) found.add('human_claim');
  if (any(DISCLOSURE_SKIP, checked)) found.add('disclosure_skip');
  if (any(URL_LIKE, checked)) found.add('url');
  if (ANGLE.test(checked)) found.add('angle_bracket');
  if (control || CONTROL.test(plain)) found.add('control_char');
  // What is left once the control characters are gone must be on the allowlist (they already have their own issue).
  // A combining mark that NFKC could not compose onto its letter is stray (invisible padding), never accent: reject it.
  if (STRAY_MARK.test(plain) || OUTSIDE_ASCII_ALLOWLIST.test(unmarked.replace(CONTROL_EVERYWHERE, ''))) found.add('disallowed_char');
  if (opts.singleLine && LINE_BREAK.test(text)) found.add('line_break');
  return AGENT_PLAN_ISSUES.filter((issue) => found.has(issue));
}

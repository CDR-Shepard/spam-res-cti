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
  'line_break',
] as const;
export type AgentPlanIssue = (typeof AGENT_PLAN_ISSUES)[number];

const MONEY: readonly RegExp[] = [
  /[$\u20AC\u00A3\u00A5]/,
  /\d+(?:[.,]\d+)?\s*k\b/i,
  /\d+(?:[.,]\d+)?\s*(?:million|mil|mm|grand|thousand|bucks|dollars?|usd)\b/i,
  /\b(?:dollars?|bucks|usd)\b/i,
  /\d{1,3}(?:,\d{3})+/,
  /\d{5,}/,
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

const HUMAN_CLAIM: readonly RegExp[] = [
  /\b(?:i am|i'm|im|we are|we're|you are|you're|youre)\s+(?:a\s+|an\s+)?(?:real\s+|actual\s+|live\s+)?(?:human|person)\b/i,
  /\bnot\s+(?:an?\s+)?(?:ai|a\.i\.?|robot|bot|machine|computer|automated|recording)\b/i,
  /\b(?:pretend|pretending|claim|claiming|act like|acting like|pose as|posing as|say|saying|tell them|tell him|tell her)\b[^.\n]{0,40}\b(?:human|real person|a person|live person)\b/i,
];

const DISCLOSURE_SKIP: readonly RegExp[] = [
  /\bdisclos/i,
  /\b(?:skip|skipping|omit|omitting|drop|hide|leave out|don't mention|do not mention|don't say|do not say|never mention|never say|without mentioning|without saying|no need to mention|no need to say)\b[^.\n]{0,40}\b(?:ai|a\.i\.?|artificial|robot|bot|automated|recorded|recording)\b/i,
];

const URL_LIKE: readonly RegExp[] = [
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|net|org|io|co|us|biz|info|me|ly|app|dev|ai|gov|edu)\b/i,
];

const ANGLE = /[<>]/;
/** C0/C1 controls except tab and LF, format characters (zero-width etc.) and the Unicode line/paragraph separators. */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]|\p{Cf}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LINE_BREAK = /[\n\r]/;

const any = (patterns: readonly RegExp[], text: string): boolean => patterns.some((p) => p.test(text));

/**
 * Every reason `text` may not reach the voice agent, each once, in AGENT_PLAN_ISSUES order;
 * `[]` means it passes. `singleLine` also refuses a line break (a one-line field).
 */
export function agentPlanTextIssues(text: string, opts: { singleLine: boolean }): AgentPlanIssue[] {
  // Curly apostrophes read as straight ones, so "don’t mention" is caught like "don't mention".
  const plain = text.replace(/[\u2018\u2019\u02BC]/g, "'");
  const found = new Set<AgentPlanIssue>();
  if (any(MONEY, plain)) found.add('money');
  if (any(OFFER, plain)) found.add('offer');
  if (any(HUMAN_CLAIM, plain)) found.add('human_claim');
  if (any(DISCLOSURE_SKIP, plain)) found.add('disclosure_skip');
  if (any(URL_LIKE, plain)) found.add('url');
  if (ANGLE.test(plain)) found.add('angle_bracket');
  if (CONTROL.test(text) || LONE_SURROGATE.test(text)) found.add('control_char');
  if (opts.singleLine && LINE_BREAK.test(text)) found.add('line_break');
  return AGENT_PLAN_ISSUES.filter((issue) => found.has(issue));
}

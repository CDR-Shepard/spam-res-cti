/**
 * A Salesforce first name as the agent may say it ("Is this James?"), or null when the field holds something that is
 * not one person's first name. In the Opportunity Hunt Queue about one contact in ten carries two people ("John &
 * Mary"), a note in brackets, a street address, a trust, or a single initial; saying any of those aloud is worse than
 * asking for the owner of the street, which is what the prompt does without a name.
 */

/**
 * Anywhere in the field, even in brackets: the person died, or the field is a flag. No name, so the agent never asks
 * a widow for her late husband. A comma makes the order unclear ("Smith, John"): no name rather than a guess.
 */
const NO_NAME_AT_ALL = /,|\b(?:deceased|dec'?d|late|passed|probate|estates?|do not call|dnc|wrong number|n\/a)\b/i;
/** Where a second person or a note starts: keep what comes before it. */
const CUT_AT = /\s*(?:\(|\/|&|\band\b)/i;
/** Never part of a person's first name: digits, a trust, a placeholder, a company. */
const NOT_A_NAME =
  /[\d#@]|\b(?:trusts?|trustees?|llc|inc|corp(?:oration)?|co|company|family|(?:home)?owners?|unknown|residents?|occupants?|tenants?|sellers?|buyers?|heirs?|of|none|na|tbd|test(?:ing)?|wrong|number|propert(?:y|ies)|investments?|investors?|realty|realtors?|holdings?|group|partners?|capital|bank|management|mgmt|homes|sir|madam|customer|client|lead|contact)\b/i;
/** One or two words of letters, inner apostrophes, hyphens and periods. */
const NAME = /^\p{L}[\p{L}'’.-]*(?: \p{L}[\p{L}'’.-]*)?$/u;
/** "M" or "M." beside a name: a middle or leading initial, never said. */
const INITIAL = /^\p{L}\.?$/u;
/** Said with a surname ("Is this Mr. Smith?"), never alone. */
const TITLE = /^(?:mr|mrs|ms|miss|dr|rev)\.?$/i;
const MAX_WORDS = 2;
const MIN_LETTERS = 2;

/** "JEAN-LUC" / "jean-luc" → "Jean-Luc"; mixed case ("McKenzie") is kept as typed. */
function nameCase(s: string): string {
  if (s !== s.toUpperCase() && s !== s.toLowerCase()) return s;
  return s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function spokenFirstName(raw: string | null | undefined): string | null {
  if (!raw || NO_NAME_AT_ALL.test(raw)) return null;
  const head = raw.split(CUT_AT)[0]?.trim() ?? '';
  if (!head || NOT_A_NAME.test(head)) return null;
  const all = head.split(/\s+/);
  const words = all.length > 1 && all.some((w) => !INITIAL.test(w)) ? all.filter((w) => !INITIAL.test(w)) : all;
  const title = TITLE.test(words[0] ?? '');
  if (title && words.length === 1) return null;
  const name = words.length <= MAX_WORDS ? words.join(' ') : title ? `${words[0]} ${words.at(-1)}` : words[0]!;
  if (!NAME.test(name) || name.replace(/[^\p{L}]/gu, '').length < MIN_LETTERS) return null;
  return nameCase(name);
}

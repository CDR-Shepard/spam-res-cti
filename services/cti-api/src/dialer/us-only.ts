/**
 * The power dialer calls US numbers only (user ruling 2026-10-12: skip
 * non-US numbers; Mexico stays off in our Twilio geo permissions on purpose).
 *
 * "US" is the region libphonenumber assigns, the US and its territories. It is
 * NOT our own area-code map (@cti/firewall tz.ts): that map is missing real US
 * area codes (239 SW Florida, 659, 686, 943), and testing against it would
 * skip real US leads.
 */
import { normalize } from '@cti/phone';

/** The skip outcome for a person with no US number. */
export const NON_US_OUTCOME = 'non_us';

const US_REGIONS: ReadonlySet<string> = new Set(['US', 'PR', 'VI', 'GU', 'AS', 'MP']);

/**
 * True when the number is positively not a US one: any non-+1 number, or a +1
 * number libphonenumber places in another country (Canada, Jamaica, Bermuda…).
 * A +1 number it cannot place at all is left alone: Twilio has the last word on
 * that one (engine.ts's refused-destination skip).
 */
export function isNonUsNumber(e164: string): boolean {
  if (!e164.startsWith('+1')) return true;
  const parsed = normalize(e164);
  return parsed.ok && !US_REGIONS.has(parsed.value!.country);
}

/**
 * A record's (first, second) numbers with every non-US number taken out. The
 * second number is DIALED (the engine's end-of-run retry), so a non-US one is
 * dropped. A non-US first number gives way to a US second one. With no US
 * number at all, `nonUs` is set and the first number is kept so the row still
 * shows who was passed over and why.
 */
export function usOnlyPair(
  first: string | null,
  second: string | null,
): { toNumber: string | null; secondNumber: string | null; nonUs: boolean } {
  const usSecond = second && !isNonUsNumber(second) ? second : null;
  if (!first) return { toNumber: null, secondNumber: usSecond, nonUs: false };
  if (!isNonUsNumber(first)) return { toNumber: first, secondNumber: usSecond, nonUs: false };
  if (usSecond) return { toNumber: usSecond, secondNumber: null, nonUs: false };
  return { toNumber: first, secondNumber: null, nonUs: true };
}

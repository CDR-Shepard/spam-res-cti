/**
 * THE recipient-local calling window, for the whole system: dialing is allowed
 * while the local hour is in [8, 20] — 08:00:00 through 20:59:59, i.e. 8:00am
 * through 8:59pm. That sits inside the federal TCPA bound of 8am–9pm with a
 * one-minute margin at the top.
 *
 * ONE definition, two enforcement sites. The dialer's coarse pre-filter
 * (`withinCallingHours` in dialer/pick-did.ts) and the firewall's authoritative
 * click-to-dial gate used to carry independent literals — 8am–9pm here,
 * 8am–8pm there — so a call the firewall would BLOCK at 8:10pm local could
 * still be attempted by the power dialer at that same instant, with nothing
 * keeping the two from drifting further (spam-defense audit §5, gap 1). Both
 * now import these constants, so neither site can move without the other.
 *
 * A campaign row may still NARROW the window (org business preference); it can
 * no longer widen it past this pair.
 */
export const CALLING_HOUR_START = 8;
export const CALLING_HOUR_END_INCLUSIVE = 20;

/** The same window as the `HH:MM` strings `campaign_configs` stores. The end is
 *  the EXCLUSIVE bound the firewall's minute comparator wants, so the whole of
 *  hour `CALLING_HOUR_END_INCLUSIVE` (through :59) is inside it — exactly what
 *  `withinCallingHours` allows. */
const hhmm = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;
export const CALLING_HOURS_START_HHMM = hhmm(CALLING_HOUR_START);
export const CALLING_HOURS_END_HHMM_EXCLUSIVE = hhmm(CALLING_HOUR_END_INCLUSIVE + 1);

/** GG Homes operates out of America/Los_Angeles — "today" for the already-worked
 *  skip means the LA calendar day, not the server's (UTC on Railway). */
export const ORG_TIMEZONE = 'America/Los_Angeles';

const ymdIn = (tz: string, d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hourIn = (tz: string, d: Date): number =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(d));

/**
 * The UTC instant of the most recent local midnight in `tz`. Tries every
 * plausible UTC offset for that calendar day and keeps the candidate that
 * renders as 00:xx local — DST-proof without a timezone library.
 */
export function orgMidnightUtc(now: Date, tz: string = ORG_TIMEZONE): Date {
  const [y, m, d] = ymdIn(tz, now).split('-').map(Number);
  for (let offset = 0; offset <= 14; offset++) {
    const candidate = new Date(Date.UTC(y!, m! - 1, d!, offset, 0, 0));
    if (hourIn(tz, candidate) === 0 && ymdIn(tz, candidate) === ymdIn(tz, now)) return candidate;
  }
  // Unreachable for real timezones; fail loudly rather than silently mis-bucket a day.
  throw new Error(`orgMidnightUtc: no midnight found for ${tz}`);
}

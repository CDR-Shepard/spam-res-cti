/** GG Homes operates out of America/Los_Angeles — "today" for the already-worked
 *  skip means the LA calendar day, not the server's (UTC on Railway). */
export const ORG_TIMEZONE = 'America/Los_Angeles';

const ymdIn = (tz: string, d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const hhmmIn = (tz: string, d: Date): string =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

/**
 * The UTC instant of the most recent local midnight in `tz`. Tries every
 * plausible UTC offset for that calendar day and keeps the candidate that
 * renders as 00:xx local — DST-proof without a timezone library.
 */
export function orgMidnightUtc(now: Date, tz: string = ORG_TIMEZONE): Date {
  const [y, m, d] = ymdIn(tz, now).split('-').map(Number);
  // Scan candidate offsets in 15-minute steps across both adjacent UTC days:
  // negative-offset zones (LA) hit midnight later the same UTC day, positive-
  // offset zones (Tokyo) the preceding one, and half/quarter-hour zones
  // (Kolkata, St. John's) land between whole hours. ~113 cheap Intl checks max.
  for (let q = -14 * 4; q <= 14 * 4; q++) {
    const candidate = new Date(Date.UTC(y!, m! - 1, d!, 0, q * 15, 0));
    if (hhmmIn(tz, candidate) === '00:00' && ymdIn(tz, candidate) === ymdIn(tz, now)) return candidate;
  }
  // Genuinely unreachable for any IANA zone (all offsets are within ±14h on
  // quarter-hour boundaries); fail loudly rather than silently mis-bucket a day.
  throw new Error(`orgMidnightUtc: no midnight found for ${tz}`);
}

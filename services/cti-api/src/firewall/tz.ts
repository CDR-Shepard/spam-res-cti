/**
 * Map a US state code (or country) to a sensible IANA timezone.
 *
 * States that straddle two zones (e.g. KS, OR) use the *majority* zone.
 * Arizona is hard-coded to America/Phoenix because it does NOT observe DST.
 * For non-US countries we fall back to a small country→TZ table; if nothing
 * matches we return null so the firewall keeps the "unknown TZ" REVIEW path.
 */

const US_STATE_TO_TZ: Record<string, string> = {
  // Pacific
  CA: 'America/Los_Angeles',
  NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',
  // Mountain (DST)
  CO: 'America/Denver',
  MT: 'America/Denver',
  NM: 'America/Denver',
  UT: 'America/Denver',
  WY: 'America/Denver',
  ID: 'America/Denver', // majority Mountain; northern panhandle is Pacific
  // Arizona (no DST)
  AZ: 'America/Phoenix',
  // Central
  AL: 'America/Chicago',
  AR: 'America/Chicago',
  IA: 'America/Chicago',
  IL: 'America/Chicago',
  KS: 'America/Chicago',
  LA: 'America/Chicago',
  MN: 'America/Chicago',
  MO: 'America/Chicago',
  MS: 'America/Chicago',
  ND: 'America/Chicago',
  NE: 'America/Chicago',
  OK: 'America/Chicago',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  WI: 'America/Chicago',
  // Eastern
  CT: 'America/New_York',
  DC: 'America/New_York',
  DE: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  IN: 'America/New_York',
  KY: 'America/New_York',
  MA: 'America/New_York',
  MD: 'America/New_York',
  ME: 'America/New_York',
  MI: 'America/New_York',
  NC: 'America/New_York',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NY: 'America/New_York',
  OH: 'America/New_York',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  VA: 'America/New_York',
  VT: 'America/New_York',
  WV: 'America/New_York',
  // Alaska / Hawaii / territories
  AK: 'America/Anchorage',
  HI: 'Pacific/Honolulu',
  PR: 'America/Puerto_Rico',
  VI: 'America/St_Thomas',
};

const COUNTRY_TO_TZ: Record<string, string> = {
  US: 'America/Los_Angeles', // safe-ish default; states above override
  CA: 'America/Toronto',
  MX: 'America/Mexico_City',
  GB: 'Europe/London',
  UK: 'Europe/London',
  IE: 'Europe/Dublin',
  AU: 'Australia/Sydney',
  NZ: 'Pacific/Auckland',
};

/** Common spelled-out state names mapped to their codes. */
const STATE_NAME_TO_CODE: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI',
  idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND',
  ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA',
  'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
};

function normalizeStateCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length === 2) return trimmed.toUpperCase();
  const mapped = STATE_NAME_TO_CODE[trimmed.toLowerCase()];
  return mapped ?? null;
}

export interface AddressBundle {
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
}

export interface ResolvedTimezone {
  timezone: string;
  source: 'state' | 'country';
  matched: string;
}

export function resolveTimezone(addr: AddressBundle | null | undefined): ResolvedTimezone | null {
  if (!addr) return null;
  // Prefer state if it's US (or unspecified country, which is the common case).
  const country = (addr.country ?? '').trim().toUpperCase();
  const isUsOrUnknown = !country || country === 'US' || country === 'USA' || country === 'UNITED STATES';
  if (isUsOrUnknown) {
    const code = normalizeStateCode(addr.state);
    if (code && US_STATE_TO_TZ[code]) {
      return { timezone: US_STATE_TO_TZ[code]!, source: 'state', matched: code };
    }
  }
  const cMapped = COUNTRY_TO_TZ[country];
  if (cMapped) return { timezone: cMapped, source: 'country', matched: country };
  return null;
}

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
  source: 'state' | 'country' | 'area_code';
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

/**
 * NANP area code (NPA) → IANA timezone. Built from grouped arrays for
 * auditability. Timezone-split states use each area code's ACTUAL zone (e.g.
 * 915/El Paso is Mountain even though Texas is majority Central; East-TN 423/865
 * is Eastern). A handful of area codes straddle a zone boundary internally —
 * those use the majority zone. Non-geographic ranges (toll-free 800/833/844/855/
 * 866/877/888, 900, etc.) are intentionally absent so they resolve to null.
 * Saskatchewan and Arizona use their no-DST zones.
 */
const NPA_TZ_GROUPS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['America/Los_Angeles', [
    // CA
    '209', '213', '279', '310', '323', '341', '350', '408', '415', '424', '442', '510', '530', '559',
    '562', '619', '626', '628', '650', '657', '661', '669', '707', '714', '747', '760', '805', '818',
    '820', '831', '837', '840', '858', '909', '916', '925', '949', '951',
    // WA
    '206', '253', '360', '425', '509', '564',
    // OR
    '458', '503', '541', '971',
    // NV
    '702', '725', '775',
  ]],
  ['America/Denver', [
    '303', '719', '720', '970', '983',        // CO
    '208', '986',                             // ID (majority Mountain)
    '406',                                    // MT
    '505', '575',                             // NM
    '385', '435', '801',                      // UT
    '307',                                    // WY
    '915',                                    // TX — El Paso (Mountain)
    '403', '587', '780', '825', '368',        // Canada AB
  ]],
  ['America/Phoenix', ['480', '520', '602', '623', '928']], // AZ (no DST)
  ['America/Chicago', [
    '205', '251', '256', '334', '938',                                  // AL
    '479', '501', '870',                                                // AR
    '319', '515', '563', '641', '712',                                  // IA
    '217', '224', '309', '312', '331', '447', '464', '618', '630', '708',
    '730', '773', '779', '815', '847', '872',                           // IL
    '316', '620', '785', '913',                                         // KS
    '270', '364',                                                       // KY (west)
    '225', '318', '337', '504', '985',                                  // LA
    '218', '320', '507', '612', '651', '763', '952',                    // MN
    '314', '417', '557', '573', '636', '660', '816', '975',             // MO
    '228', '601', '662', '769',                                         // MS
    '701',                                                              // ND
    '308', '402', '531',                                                // NE
    '405', '539', '580', '918',                                         // OK
    '605',                                                              // SD
    '615', '629', '731', '901', '931',                                  // TN (central/west)
    '210', '214', '254', '281', '325', '346', '361', '409', '430', '432',
    '469', '512', '682', '713', '726', '737', '806', '817', '830', '832',
    '903', '936', '940', '945', '956', '972', '979',                    // TX
    '262', '274', '414', '534', '608', '715', '920',                    // WI
    '219',                                                              // IN (NW / Chicago metro)
    '204', '431',                                                       // Canada MB
  ]],
  ['America/Regina', ['306', '639', '474']], // Saskatchewan (Central, no DST)
  ['America/New_York', [
    '203', '475', '860', '959',                                         // CT
    '202',                                                              // DC
    '302',                                                              // DE
    '305', '321', '352', '386', '407', '448', '561', '656', '689', '727',
    '754', '772', '786', '813', '850', '863', '904', '941', '954',      // FL
    '229', '404', '470', '478', '678', '706', '762', '770', '912',      // GA
    '260', '317', '463', '574', '765', '812', '930',                    // IN (Eastern)
    '502', '606', '859',                                               // KY (east)
    '339', '351', '413', '508', '617', '774', '781', '857', '978',      // MA
    '227', '240', '301', '410', '443', '667',                          // MD
    '207',                                                             // ME
    '231', '248', '269', '313', '517', '586', '616', '679', '734', '810',
    '906', '947', '989',                                               // MI
    '252', '336', '472', '704', '743', '828', '910', '919', '980', '984', // NC
    '603',                                                             // NH
    '201', '551', '609', '640', '732', '848', '856', '862', '908', '973', // NJ
    '212', '315', '332', '347', '363', '516', '518', '585', '607', '631',
    '646', '680', '716', '718', '838', '845', '914', '917', '929', '934', // NY
    '216', '220', '234', '283', '326', '330', '380', '419', '440', '513',
    '567', '614', '740', '937',                                        // OH
    '215', '223', '267', '272', '412', '445', '484', '570', '582', '610',
    '717', '724', '814', '835', '878',                                 // PA
    '401',                                                             // RI
    '803', '839', '843', '854', '864',                                 // SC
    '423', '865',                                                      // TN (east)
    '276', '434', '540', '571', '703', '757', '804', '826', '948',      // VA
    '802',                                                             // VT
    '304', '681',                                                      // WV
    '226', '249', '289', '343', '365', '382', '416', '437', '519', '548',
    '613', '647', '705', '742', '807', '905',                          // Canada ON
    '367', '418', '438', '450', '468', '514', '579', '581', '819', '873', // Canada QC
  ]],
  ['America/Halifax', ['902', '782', '506']],  // NS / PE / NB (Atlantic)
  ['America/St_Johns', ['709']],               // Newfoundland
  ['America/Anchorage', ['907']],              // AK
  ['Pacific/Honolulu', ['808']],               // HI
  ['America/Puerto_Rico', ['787', '939']],     // PR
  ['America/St_Thomas', ['340']],              // USVI
  ['Pacific/Guam', ['671']],                   // GU
  ['Pacific/Pago_Pago', ['684']],              // AS
  ['Pacific/Saipan', ['670']],                 // MP
];

const NPA_TO_TZ: Record<string, string> = {};
for (const [tz, npas] of NPA_TZ_GROUPS) {
  for (const npa of npas) NPA_TO_TZ[npa] = tz;
}

/** Resolve a bare 3-digit area code to its IANA timezone, or null if unknown. */
export function timezoneForAreaCode(npa: string): ResolvedTimezone | null {
  const tz = NPA_TO_TZ[npa];
  return tz ? { timezone: tz, source: 'area_code', matched: npa } : null;
}

/**
 * Infer the recipient's timezone from the DIALED NUMBER's area code — the
 * fallback when we have no address. Only NANP (+1) numbers are mapped; anything
 * else (or a non-geographic area code) returns null so the firewall keeps its
 * "unknown TZ" REVIEW path. Note: a ported cell can carry an out-of-region area
 * code, so an explicit address (resolveTimezone) is always preferred over this.
 */
export function timezoneForNumber(e164: string | null | undefined): ResolvedTimezone | null {
  if (!e164) return null;
  const m = /^\+1(\d{3})\d{7}$/.exec(e164);
  if (!m) return null;
  return timezoneForAreaCode(m[1]!);
}

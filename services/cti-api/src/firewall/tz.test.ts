import { describe, it, expect } from 'vitest';
import { NPA_TZ_GROUPS, resolveTimezone, stateForAreaCode, timezoneForAreaCode, timezoneForNumber } from './tz.js';

describe('timezoneForNumber (area-code fallback)', () => {
  it('maps San Diego / LA numbers to Pacific', () => {
    expect(timezoneForNumber('+16198641417')?.timezone).toBe('America/Los_Angeles'); // 619
    expect(timezoneForNumber('+18583585449')?.timezone).toBe('America/Los_Angeles'); // 858
    expect(timezoneForNumber('+12137151307')?.timezone).toBe('America/Los_Angeles'); // 213
    expect(timezoneForNumber('+13235249247')?.timezone).toBe('America/Los_Angeles'); // 323
  });

  it('handles timezone-split states by the area code, not the state majority', () => {
    // El Paso (915) is Mountain even though Texas is majority Central.
    expect(timezoneForNumber('+19155551234')?.timezone).toBe('America/Denver');
    // East Tennessee (865/423) is Eastern; middle/west TN (615/901) is Central.
    expect(timezoneForNumber('+18655551234')?.timezone).toBe('America/New_York');
    expect(timezoneForNumber('+16155551234')?.timezone).toBe('America/Chicago');
  });

  it('maps common zones correctly', () => {
    expect(timezoneForNumber('+12125550100')?.timezone).toBe('America/New_York'); // 212 NYC
    expect(timezoneForNumber('+13125550100')?.timezone).toBe('America/Chicago');  // 312 Chicago
    expect(timezoneForNumber('+16025550100')?.timezone).toBe('America/Phoenix');  // 602 AZ (no DST)
    expect(timezoneForNumber('+13035550100')?.timezone).toBe('America/Denver');   // 303 Denver
    expect(timezoneForNumber('+19075550100')?.timezone).toBe('America/Anchorage'); // 907 AK
    expect(timezoneForNumber('+18085550100')?.timezone).toBe('Pacific/Honolulu'); // 808 HI
  });

  it('reports the area code as the match source', () => {
    const r = timezoneForNumber('+16195550100');
    expect(r).toEqual({ timezone: 'America/Los_Angeles', source: 'area_code', matched: '619' });
  });

  it('returns null for toll-free / non-geographic and non-NANP numbers', () => {
    expect(timezoneForNumber('+18005550100')).toBeNull(); // 800 toll-free
    expect(timezoneForNumber('+18665550100')).toBeNull(); // 866 toll-free
    expect(timezoneForNumber('+442071838750')).toBeNull(); // UK, non-NANP
    expect(timezoneForNumber('')).toBeNull();
    expect(timezoneForNumber(null)).toBeNull();
    expect(timezoneForNumber('not-a-number')).toBeNull();
  });

  it('timezoneForAreaCode works on a bare NPA', () => {
    expect(timezoneForAreaCode('619')?.timezone).toBe('America/Los_Angeles');
    expect(timezoneForAreaCode('999')).toBeNull();
  });

  it('address-based resolveTimezone still takes priority path (unchanged)', () => {
    expect(resolveTimezone({ state: 'CA' })?.timezone).toBe('America/Los_Angeles');
    expect(resolveTimezone({ state: 'New York' })?.timezone).toBe('America/New_York');
    expect(resolveTimezone({ country: 'GB' })?.timezone).toBe('Europe/London');
    expect(resolveTimezone(null)).toBeNull();
  });
});

/**
 * stateForAreaCode — the SAME area codes already grouped in NPA_TZ_GROUPS
 * above, regrouped by state instead of timezone (weekend-calling brief:
 * "add an area-code→state map for the SAME area codes already in the tz
 * map — do not invent a new data source").
 */
describe('stateForAreaCode', () => {
  it('resolves single-state area codes', () => {
    expect(stateForAreaCode('619')).toBe('CA'); // San Diego
    expect(stateForAreaCode('212')).toBe('NY'); // NYC
    expect(stateForAreaCode('305')).toBe('FL'); // Miami
    expect(stateForAreaCode('602')).toBe('AZ'); // Phoenix
  });

  it('resolves a state whose area codes are split across timezone groups (TX: 915 Mountain + Central)', () => {
    expect(stateForAreaCode('915')).toBe('TX'); // El Paso — Mountain
    expect(stateForAreaCode('214')).toBe('TX'); // Dallas — Central
  });

  it('resolves a state whose area codes are split across timezone groups (IN: 219 Central + Eastern)', () => {
    expect(stateForAreaCode('219')).toBe('IN'); // NW Indiana — Central
    expect(stateForAreaCode('317')).toBe('IN'); // Indianapolis — Eastern
  });

  it('returns null for a non-US (Canadian) NANP area code', () => {
    expect(stateForAreaCode('416')).toBeNull(); // Toronto, ON
  });

  it('returns null for an unmapped/toll-free area code', () => {
    expect(stateForAreaCode('800')).toBeNull();
    expect(stateForAreaCode('999')).toBeNull();
  });
});

/**
 * FIX-6 (weekend-calling fix wave): `stateForAreaCode` is supposed to cover
 * the SAME area codes as `NPA_TZ_GROUPS` (its own docstring: "do not invent a
 * new data source"), minus the non-US entries (Canada + the Pacific
 * territories that don't carry a 2-letter US-state code: Guam, American
 * Samoa, the Northern Mariana Islands). Nothing enforced that parity — a tz
 * map addition for a new US area code could silently ship without its state
 * counterpart, and every Sunday call to that area code would then fall to
 * the conservative UNKNOWN_STATE_RULE instead of its real state's rule. This
 * test fails CI the moment the two maps diverge for a US NPA.
 */
describe('NPA_TZ_GROUPS ↔ stateForAreaCode parity', () => {
  // Every non-US-state NPA in NPA_TZ_GROUPS, by its own inline comments:
  // Canada (AB/MB/SK/ON/QC/NS/PE/NB/Newfoundland) + Guam/American
  // Samoa/Northern Mariana Islands (US territories with no 2-letter state
  // code). Puerto Rico (787/939) and the USVI (340) are DELIBERATELY not
  // here — they DO have a stateForAreaCode entry ('PR'/'VI').
  const NON_US_NPAS = new Set([
    // Canada AB (America/Denver group)
    '403', '587', '780', '825', '368',
    // Canada MB (America/Chicago group)
    '204', '431',
    // Saskatchewan (its own America/Regina group)
    '306', '639', '474',
    // Canada ON (America/New_York group)
    '226', '249', '289', '343', '365', '382', '416', '437', '519', '548',
    '613', '647', '705', '742', '807', '905',
    // Canada QC (America/New_York group)
    '367', '418', '438', '450', '468', '514', '579', '581', '819', '873',
    // Canada Atlantic (its own America/Halifax group: NS/PE/NB)
    '902', '782', '506',
    // Newfoundland (its own America/St_Johns group)
    '709',
    // Non-state US territories
    '671', // Guam
    '684', // American Samoa
    '670', // Northern Mariana Islands
  ]);

  const allNpas = NPA_TZ_GROUPS.flatMap(([, npas]) => npas);

  it('sanity: NPA_TZ_GROUPS is non-trivial and includes known Canada/US examples', () => {
    expect(allNpas.length).toBeGreaterThan(300);
    expect(allNpas).toContain('619'); // US (CA)
    expect(allNpas).toContain('416'); // Canada (ON)
  });

  it('every US NPA in NPA_TZ_GROUPS (excluding Canada/territory NPAs) has a stateForAreaCode mapping', () => {
    const usNpas = allNpas.filter((npa) => !NON_US_NPAS.has(npa));
    expect(usNpas.length).toBeGreaterThan(300);
    // Named individually (not just a length/boolean check) so a future
    // divergence names the exact NPA that needs a state entry.
    const unmapped = usNpas.filter((npa) => stateForAreaCode(npa) === null);
    expect(unmapped).toEqual([]);
  });

  it('every excluded NPA is one stateForAreaCode genuinely does not map (guards the exclusion list itself)', () => {
    for (const npa of NON_US_NPAS) {
      if (allNpas.includes(npa)) {
        expect(stateForAreaCode(npa)).toBeNull();
      }
    }
  });
});

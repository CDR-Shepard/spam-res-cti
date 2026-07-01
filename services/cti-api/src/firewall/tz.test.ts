import { describe, it, expect } from 'vitest';
import { resolveTimezone, timezoneForAreaCode, timezoneForNumber } from './tz.js';

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

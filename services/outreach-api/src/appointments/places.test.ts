import { describe, expect, it } from 'vitest';
import type { BookingRouting } from '@cti/contracts';
import { DEFAULT_BOOKING_ROUTING } from '../settings.js';
import { countyKey, regionFor, usableAddress } from './places.js';

describe('usableAddress', () => {
  it('collapses runs of spaces and trims', () => {
    expect(usableAddress('  18872 MacArthur Blvd #220,   Irvine ')).toBe('18872 MacArthur Blvd #220, Irvine');
  });

  it('a full address comes back unchanged', () => {
    expect(usableAddress('1234 Oak St, Riverside, CA 92501')).toBe('1234 Oak St, Riverside, CA 92501');
  });

  it('a unit letter after the house number still reads as a street address', () => {
    expect(usableAddress('77B Palm Ave, Oceanside')).toBe('77B Palm Ave, Oceanside');
  });

  // Final review C1: a directional before the street name, or a numbered street, is still a street address.
  it.each([
    ['a one-letter directional', '1234 N Main St, Santa Ana, CA 92701'],
    ['a directional on a city street', '4500 W Pico Blvd, Los Angeles, CA 90019'],
    ['a numbered street', '456 3rd Ave, Chula Vista, CA 91910'],
    ['a directional with a dot', '100 N. Tustin Ave, Orange, CA 92867'],
    ['a directional and a numbered street', '1200 E 7th St, Long Beach'],
    ['a spelled-out directional', '210 South Fake Elm Dr, Tustin, CA 92780'],
    ['a lower-case directional and numbered street', '88 w 21st st, Upland, CA 91786'],
    ['a hyphenated house number', '12-4 Fake Oak Ln, Irvine, CA 92612'],
    ['a street name that starts with "Zoom"', '3300 Calle Zoomar, San Clemente, CA 92673'],
  ])('is drivable: %s', (_label, location) => {
    expect(usableAddress(location)).toBe(location);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only spaces', '        '],
    ['Zoom', 'Zoom'],
    ['Phone call', 'Phone call'],
    ['Office', 'Office'],
    ['TBD', 'TBD'],
    ['a phone number', '555-123-4567'],
    ['a phone number with spaces', '555 123 4567'],
    ['a Zoom link', 'https://zoom.us/j/123'],
    ['a Zoom link with no scheme and a street-like tail', 'us02web.zoom.us/j/123 Main'],
    ['a Zoom meeting that names a street', 'Zoom with seller, 1234 Main St'],
    ['a phone number with a directional-like letter', '555 N 123 4567'],
    ['a www link that has a street-like tail', 'www.example.com/123 Main'],
    ['a Teams link', 'Join: 123 meetings at teams.microsoft.com'],
    ['a Google Meet link', 'meet.google.com 123 abc'],
    ['a Webex room', '1234 Main Street webex'],
    ['a street with no house number', 'Oak Street, Irvine'],
    ['text over 200 characters', `123 ${'Long '.repeat(50)}St`],
  ])('is not drivable: %s', (_label, location) => {
    expect(usableAddress(location)).toBeNull();
  });

  it('exactly 8 characters is the shortest that can pass, and 200 the longest', () => {
    expect(usableAddress('1 Oak St')).toBe('1 Oak St');
    expect(usableAddress('1 Ab St')).toBeNull();
    const longest = `123 ${'a'.repeat(196)}`;
    expect(longest).toHaveLength(200);
    expect(usableAddress(longest)).toBe(longest);
    expect(usableAddress(`${longest}a`)).toBeNull();
  });
});

describe('countyKey', () => {
  it.each([
    ['San Diego County', 'san diego'],
    ['San Diego', 'san diego'],
    ['  los   angeles COUNTY ', 'los angeles'],
    ['ORANGE', 'orange'],
  ])('%j gives %j', (name, key) => {
    expect(countyKey(name)).toBe(key);
  });
});

describe('regionFor', () => {
  const geo = (county: string | null, state: string | null) => ({ point: { lat: 33.7, lng: -117.9 }, county, state });
  const LA = DEFAULT_BOOKING_ROUTING.regions[0]!;
  const SD = DEFAULT_BOOKING_ROUTING.regions[1]!;

  it.each([
    ['Los Angeles', 'CA'],
    ['Orange', 'CA'],
    ['Riverside', 'CA'],
    ['SAN BERNARDINO', 'CA'],
  ])('%s, %s is the LA region', (county, state) => {
    expect(regionFor(geo(county, state), DEFAULT_BOOKING_ROUTING)).toEqual(LA);
  });

  it('San Diego is the SD region', () => {
    expect(regionFor(geo('San Diego', 'CA'), DEFAULT_BOOKING_ROUTING)).toEqual(SD);
  });

  it.each([
    ['a county no region covers', geo('Imperial', 'CA')],
    ['a county name in another state', geo('Orange', 'NV')],
    ['no county', geo(null, 'CA')],
    ['no state', geo('Orange', null)],
  ])('%s is in no region', (_label, g) => {
    expect(regionFor(g, DEFAULT_BOOKING_ROUTING)).toBeNull();
  });

  it('matches by countyKey on both sides, so a configured "Orange County" and a lower-case state still match', () => {
    const routing: BookingRouting = { ...DEFAULT_BOOKING_ROUTING, regions: [{ ...LA, counties: ['Orange County'] }, SD] };
    expect(regionFor(geo('Orange', 'ca'), routing)?.key).toBe('LA');
  });

  it('an empty-reps region is still the region for its counties (routing then offers nothing)', () => {
    const routing: BookingRouting = { ...DEFAULT_BOOKING_ROUTING, regions: [{ ...LA, reps: [] }, SD] };
    expect(regionFor(geo('Orange', 'CA'), routing)?.reps).toEqual([]);
  });
});
